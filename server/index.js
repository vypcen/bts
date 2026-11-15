// журнал работы и метрики подключаются первыми: остальные модули уже при загрузке пишут в журнал и ходят в базу
const log = require("./log");
log.install();
const metrics = require("./metrics");
const jobs = require("./jobs");
const path = require("path");
const express = require("express");
const compression = require("compression");
const { pool, tx } = require("./db");
const { migrate, waitForDb } = require("./migrate");
const auth = require("./auth");
const access = require("./access");
const live = require("./live");
const attachments = require("./attachments");
const autotests = require("./autotests");
const folders = require("./folders");
const caseio = require("./caseio");
const checklist = require("./checklist");
const llm = require("./llm");
const sso = require("./sso");
const seats = require("./seats");
const secrets = require("./secrets");
const events = require("./events");
const plans = require("./plans");
const webhooks = require("./webhooks");
const trackers = require("./trackers");
const ci = require("./ci");
const projectio = require("./projectio");
const state = require("./state");
const lists = require("./lists");
const casemodel = require("./casemodel");
const audit = require("./audit");
const trash = require("./trash");
const { wrap, str, tooLong, num, HttpError } = require("./util");
const { Limiter, MIN } = require("./limits");
const version = require("./version");
const license = require("./license");
const security = require("./security");
const shared = require("./shared");
const review = require("./review");
const datasets = require("./datasets");

const PORT = Number(process.env.PORT || 3000);
// Статус готовности кейса. Результат прохождения хранится в прогонах (server/runs.js)
const STATUSES = ["draft", "review", "ready", "deprecated"];
const PRIORITIES = ["critical", "high", "medium", "low"];
const KEY_RE = /^[A-Z]{2,6}$/;
// closed — зарегистрироваться самому нельзя, учётные записи создаёт админ («Пользователи» → «Новый пользователь»)
const REGISTRATION = process.env.REGISTRATION === "closed" ? "closed" : "open";
const RESERVED_ADMIN = (process.env.ADMIN_LOGIN || "").trim().toLowerCase();
// Даже если в данные попадёт скрипт, браузер выполнит только код самого приложения
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
// Токен может только отправлять результаты автотестов: создать запуск, прислать результаты и файлы, завершить запуск.
// Читать и удалять с ним нельзя ничего — даже утёкший токен не откроет данные и не сотрёт историю
const TOKEN_ROUTES = [
  ["POST", /^\/projects\/[^/]+\/autoruns$/],
  ["POST", /^\/projects\/[^/]+\/autoruns\/\d+\/results$/],
  ["POST", /^\/projects\/[^/]+\/autoruns\/\d+\/allure$/],
  ["POST", /^\/projects\/[^/]+\/autoruns\/\d+\/results\/\d+\/attachments$/],
  ["PATCH", /^\/projects\/[^/]+\/autoruns\/\d+$/],
];
const { broadcast } = live;

const app = express();
app.disable("x-powered-by");
// номер запроса, метрики и журнал запросов (server/metrics.js)
app.use(metrics.middleware());
// Версия API в пути: /api/v1/... — то же, что /api/... (текущая и единственная версия). Интеграциям лучше
// использовать /api/v1: при несовместимых изменениях появится /api/v2, а v1 продолжит работать
app.use((req, _res, next) => {
  if (req.url.startsWith("/api/v1/") || req.url === "/api/v1") req.url = "/api" + req.url.slice(7);
  next();
});
// Сжатие ответов: состояние большого проекта в JSON сжимается в 10–15 раз. Поток живых обновлений не сжимаем — он должен
// приходить сразу, а не копиться в буфере
app.use(compression({ filter: (req, res) => !req.path.startsWith("/api/events") && compression.filter(req, res) }));
// За обратным прокси (Cloudflare Tunnel, Caddy, nginx) нужно доверять X-Forwarded-*, чтобы cookie получали флаг Secure
// TRUST_PROXY=false — никому (приложение открыто напрямую: иначе любой подделает свой IP и обойдёт лимиты входа)
const TRUST = (process.env.TRUST_PROXY || "").trim();
app.set("trust proxy", !TRUST ? "loopback, linklocal, uniquelocal" : TRUST === "false" ? false : TRUST === "true" ? true : /^\d+$/.test(TRUST) ? Number(TRUST) : TRUST);

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": CSP,
  });
  // браузер больше не откроет сайт по HTTP и не даст подменить соединение. Только для этого адреса, без поддоменов
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
  next();
});

// Сначала — кто пришёл. Тело запроса разбирается после: без входа нельзя заставить сервер разбирать мегабайты JSON
app.use(auth.loadUser);
// журнал аудита для изменяющих запросов к пользователям, интеграциям, токенам, удалениям (server/audit.js)
app.use(audit.middleware());
// Пароль выдан админом или истёк, либо политика требует 2FA, а она не включена: пока пользователь этого не сделал,
// доступны только вход/выход, смена пароля, настройка 2FA и справка. Токены CI не затрагиваются
const PENDING_OK = /^\/api\/(auth\/(me|logout|password|2fa(\/.*)?|sessions(\/.*)?)|help(\/.*)?)$/;
app.use((req, res, next) => {
  const p = req.user?.pending;
  if (!p || req.viaToken || !req.path.startsWith("/api/") || PENDING_OK.test(req.path)) return next();
  res.status(403).json({ error: security.PENDING_TEXT[p], code: p === "password" ? "password_change_required" : "2fa_setup_required" });
});
// Результаты автотестов приходят пачками вместе со стектрейсами — им нужен лимит побольше
const bigJson = express.json({ limit: "10mb" });
app.use("/api/projects/:key/autoruns", (req, res, next) => (req.user ? bigJson(req, res, next) : next()));
// импорт тест-кейсов — CSV на тысячи строк
const importJson = express.json({ limit: "5mb" });
app.use("/api/projects/:key/cases/import", (req, res, next) => (req.user ? importJson(req, res, next) : next()));
// импорт проекта целиком (с вложениями в base64) и миграция из других TMS
const projectJson = express.json({ limit: `${Number(process.env.IMPORT_MAX_MB || 200)}mb` });
app.use("/api/projects-import", (req, res, next) => (req.user ? projectJson(req, res, next) : next()));
app.use(express.json({ limit: "200kb" }));

// Защита от CSRF: изменяющие запросы принимаются только как JSON.
// Загрузка файла идёт «сырым» телом, поэтому требует заголовок X-Upload: чужой сайт не может
// прислать его без CORS-разрешения, которого сервер не даёт.
app.use("/api", (req, res, next) => {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && !req.is("application/json")) {
    const upload = req.method === "POST" && req.path.endsWith("/attachments") && req.get("x-upload") === "1";
    if (!upload) return res.status(415).json({ error: "Ожидается Content-Type: application/json" });
  }
  next();
});
// Токен (Authorization: Bearer) — со своими правами (scopes):
//   results — только отправка результатов автотестов (TOKEN_ROUTES), read — любые GET, write — изменения в проектах.
// Права владельца проверяются как обычно: write-токен наблюдателя ничего не изменит. Управление пользователями,
// токенами и входом по токену недоступно никогда. Лимит — TOKEN_RATE_LIMIT запросов в минуту на токен
const tokenLimit = new Limiter(Number(process.env.TOKEN_RATE_LIMIT || 600), MIN);
const NEVER_BY_TOKEN = /^\/(admin|tokens|auth|events)(\/|$)/;
app.use("/api", (req, res, next) => {
  if (!req.viaToken) return next();
  if (!tokenLimit.take(String(req.tokenId))) return res.status(429).json({ error: "Слишком много запросов с этим токеном. Подождите минуту" });
  const scopes = req.tokenScopes || ["results"];
  const isResults = TOKEN_ROUTES.some(([method, re]) => method === req.method && re.test(req.path));
  const ok = !NEVER_BY_TOKEN.test(req.path) && (
    (isResults && (scopes.includes("results") || scopes.includes("write")))
    || (req.method === "GET" && scopes.includes("read"))
    || (req.method !== "GET" && scopes.includes("write"))
  );
  if (!ok) {
    return res.status(403).json({
      error: scopes.length === 1 && scopes[0] === "results"
        ? "Токен подходит только для отправки результатов автотестов"
        : `У токена нет права на этот запрос (права токена: ${scopes.join(", ")})`,
    });
  }
  next();
});

app.get("/api/events", auth.requireUser, live.events);

// ---------- авторизация ----------
const me = (u) => ({ login: u.login, name: u.name, role: u.role, provider: u.auth_provider || "local", version: version.VERSION, pending: u.pending || null, passwordPolicy: security.policyText() });
// Администратор видит предупреждения о лицензии (истекает, истекла, ключ не принят) в шапке
const { limits, TOO_MANY } = auth;

// Политика обработки персональных данных (152-ФЗ): ссылка на странице входа, согласие при регистрации
const PRIVACY_URL = /^https?:\/\//.test(process.env.PRIVACY_POLICY_URL || "") ? process.env.PRIVACY_POLICY_URL : "";

// Что пользователь обязан сделать до начала работы (server/security.js)
async function pendingOf(userId) {
  const { rows } = await pool.query(
    "SELECT role, auth_provider, must_change_password, password_changed_at, totp_secret IS NOT NULL AS totp_enabled FROM users WHERE id=$1", [userId]
  );
  return rows[0] ? security.pendingAction(rows[0]) : null;
}

// Без входа — ещё и что показывать на странице входа: нужен ли код установки, открыта ли регистрация
app.get("/api/auth/me", wrap(async (req, res) => {
  if (req.user) {
    const { rows } = await pool.query("SELECT auth_provider FROM users WHERE id=$1", [req.user.id]);
    const user = me({ ...req.user, auth_provider: rows[0]?.auth_provider });
    user.twoFactor = !!req.user.totpEnabled;
    if (req.user.role === "admin") {
      const l = await license.current();
      user.licenseNotice = l.notice;
    }
    return res.json({ user });
  }
  res.json({ user: null, setup: await auth.needsSetup(), registration: sso.cfg.localLogin ? REGISTRATION : "closed", providers: sso.providers(), passwordPolicy: security.policyText(), privacyPolicyUrl: PRIVACY_URL || null });
}));

app.post("/api/auth/register", wrap(async (req, res) => {
  const login = str(req.body.login, 64).toLowerCase();
  const name = str(req.body.name, 100);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const bad = auth.checkLogin(login) || (!name && "Укажите имя") || auth.checkPassword(password, { login, name });
  if (bad) return res.status(400).json({ error: bad });
  // лимит до проверки кода установки — иначе его можно подбирать
  if (!limits.registerIp.take(req.ip) || !limits.registerAll.take("all")) return res.status(429).json({ error: TOO_MANY });
  const setup = await auth.needsSetup();
  if (setup) await auth.prepareSetup(); // база могла опустеть после запуска сервера
  if (setup && !auth.checkSetupCode(req.body.setupCode)) {
    return res.status(403).json({ error: "Неверный код установки. Он напечатан в логах сервера: docker compose logs app" });
  }
  if (!setup && (REGISTRATION === "closed" || !sso.cfg.localLogin)) return res.status(403).json({ error: "Регистрация закрыта. Попросите администратора создать вам учётную запись" });
  if (!setup) {
    const noSeat = await seats.check(pool, "developer");
    if (noSeat) return res.status(403).json({ error: noSeat });
  }
  // логин из ADMIN_LOGIN станет админом при перезапуске — занять его регистрацией нельзя
  if (!setup && login === RESERVED_ADMIN) return res.status(403).json({ error: "Этот логин зарезервирован. Выберите другой" });
  // 152-ФЗ: если задана политика обработки персональных данных, без согласия зарегистрироваться нельзя
  if (PRIVACY_URL && req.body.consent !== true) return res.status(400).json({ error: "Подтвердите согласие на обработку персональных данных" });
  const hash = await auth.hashPassword(password);
  // новичок только смотрит и не видит ни одного проекта, пока админ не выдаст доступ;
  // первый пользователь в пустой базе становится админом
  const { rows } = await pool.query(
    `INSERT INTO users(login, name, password_hash, role, pd_consent_at)
     VALUES ($1,$2,$3, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'developer' ELSE 'admin' END, CASE WHEN $4 THEN now() END)
     ON CONFLICT (login) DO NOTHING RETURNING id, role`,
    [login, name, hash, req.body.consent === true]
  );
  if (!rows[0]) return res.status(409).json({ error: "Логин уже занят. Выберите другой или войдите" });
  if (rows[0].role === "admin") auth.setupDone();
  await auth.createSession(res, req, rows[0].id);
  const pending = await pendingOf(rows[0].id);
  audit.log(req, "auth.register", { actor: { id: rows[0].id, login }, project: null, target: login, details: { role: rows[0].role } });
  broadcast("users");
  res.status(201).json({ user: { login, name, role: rows[0].role, pending } });
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const login = str(req.body.login, 64).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const key = `${req.ip}|${login}`;
  if (limits.loginIpLogin.blocked(key) || limits.loginIp.blocked(req.ip) || limits.loginAny.blocked(login)) {
    return res.status(429).json({ error: TOO_MANY });
  }
  const { rows } = await pool.query("SELECT id, login, name, role, blocked, password_hash, auth_provider FROM users WHERE login=$1", [login]);
  let u = rows[0];
  // локальный пароль; при LOCAL_LOGIN=off — только у аварийного администратора из ADMIN_LOGIN
  const localAllowed = sso.cfg.localLogin || (u && u.login === RESERVED_ADMIN);
  let check = u && localAllowed ? await auth.verifyPassword(password, u.password_hash) : { ok: false };
  if (!check.ok) {
    // каталог LDAP/AD: пользователь создаётся при первом входе
    const dir = await sso.ldapLogin(login, password);
    if (dir) {
      u = { ...dir, blocked: false, auth_provider: "ldap" };
      check = { ok: true, legacy: false };
    }
  }
  if (!check.ok) {
    audit.log(req, "auth.login_failed", { actor: { id: u?.id, login }, project: null, target: login });
    limits.loginIpLogin.hit(key);
    limits.loginIp.hit(req.ip);
    limits.loginAny.hit(login);
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  limits.loginIpLogin.clear(key);
  if (u.blocked) return res.status(403).json({ error: "Учётная запись заблокирована. Обратитесь к администратору" });
  // второй фактор: код из приложения-аутентификатора или резервный код. Без кода — просим его, попыткой это не считается
  const totp = (await pool.query("SELECT totp_secret IS NOT NULL AS on FROM users WHERE id=$1", [u.id])).rows[0]?.on;
  if (totp) {
    if (!req.body.code) return res.status(401).json({ error: "Введите код из приложения-аутентификатора", twoFactor: true });
    const second = await security.verifySecondFactor(u.id, req.body.code);
    if (!second.ok) {
      audit.log(req, "auth.2fa_failed", { actor: u, project: null, target: u.login });
      limits.loginIpLogin.hit(key);
      limits.loginIp.hit(req.ip);
      limits.loginAny.hit(login);
      return res.status(401).json({ error: "Код не подошёл. Введите новый код из приложения или резервный код", twoFactor: true });
    }
    if (second.method === "recovery") audit.log(req, "auth.recovery_used", { actor: u, project: null, target: u.login, details: { left: second.recoveryLeft } });
  }
  if (check.legacy) {
    // пароль из прошлой версии — сразу перехэшируем в bcrypt
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await auth.hashPassword(password), u.id]);
  }
  await pool.query("UPDATE users SET last_login_at=now() WHERE id=$1", [u.id]);
  await auth.createSession(res, req, u.id);
  audit.log(req, "auth.login", { actor: u, project: null, target: u.login, details: { provider: u.auth_provider || "local" } });
  res.json({ user: me({ ...u, pending: await pendingOf(u.id), twoFactor: !!totp }) });
}));

// OpenID Connect и Kerberos (переходы браузера, GET)
app.use("/api/auth", sso.router);
// двухфакторная аутентификация и активные сессии (server/account.js)
app.use("/api/auth", require("./account"));

app.post("/api/auth/logout", wrap(async (req, res) => {
  if (req.user) audit.log(req, "auth.logout", { project: null, target: req.user.login });
  await auth.destroySession(req, res);
  res.json({ ok: true });
}));

// Смена своего пароля. Остальные сессии закрываются: если пароль утёк, вошедший с ним теряет доступ
app.post("/api/auth/password", auth.requireUser, wrap(async (req, res) => {
  const current = typeof req.body.current === "string" ? req.body.current : "";
  const bad = auth.checkPassword(req.body.password, { login: req.user.login, name: req.user.name });
  if (bad) return res.status(400).json({ error: bad });
  if (!limits.password.take(String(req.user.id))) return res.status(429).json({ error: TOO_MANY });
  const { rows } = await pool.query("SELECT password_hash, auth_provider FROM users WHERE id=$1", [req.user.id]);
  if (rows[0].auth_provider !== "local") return res.status(409).json({ error: "Пароль хранится в корпоративном каталоге (LDAP/SSO) и меняется там" });
  if (!(await auth.verifyPassword(current, rows[0].password_hash)).ok) return res.status(403).json({ error: "Текущий пароль указан неверно" });
  if (current === req.body.password) return res.status(400).json({ error: "Новый пароль должен отличаться от текущего" });
  if (await security.reusedPassword(pool, req.user.id, req.body.password, auth.verifyPassword)) {
    return res.status(400).json({ error: `Этот пароль уже использовался. Придумайте новый (нельзя повторять последние ${security.cfg.history})` });
  }
  await security.setPassword(pool, req.user.id, await auth.hashPassword(req.body.password));
  await auth.destroyOtherSessions(req, req.user.id);
  audit.log(req, "auth.password", { project: null, target: req.user.login });
  res.json({ ok: true });
}));

// ---------- данные ----------
// Общее состояние (проекты со сводкой, пользователи, планы). Данные проекта — GET /api/projects/:key/state (server/state.js)
app.get("/api/state", auth.requireUser, wrap(async (req, res) => {
  res.json(await state.meta(req.user));
}));

app.post("/api/projects", auth.requireUser, access.requireWriter, wrap(async (req, res) => {
  const key = str(req.body.key, 10).toUpperCase();
  const name = str(req.body.name, 200);
  const desc = str(req.body.desc, 2000);
  if (!name) return res.status(400).json({ error: "Укажите название проекта" });
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "Ключ: от 2 до 6 латинских букв" });
  const created = await tx(async (db) => {
    const { rows } = await db.query(
      "INSERT INTO projects(key, name, description, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING RETURNING key",
      [key, name, desc, req.user.id]
    );
    // создатель сразу становится участником, остальных добавляет админ
    if (rows[0]) await db.query("INSERT INTO project_members(project_key, user_id) VALUES ($1,$2)", [key, req.user.id]);
    return Boolean(rows[0]);
  });
  if (!created) {
    const { rows } = await pool.query("SELECT deleted_at FROM projects WHERE key=$1", [key]);
    return res.status(409).json({ error: rows[0]?.deleted_at ? `Ключ ${key} занят проектом в корзине: восстановите его или удалите навсегда` : `Ключ ${key} уже занят другим проектом` });
  }
  broadcast("projects");
  res.status(201).json({ id: key });
}));

// Новый проект из файла: экспорт TestBall или выгрузка другой TMS (TestRail, TestLink, Qase)
app.use("/api/projects-import", auth.requireUser, access.requireWriter, projectio.importRouter);

// Всё внутри проекта: доступ только участникам и админам, изменения — только тестировщикам и админам (кроме комментариев)
app.use("/api/projects/:key", auth.requireUser, access.project, live.inProject);
app.use("/api/projects/:key", state.router, lists.router, trash.router, casemodel.router, require("./reports").router);
app.use("/api/search", auth.requireUser, lists.searchRouter);
// Настройки интеграций содержат адреса и заголовки внутренних систем — их видят только те, кто может менять настройки
app.use(["/api/projects/:key/webhooks", "/api/projects/:key/tracker"], (req, res, next) =>
  access.can(req.projectRole, "settings") ? next() : res.status(403).json({ error: access.READ_ONLY }));

app.patch("/api/projects/:key", auth.requireUser, wrap(async (req, res) => {
  const name = str(req.body.name, 200);
  const desc = str(req.body.desc, 2000);
  if (!name) return res.status(400).json({ error: "Укажите название проекта" });
  const r = await pool.query("UPDATE projects SET name=$1, description=$2 WHERE key=$3", [name, desc, req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: "Проект не найден" });
  broadcast("projects");
  res.json({ ok: true });
}));

// Проект — в корзину (только админ, с подтверждением ключом). Навсегда — из корзины в «Пользователи» → «Корзина»
app.delete("/api/projects/:key", auth.requireUser, wrap(trash.deleteProject));

// body — присланное (при правке — поверх текущего кейса, prevSteps — его шаги).
// Шаги принимаются структурой (stepList: [{action, expected, data}]) или текстом по строке на шаг (steps) — так
// работают CSV, старые клиенты API и языковая модель; из текста ожидаемые результаты шагов сохраняются, если действия те же
// Логины участников проекта (и админов) — для полей «пользователь»
async function memberLogins(key) {
  const { rows } = await pool.query(
    "SELECT u.login FROM users u WHERE u.role='admin' OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.project_key=$1)", [key]);
  return new Set(rows.map((r) => r.login));
}

function readCase(body, prevSteps = [], stepListSent = body.stepList !== undefined) {
  const c = {
    kind: body.kind === undefined ? "case" : str(body.kind, 20),
    title: str(body.title, 500),
    priority: str(body.priority, 20),
    status: str(body.status, 20),
    pre: str(body.pre),
    steps: str(body.steps),
    expected: str(body.expected),
    stepList: [],
    tags: casemodel.normalizeTags(body.tags) || [],
  };
  if (c.kind === "case") {
    c.stepList = stepListSent ? casemodel.normalizeSteps(body.stepList) : casemodel.stepsFromText(c.steps, prevSteps);
    if (!c.stepList) return { error: "stepList: ожидается список шагов [{action, expected, data}]" };
    c.steps = casemodel.stepsText(c.stepList);
  }
  if (!checklist.KINDS.includes(c.kind)) return { error: "Неизвестный вид: case или checklist" };
  if (!c.title) return { error: c.kind === "checklist" ? "Укажите название чек-листа" : "Укажите название тест-кейса" };
  if (tooLong(body.title, 500)) return { error: tooLong(body.title, 500) };
  if (!PRIORITIES.includes(c.priority)) return { error: "Неизвестный приоритет" };
  if (!STATUSES.includes(c.status)) return { error: "Неизвестный статус" };
  // у чек-листа вместо шагов — пункты, предусловий и ожидаемого результата нет
  if (c.kind === "checklist") {
    const { steps, error } = checklist.check(c.steps);
    if (error) return { error };
    Object.assign(c, { steps, pre: "", expected: "" });
  }
  return { c };
}

app.post("/api/projects/:key/cases", auth.requireUser, wrap(async (req, res) => {
  const { c, error } = readCase(req.body);
  if (error) return res.status(400).json({ error });
  const badRef = await shared.checkRefs(req.params.key, c.stepList);
  if (badRef) return res.status(400).json({ error: badRef });
  const gate = await review.gateStatus(req, null, c);
  if (gate.error) return res.status(409).json({ error: gate.error });
  const prm = await datasets.readCaseParams(req.params.key, req.body, c.kind);
  if (prm.error) return res.status(400).json({ error: prm.error });
  const cf = await casemodel.readFields(pool, req.params.key, "case", req.body.fields, {}, { members: await memberLogins(req.params.key) });
  if (cf.error) return res.status(400).json({ error: cf.error });
  const folder = await folders.folderId(pool, req.params.key, req.body.folder);
  if (folder === undefined) return res.status(400).json({ error: "Папка не найдена" });
  const n = await tx(async (db) => {
    // атомарно берём следующий номер — два одновременных создания не получат один ID
    const r = await db.query("UPDATE projects SET seq=seq+1 WHERE key=$1 RETURNING seq", [req.params.key]);
    if (!r.rows[0]) return null;
    const next = r.rows[0].seq;
    await db.query(
      `INSERT INTO test_cases(project_key, num, kind, folder_id, title, priority, status, preconditions, steps, expected, created_by, updated_by,
         step_list, tags, fields, params, dataset_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15,$16)`,
      [req.params.key, next, c.kind, folder, c.title, c.priority, c.status, c.pre, c.steps, c.expected, req.user.id,
        JSON.stringify(c.stepList), c.tags, cf.fields, prm.params ? JSON.stringify(prm.params) : null, prm.datasetId ?? null]
    );
    return next;
  });
  if (n === null) return res.status(404).json({ error: "Проект не найден" });
  broadcast("cases");
  events.emit(req.params.key, "case.created", { case: await events.snap.testCase(req.params.key, n) }, req.user);
  res.status(201).json({ id: `${req.params.key}-${n}`, num: n });
}));

app.patch("/api/projects/:key/cases/:num", auth.requireUser, wrap(async (req, res) => {
  const n = num(req.params.num);
  // частичное обновление: можно прислать только status
  const { rows } = await pool.query(
    `SELECT id, kind, folder_id, title, priority, status, preconditions AS pre, steps, expected, version, step_list, tags, fields
     FROM test_cases WHERE project_key=$1 AND num=$2`, [req.params.key, n]);
  if (!rows[0]) return res.status(404).json({ error: "Тест-кейс не найден" });
  // шаги: прислали structure — берём её; прислали только текст — разбираем, сохраняя ожидаемые результаты; ничего — как были
  const stepListSent = req.body.stepList !== undefined || req.body.steps === undefined;
  const { c, error } = readCase({ ...rows[0], stepList: rows[0].step_list, ...req.body }, rows[0].step_list, stepListSent);
  if (error) return res.status(400).json({ error });
  const badRef = await shared.checkRefs(req.params.key, c.stepList);
  if (badRef) return res.status(400).json({ error: badRef });
  // ревью: «На ревью» — только кнопкой, «Готов» в режиме согласования — через ревью, правка готового — снова черновик
  const gate = await review.gateStatus(req, rows[0], c);
  if (gate.error) return res.status(409).json({ error: gate.error });
  c.status = gate.status;
  // параметры: не прислали — как были; у чек-листа параметров нет
  const prm = await datasets.readCaseParams(req.params.key, req.body, c.kind);
  if (prm.error) return res.status(400).json({ error: prm.error });
  const keepParams = prm.params === undefined && c.kind !== "checklist";
  const cf = await casemodel.readFields(pool, req.params.key, "case", req.body.fields, rows[0].fields, { members: await memberLogins(req.params.key) });
  if (cf.error) return res.status(400).json({ error: cf.error });
  // folder: null — в корень проекта; не прислали — остаётся где был
  const folder = req.body.folder === undefined ? rows[0].folder_id : await folders.folderId(pool, req.params.key, req.body.folder);
  if (folder === undefined) return res.status(400).json({ error: "Папка не найдена" });
  // защита от затирания: клиент может прислать версию, которую редактировал
  if (req.body.baseVersion !== undefined && Number(req.body.baseVersion) !== rows[0].version) {
    return res.status(409).json({ error: `Кейс уже изменили (сейчас версия ${rows[0].version}). Обновите страницу и повторите правку`, version: rows[0].version });
  }
  const upd = await pool.query(
    `UPDATE test_cases SET folder_id=$1, title=$2, priority=$3, status=$4, preconditions=$5, steps=$6, expected=$7, updated_by=$8, updated_at=now(), kind=$11,
       step_list=$12, tags=$13, fields=$14,
       params = CASE WHEN $15 THEN params ELSE $16::jsonb END, dataset_id = CASE WHEN $15 THEN dataset_id ELSE $17::int END
     WHERE project_key=$9 AND num=$10 RETURNING version`,
    [folder, c.title, c.priority, c.status, c.pre, c.steps, c.expected, req.user.id, req.params.key, n, c.kind,
      JSON.stringify(c.stepList), req.body.tags === undefined ? rows[0].tags : c.tags, cf.fields,
      keepParams, prm.params ? JSON.stringify(prm.params) : null, prm.datasetId ?? null]
  );
  broadcast("cases");
  const version = upd.rows[0].version;
  if (rows[0].status === "review" && c.status !== "review") await review.cancelPending(pool, [rows[0].id]);
  if (version !== rows[0].version) events.emit(req.params.key, "case.updated", { case: await events.snap.testCase(req.params.key, n), previousVersion: rows[0].version }, req.user);
  res.json({ ok: true, version, statusReset: gate.reset ? "draft" : undefined });
}));

// Отметить пункт чек-листа выполненным: {"item": "текст", "done": true | false}, или снять все отметки: {"reset": true}.
// Дата «Обновлён» у чек-листа не меняется — сам чек-лист остался прежним
app.post("/api/projects/:key/cases/:num/check", auth.requireUser, wrap(async (req, res) => {
  const where = [req.params.key, num(req.params.num)];
  const { rows } = await pool.query("SELECT kind, steps FROM test_cases WHERE project_key=$1 AND num=$2", where);
  if (!rows[0]) return res.status(404).json({ error: "Чек-лист не найден" });
  if (rows[0].kind !== "checklist") return res.status(400).json({ error: "Отмечать пункты можно только у чек-листа" });
  if (req.body.reset === true) {
    await pool.query("UPDATE test_cases SET checked='{}' WHERE project_key=$1 AND num=$2", where);
  } else {
    const item = str(req.body.item, checklist.MAX_ITEM);
    if (!checklist.items(rows[0].steps).includes(item)) return res.status(404).json({ error: "Такого пункта в чек-листе нет: возможно, его только что изменили" });
    if (typeof req.body.done !== "boolean") return res.status(400).json({ error: "done должно быть true или false" });
    // правка одного ключа прямо в базе: двое, отмечающие разные пункты одновременно, не затрут отметки друг друга
    await pool.query(
      req.body.done
        ? "UPDATE test_cases SET checked = checked || jsonb_build_object($3::text, jsonb_build_object('by', $4::text, 'at', now())) WHERE project_key=$1 AND num=$2"
        : "UPDATE test_cases SET checked = checked - $3::text WHERE project_key=$1 AND num=$2",
      req.body.done ? [...where, item, req.user.login] : [...where, item]
    );
  }
  broadcast("cases");
  res.json({ ok: true });
}));

// Массовое изменение выбранных кейсов: статус, приоритет, теги (добавить / убрать), пользовательские поля.
// Каждый изменённый кейс получает новую версию, как при ручной правке. До 1000 кейсов за раз
// «На ревью» массово не ставится — только отправкой на ревью
const CASE_STATUSES = ["draft", "ready", "deprecated"];
const CASE_PRIORITIES = PRIORITIES;
app.post("/api/projects/:key/cases/bulk", auth.requireUser, wrap(async (req, res) => {
  const key = req.params.key;
  const nums = [...new Set((Array.isArray(req.body.nums) ? req.body.nums : []).map(num).filter(Boolean))].slice(0, 1000);
  if (!nums.length) return res.status(400).json({ error: "Выберите хотя бы один тест-кейс" });
  const { status, priority } = req.body;
  if (status !== undefined && !CASE_STATUSES.includes(status)) return res.status(400).json({ error: `Статус: ${CASE_STATUSES.join(", ")}` });
  if (status === "ready" && !access.can(req.projectRole, "cases.review") && (await review.required(pool, key))) {
    return res.status(409).json({ error: "В этом проекте кейс становится готовым только после ревью" });
  }
  if (priority !== undefined && !CASE_PRIORITIES.includes(priority)) return res.status(400).json({ error: `Приоритет: ${CASE_PRIORITIES.join(", ")}` });
  const add = casemodel.normalizeTags(req.body.addTags || []) || [];
  const removeTags = new Set(casemodel.normalizeTags(req.body.removeTags || []) || []);
  const patch = req.body.fields;
  if (status === undefined && priority === undefined && !add.length && !removeTags.size && !patch) return res.status(400).json({ error: "Укажите, что изменить" });
  const members = patch ? await memberLogins(key) : null;
  const out = await tx(async (db) => {
    const { rows } = await db.query("SELECT id, num, status, priority, tags, fields FROM test_cases WHERE project_key=$1 AND num = ANY($2::int[]) FOR UPDATE", [key, nums]);
    let changed = 0;
    for (const c of rows) {
      const tags = [...new Set([...c.tags, ...add])].filter((t) => !removeTags.has(t));
      let fields = c.fields;
      if (patch) {
        const cf = await casemodel.readFields(db, key, "case", patch, c.fields, { members });
        if (cf.error) return { status: 400, error: `${key}-${c.num}: ${cf.error}` };
        fields = cf.fields;
      }
      const same = (status ?? c.status) === c.status && (priority ?? c.priority) === c.priority
        && JSON.stringify(tags) === JSON.stringify(c.tags) && JSON.stringify(fields) === JSON.stringify(c.fields);
      if (same) continue;
      await db.query("UPDATE test_cases SET status=$2, priority=$3, tags=$4, fields=$5, updated_by=$6, updated_at=now() WHERE id=$1",
        [c.id, status ?? c.status, priority ?? c.priority, tags, fields, req.user.id]);
      if (c.status === "review" && status !== undefined && status !== "review") await review.cancelPending(db, [c.id]);
      changed++;
    }
    return { changed, found: rows.length };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  if (out.changed) broadcast("cases");
  res.json({ changed: out.changed, skipped: nums.length - out.changed });
}));

// Массовое удаление в корзину. Кейсы из заблокированных планов пропускаются
app.post("/api/projects/:key/cases/bulk-delete", auth.requireUser, wrap(async (req, res) => {
  const key = req.params.key;
  const nums = [...new Set((Array.isArray(req.body.nums) ? req.body.nums : []).map(num).filter(Boolean))].slice(0, 1000);
  if (!nums.length) return res.status(400).json({ error: "Выберите хотя бы один тест-кейс" });
  const locked = new Set((await pool.query(
    `SELECT DISTINCT c.num FROM plan_cases pc JOIN test_plans p ON p.id=pc.plan_id JOIN test_cases c ON c.id=pc.case_id
     WHERE c.project_key=$1 AND c.num = ANY($2::int[]) AND p.locked`, [key, nums]
  )).rows.map((r) => r.num));
  let deleted = 0;
  for (const n of nums) {
    if (locked.has(n)) continue;
    const r = await trash.remove(req, "case", n);
    if (!r) continue;
    deleted++;
    events.emit(key, "case.deleted", { case: { id: `${key}-${n}`, num: n, title: r.title } }, req.user);
  }
  if (deleted) broadcast("cases");
  res.json({ deleted, locked: [...locked] });
}));

app.delete("/api/projects/:key/cases/:num", auth.requireUser, wrap(async (req, res) => {
  const locked = await pool.query(
    `SELECT p.num FROM plan_cases pc JOIN test_plans p ON p.id=pc.plan_id JOIN test_cases c ON c.id=pc.case_id
     WHERE c.project_key=$1 AND c.num=$2 AND p.locked LIMIT 1`,
    [req.params.key, num(req.params.num)]
  );
  if (locked.rows[0]) return res.status(409).json({ error: `Кейс входит в заблокированный тест-план ${req.params.key}-P${locked.rows[0].num}. Пометьте его устаревшим вместо удаления` });
  // в корзину: кейс с версиями, результатами и комментариями можно восстановить (server/trash.js)
  const r = await trash.remove(req, "case", num(req.params.num));
  if (!r) return res.status(404).json({ error: "Тест-кейс не найден" });
  broadcast("cases");
  events.emit(req.params.key, "case.deleted", { case: { id: `${req.params.key}-${req.params.num}`, num: num(req.params.num), title: r.title } }, req.user);
  res.json({ ok: true, trashId: r.trashId });
}));

// ---------- версии тест-кейса ----------
const versionOut = (v) => ({
  version: v.version, kind: v.kind, title: v.title, priority: v.priority, status: v.status, pre: v.preconditions, steps: v.steps,
  expected: v.expected, stepList: v.step_list_expanded || v.step_list, tags: v.tags, fields: v.fields, changedBy: v.changed_by_login, changed: v.changed_at.getTime(),
});
const versionSql = `SELECT v.*, expand_steps(v.step_list) AS step_list_expanded, u.login AS changed_by_login FROM test_case_versions v JOIN test_cases c ON c.id=v.case_id
  LEFT JOIN users u ON u.id=v.changed_by WHERE c.project_key=$1 AND c.num=$2`;

app.get("/api/projects/:key/cases/:num/versions", auth.requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(`${versionSql} ORDER BY v.version DESC`, [req.params.key, num(req.params.num)]);
  if (!rows.length) return res.status(404).json({ error: "Тест-кейс не найден" });
  res.json({ versions: rows.map(versionOut) });
}));

app.get("/api/projects/:key/cases/:num/versions/:v", auth.requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(`${versionSql} AND v.version=$3`, [req.params.key, num(req.params.num), num(req.params.v)]);
  if (!rows[0]) return res.status(404).json({ error: "Версия не найдена" });
  res.json(versionOut(rows[0]));
}));

// Вернуть кейс к прежней версии: создаётся новая версия с тем же содержимым (история не переписывается)
app.post("/api/projects/:key/cases/:num/versions/:v/restore", auth.requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(`${versionSql} AND v.version=$3`, [req.params.key, num(req.params.num), num(req.params.v)]);
  if (!rows[0]) return res.status(404).json({ error: "Версия не найдена" });
  const v = rows[0];
  const upd = await pool.query(
    `UPDATE test_cases SET kind=$1, title=$2, priority=$3, status=$4, preconditions=$5, steps=$6, expected=$7, updated_by=$8, updated_at=now(),
       step_list=$11, tags=$12, fields=$13
     WHERE project_key=$9 AND num=$10 RETURNING version`,
    [v.kind, v.title, v.priority, v.status, v.preconditions, v.steps, v.expected, req.user.id, req.params.key, num(req.params.num),
      JSON.stringify(v.step_list), v.tags, v.fields]
  );
  broadcast("cases");
  events.emit(req.params.key, "case.updated", { case: await events.snap.testCase(req.params.key, num(req.params.num)), restoredFrom: v.version }, req.user);
  res.json({ ok: true, version: upd.rows[0].version });
}));

// подсказки языковой модели в формах; запись (черновики бага и кейса) — только тестировщикам, как и сами формы
app.use("/api/projects/:key/ai", auth.requireUser, require("./assist"));
app.use("/api/projects/:key", auth.requireUser, require("./runs"), require("./bugs"), require("./comments"), folders.router, caseio.router, autotests.projectRouter, attachments.projectRouter);
app.use("/api/projects/:key", auth.requireUser, require("./requirements").router, require("./templates").router, shared.router, review.router, datasets.router, plans.router, webhooks.router, trackers.router, ci.router, require("./analytics").router, projectio.projectRouter);
app.use("/api/tokens", auth.requireUser, autotests.tokenRouter);
app.use("/api/attachments", auth.requireUser, attachments.fileRouter);
app.use("/api/admin", auth.requireUser, access.requireAdmin, require("./users"), require("./personal").router, audit.router, trash.adminRouter);
app.use("/api/llm", auth.requireUser, llm.router);
// подключения к языковым моделям (облачные сервисы и свои модели) — только администратор
app.use("/api/admin/llm", auth.requireUser, access.requireAdmin, llm.adminRouter);

// Встроенная справка (docs/, README, CHANGELOG) — для всех вошедших
app.use("/api/help", auth.requireUser, require("./help").router);

// Лицензия (админ): условия действующего ключа, ввод нового ключа, возврат к бесплатной редакции
const licenseOut = (l) => ({ edition: l.edition, status: l.status, notice: l.notice, full: l.full, view: l.view, license: l.license || null, source: l.source });
app.get("/api/admin/license", auth.requireUser, access.requireAdmin, wrap(async (_req, res) => {
  res.json({ ...licenseOut(await license.current()), seats: await seats.usage(pool) });
}));
app.put("/api/admin/license", auth.requireUser, access.requireAdmin, wrap(async (req, res) => {
  const key = str(req.body.key, 8000);
  if (!key) return res.status(400).json({ error: "Вставьте лицензионный ключ" });
  try {
    const l = await license.save(key, req.user.id);
    res.json({ ...licenseOut(l), seats: await seats.usage(pool) });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    throw e;
  }
}));
app.delete("/api/admin/license", auth.requireUser, access.requireAdmin, wrap(async (_req, res) => {
  const l = await license.remove();
  res.json({ ...licenseOut(l), seats: await seats.usage(pool) });
}));

// Фоновые задачи (админ): сводка по очереди, упавшие задачи, повтор
app.get("/api/admin/jobs", auth.requireUser, access.requireAdmin, wrap(async (_req, res) => {
  res.json(await jobs.overview());
}));
app.post("/api/admin/jobs/:id/retry", auth.requireUser, access.requireAdmin, wrap(async (req, res) => {
  if (!(await jobs.retry(num(req.params.id)))) return res.status(404).json({ error: "Упавшая задача не найдена" });
  res.json({ ok: true });
}));

// О системе (админ): версия, сборка, база, история обновлений
app.get("/api/admin/system", auth.requireUser, access.requireAdmin, wrap(async (_req, res) => {
  const [pg, mig, vers] = await Promise.all([
    pool.query("SHOW server_version"),
    pool.query("SELECT name, applied_at FROM schema_migrations ORDER BY name DESC"),
    pool.query("SELECT version, first_started_at, last_started_at, commit FROM app_versions ORDER BY first_started_at DESC"),
  ]);
  res.json({
    version: version.VERSION, commit: version.COMMIT, built: version.BUILT, node: process.version,
    postgres: pg.rows[0].server_version,
    migrations: { count: mig.rows.length, last: mig.rows[0]?.name || null, lastAt: mig.rows[0]?.applied_at.getTime() || null },
    history: vers.rows.map((v) => ({ version: v.version, commit: v.commit, since: v.first_started_at.getTime(), last: v.last_started_at.getTime() })),
  });
}));

// Проверки для Docker и Kubernetes. livez — процесс жив; readyz — готов принимать запросы (база, миграции, хранилище);
// healthz — как раньше (база доступна), для docker-compose
let ready = false;
let stopping = false;
app.get("/livez", (_req, res) => res.json({ ok: true }));
app.get("/readyz", wrap(async (_req, res) => {
  if (!ready || stopping) return res.status(503).json({ ok: false, reason: stopping ? "stopping" : "starting" });
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));
// Метрики Prometheus — только с METRICS_TOKEN
app.get("/metrics", metrics.handler());
metrics.gauges({ pool, live, version });
app.get("/healthz", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "Не найдено" }));
// Скрипты отправки результатов автотестов: curl -O http://<адрес>/testball-reporter.js (Playwright) или /report.js (JUnit XML)
const CLIENT_SCRIPTS = { "testball-reporter.js": "playwright-reporter.js", "report.js": "report.js" };
app.get(["/testball-reporter.js", "/report.js"], (req, res) => {
  const name = req.path.slice(1);
  res.set("Content-Disposition", `attachment; filename="${name}"`);
  res.type("application/javascript").sendFile(path.join(__dirname, "..", "scripts", CLIENT_SCRIPTS[name]));
});
// Интерфейс собирается из web/ командой npm run build:web (в Docker — автоматически)
app.use(express.static(path.join(__dirname, "..", "public"), { index: "index.html", maxAge: 0 }));

app.use((err, req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Некорректный JSON" });
  // ошибки с понятным пользователю кодом (модель недоступна, сервер перегружен, тело слишком большое) — не ошибки сервера
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.expose && err.status) return res.status(err.status).json({ error: err.status === 413 ? "Слишком большой запрос" : "Некорректный запрос" });
  log.error("server", err.message, { reqId: req.id, method: req.method, path: req.originalUrl.split("?")[0], user: req.user?.login || null, err: err.code || err.name, stack: err.stack });
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: `Внутренняя ошибка сервера. Код запроса для поддержки: ${req.id}`, requestId: req.id });
});

(async () => {
  await waitForDb();
  await migrate();
  // Аварийный вход для админа: ADMIN_LOGIN в .env делает этого пользователя админом и снимает блокировку
  if (process.env.ADMIN_LOGIN) {
    const r = await pool.query("UPDATE users SET role='admin', blocked=false WHERE login=$1", [RESERVED_ADMIN]);
    console.log(r.rowCount ? `[server] ${process.env.ADMIN_LOGIN} — администратор` : `[server] ADMIN_LOGIN: пользователь ${process.env.ADMIN_LOGIN} не найден`);
  }
  await auth.prepareSetup();
  await secrets.init();
  await require("./storage").check();
  await live.listen();
  attachments.startSweeper();
  // уборка раз в час: корзина, журнал аудита, журнал вебхуков, выполненные фоновые задачи
  jobs.define("housekeeping", () => Promise.all([trash.purgeExpired(), audit.purge(), require("./personal").purgeIps(), webhooks.trimDeliveries(), jobs.cleanup()]), { maxAttempts: 1, title: "Уборка устаревших данных" });
  jobs.every("housekeeping", 60 * 60 * 1000);
  trackers.startSync();
  jobs.start();
  const server = app.listen(PORT, "0.0.0.0", () => {
    ready = true;
    console.log(`[server] TestBall QA ${version.VERSION}${version.COMMIT ? ` (${version.COMMIT.slice(0, 8)})` : ""} запущен: http://localhost:${PORT}`);
  });
  // Kubernetes присылает SIGTERM: сначала перестаём числиться готовыми, дожидаемся текущих запросов, закрываем соединения
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal}: останавливаемся`);
    live.closeAll();
    // фоновые задачи: новые не берём, текущие дожидаемся; невыполненные подхватит другая реплика
    const jobsDone = jobs.stop(10000);
    server.close(() => jobsDone.then(() => pool.end()).finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000)).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})().catch((e) => {
  console.error("[server] Не удалось запуститься:", e.message);
  process.exit(1);
});
