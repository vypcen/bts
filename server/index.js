const path = require("path");
const express = require("express");
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
const { wrap, str, num, ms, HttpError } = require("./util");

const PORT = Number(process.env.PORT || 3000);
// Статус готовности кейса. Результат прохождения хранится в прогонах (server/runs.js)
const STATUSES = ["draft", "ready", "deprecated"];
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
  ["POST", /^\/projects\/[^/]+\/autoruns\/\d+\/results\/\d+\/attachments$/],
  ["PATCH", /^\/projects\/[^/]+\/autoruns\/\d+$/],
];
const { broadcast } = live;

const app = express();
app.disable("x-powered-by");
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
app.use("/api", (req, res, next) => {
  if (req.viaToken && !TOKEN_ROUTES.some(([method, re]) => method === req.method && re.test(req.path))) {
    return res.status(403).json({ error: "Токен подходит только для отправки результатов автотестов" });
  }
  next();
});

app.get("/api/events", auth.requireUser, live.events);

// ---------- авторизация ----------
const me = (u) => ({ login: u.login, name: u.name, role: u.role, provider: u.auth_provider || "local" });
const { limits, TOO_MANY } = auth;

// Без входа — ещё и что показывать на странице входа: нужен ли код установки, открыта ли регистрация
app.get("/api/auth/me", wrap(async (req, res) => {
  if (req.user) {
    const { rows } = await pool.query("SELECT auth_provider FROM users WHERE id=$1", [req.user.id]);
    return res.json({ user: me({ ...req.user, auth_provider: rows[0]?.auth_provider }) });
  }
  res.json({ user: null, setup: await auth.needsSetup(), registration: sso.cfg.localLogin ? REGISTRATION : "closed", providers: sso.providers() });
}));

app.post("/api/auth/register", wrap(async (req, res) => {
  const login = str(req.body.login, 64).toLowerCase();
  const name = str(req.body.name, 100);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const bad = auth.checkLogin(login) || (!name && "Укажите имя") || auth.checkPassword(password);
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
  const hash = await auth.hashPassword(password);
  // новичок только смотрит и не видит ни одного проекта, пока админ не выдаст доступ;
  // первый пользователь в пустой базе становится админом
  const { rows } = await pool.query(
    `INSERT INTO users(login, name, password_hash, role)
     VALUES ($1,$2,$3, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'developer' ELSE 'admin' END)
     ON CONFLICT (login) DO NOTHING RETURNING id, role`,
    [login, name, hash]
  );
  if (!rows[0]) return res.status(409).json({ error: "Логин уже занят. Выберите другой или войдите" });
  if (rows[0].role === "admin") auth.setupDone();
  await auth.createSession(res, req, rows[0].id);
  broadcast("users");
  res.status(201).json({ user: { login, name, role: rows[0].role } });
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
    limits.loginIpLogin.hit(key);
    limits.loginIp.hit(req.ip);
    limits.loginAny.hit(login);
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  limits.loginIpLogin.clear(key);
  if (u.blocked) return res.status(403).json({ error: "Учётная запись заблокирована. Обратитесь к администратору" });
  if (check.legacy) {
    // пароль из прошлой версии — сразу перехэшируем в bcrypt
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await auth.hashPassword(password), u.id]);
  }
  await pool.query("UPDATE users SET last_login_at=now() WHERE id=$1", [u.id]);
  await auth.createSession(res, req, u.id);
  res.json({ user: me(u) });
}));

// OpenID Connect и Kerberos (переходы браузера, GET)
app.use("/api/auth", sso.router);

app.post("/api/auth/logout", wrap(async (req, res) => {
  await auth.destroySession(req, res);
  res.json({ ok: true });
}));

// Смена своего пароля. Остальные сессии закрываются: если пароль утёк, вошедший с ним теряет доступ
app.post("/api/auth/password", auth.requireUser, wrap(async (req, res) => {
  const current = typeof req.body.current === "string" ? req.body.current : "";
  const bad = auth.checkPassword(req.body.password);
  if (bad) return res.status(400).json({ error: bad });
  if (!limits.password.take(String(req.user.id))) return res.status(429).json({ error: TOO_MANY });
  const { rows } = await pool.query("SELECT password_hash, auth_provider FROM users WHERE id=$1", [req.user.id]);
  if (rows[0].auth_provider !== "local") return res.status(409).json({ error: "Пароль хранится в корпоративном каталоге (LDAP/SSO) и меняется там" });
  if (!(await auth.verifyPassword(current, rows[0].password_hash)).ok) return res.status(403).json({ error: "Текущий пароль указан неверно" });
  await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await auth.hashPassword(req.body.password), req.user.id]);
  await auth.destroyOtherSessions(req, req.user.id);
  res.json({ ok: true });
}));

// ---------- данные ----------
const caseSql = `SELECT c.project_key, c.num, c.kind, c.checked, c.folder_id, c.title, c.priority, c.status, c.preconditions, c.steps, c.expected, c.version,
  EXISTS (SELECT 1 FROM auto_tests a WHERE a.case_id=c.id) AS automated,
  cu.login AS created_by, uu.login AS updated_by, c.created_at, c.updated_at
  FROM test_cases c LEFT JOIN users cu ON cu.id=c.created_by LEFT JOIN users uu ON uu.id=c.updated_by`;
const toCase = (r) => ({
  id: `${r.project_key}-${r.num}`, pid: r.project_key, num: r.num, kind: r.kind, checked: r.checked, folder: r.folder_id, title: r.title, priority: r.priority, status: r.status,
  pre: r.preconditions, steps: r.steps, expected: r.expected, createdBy: r.created_by, updatedBy: r.updated_by, version: r.version, automated: r.automated,
  created: r.created_at.getTime(), updated: r.updated_at.getTime(),
});

// Всё состояние одним запросом: для MVP-объёмов это проще и надёжнее точечной синхронизации
// Пользователь получает только свои проекты и всё, что в них; админ — всё
app.get("/api/state", auth.requireUser, wrap(async (req, res) => {
  // $1 — список доступных ключей или NULL, если доступны все
  const only = [await access.projectKeys(req.user)];
  const mine = (col) => `($1::text[] IS NULL OR ${col} = ANY($1::text[]))`;
  const [projects, cases, users, runs, results, bugs, files, autoruns, comments, caseFolders, testPlans] = await Promise.all([
    // myRole — действующая роль текущего пользователя в проекте (роль в проекте или глобальная)
    pool.query(`SELECT p.key, p.name, p.description, p.created_at, u.login AS created_by,
                  ARRAY(SELECT mu.login FROM project_members m JOIN users mu ON mu.id=m.user_id WHERE m.project_key=p.key ORDER BY mu.login) AS members,
                  COALESCE(json_object_agg(mu2.login, m2.role) FILTER (WHERE m2.role IS NOT NULL), '{}') AS member_roles,
                  CASE WHEN $3 = 'admin' THEN 'admin' ELSE COALESCE((SELECT role FROM project_members WHERE project_key=p.key AND user_id=$2), $3) END AS my_role
                FROM projects p LEFT JOIN users u ON u.id=p.created_by
                LEFT JOIN project_members m2 ON m2.project_key=p.key LEFT JOIN users mu2 ON mu2.id=m2.user_id
                WHERE ${mine("p.key")} GROUP BY p.key, u.login ORDER BY p.created_at DESC`, [only[0], req.user.id, req.user.role]),
    pool.query(`${caseSql} WHERE ${mine("c.project_key")} ORDER BY c.project_key, c.num`, only),
    // Пользователи — те, с кем есть общий проект, и админы (их можно назначить исполнителем). Админ видит всех.
    // Новичок без проектов видит только себя: список логинов и админов не должен доставаться любому зарегистрировавшемуся
    pool.query(
      `SELECT login, name, role FROM users u WHERE $1::text[] IS NULL OR u.id=$2
         OR (u.role='admin' AND cardinality($1::text[]) > 0)
         OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.project_key = ANY($1::text[]))`,
      [only[0], req.user.id]
    ),
    pool.query(`SELECT r.project_key, r.num, r.title, r.build, r.environment, r.state, u.login AS created_by, r.created_at, r.closed_at,
                  p.num AS plan_num, COALESCE(p.locked, false) AS plan_locked
                FROM test_runs r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN test_plans p ON p.id=r.plan_id
                WHERE ${mine("r.project_key")} ORDER BY r.project_key, r.num`, only),
    pool.query(`SELECT rr.id, t.project_key, t.num AS run_num, c.num AS case_num, rr.result, rr.comment, rr.items, u.login AS executed_by, rr.executed_at,
                  au.login AS assignee, rr.case_version
                FROM run_results rr JOIN test_runs t ON t.id=rr.run_id JOIN test_cases c ON c.id=rr.case_id
                LEFT JOIN users u ON u.id=rr.executed_by LEFT JOIN users au ON au.id=rr.assignee_id WHERE ${mine("t.project_key")}`, only),
    pool.query(`SELECT b.project_key, b.num, b.title, b.status, b.severity, au.login AS assignee, b.environment, b.steps, b.actual, b.expected,
                  c.num AS case_num, t.num AS run_num, b.run_result_id, d.num AS dup_num, b.external_key, b.external_url, b.external_status,
                  cu.login AS created_by, uu.login AS updated_by, b.created_at, b.updated_at
                FROM bugs b LEFT JOIN users au ON au.id=b.assignee_id LEFT JOIN test_cases c ON c.id=b.case_id
                LEFT JOIN run_results rr ON rr.id=b.run_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
                LEFT JOIN bugs d ON d.id=b.duplicate_of
                LEFT JOIN users cu ON cu.id=b.created_by LEFT JOIN users uu ON uu.id=b.updated_by
                WHERE ${mine("b.project_key")} ORDER BY b.project_key, b.num`, only),
    pool.query(`SELECT a.id, COALESCE(b.project_key, t.project_key) AS project_key, b.num AS bug_num, a.run_result_id,
                  a.filename, a.mime, a.size, u.login AS uploaded_by, a.created_at
                FROM attachments a LEFT JOIN bugs b ON b.id=a.bug_id
                LEFT JOIN run_results rr ON rr.id=a.run_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
                LEFT JOIN users u ON u.id=a.uploaded_by
                WHERE a.auto_result_id IS NULL AND ${mine("COALESCE(b.project_key, t.project_key)")} ORDER BY a.created_at`, only),
    // запуски автотестов — только сводка; сами результаты отдаёт GET /api/projects/:key/autoruns/:num
    pool.query(`SELECT r.project_key, r.num, r.title, r.build, r.environment, r.branch, r.scope, r.app_url, r.state, u.login AS created_by, r.created_at, r.finished_at,
                  r.params, r.ci_url, count(ar.id) FILTER (WHERE ar.flaky)::int AS flaky,
                  count(ar.id) FILTER (WHERE ar.status='passed')::int AS passed, count(ar.id) FILTER (WHERE ar.status='failed')::int AS failed,
                  count(ar.id) FILTER (WHERE ar.status='broken')::int AS broken, count(ar.id) FILTER (WHERE ar.status='skipped')::int AS skipped,
                  COALESCE(sum(ar.duration_ms), 0)::bigint AS duration
                FROM auto_runs r LEFT JOIN auto_results ar ON ar.run_id=r.id LEFT JOIN users u ON u.id=r.created_by
                WHERE ${mine("r.project_key")} GROUP BY r.id, u.login ORDER BY r.project_key, r.num`, only),
    pool.query(`SELECT cm.id, COALESCE(b.project_key, c.project_key) AS project_key, b.num AS bug_num, c.num AS case_num,
                  u.login AS author, cm.body, cm.created_at, cm.edited_at
                FROM comments cm LEFT JOIN bugs b ON b.id=cm.bug_id LEFT JOIN test_cases c ON c.id=cm.case_id
                LEFT JOIN users u ON u.id=cm.author_id
                WHERE ${mine("COALESCE(b.project_key, c.project_key)")} ORDER BY cm.created_at, cm.id`, only),
    pool.query(`SELECT id, project_key, parent_id, name FROM case_folders WHERE ${mine("project_key")} ORDER BY project_key, name`, only),
    pool.query(`SELECT project_key, num, title, mode, locked FROM test_plans WHERE ${mine("project_key")} ORDER BY project_key, num`, only),
  ]);
  res.json({
    projects: projects.rows.map((p) => ({
      id: p.key, name: p.name, desc: p.description, createdBy: p.created_by, created: p.created_at.getTime(), members: p.members,
      memberRoles: p.member_roles, myRole: p.my_role,
    })),
    plans: testPlans.rows.map((p) => ({ id: `${p.project_key}-P${p.num}`, pid: p.project_key, num: p.num, title: p.title, mode: p.mode, locked: p.locked })),
    cases: cases.rows.map(toCase),
    folders: caseFolders.rows.map((f) => ({ id: f.id, pid: f.project_key, parent: f.parent_id, name: f.name })),
    runs: runs.rows.map((r) => ({
      id: `${r.project_key}-R${r.num}`, pid: r.project_key, num: r.num, title: r.title, build: r.build, env: r.environment,
      state: r.state, createdBy: r.created_by, created: ms(r.created_at), closed: ms(r.closed_at), planNum: r.plan_num, planLocked: r.plan_locked,
    })),
    results: results.rows.map((r) => ({
      id: r.id, pid: r.project_key, runNum: r.run_num, caseNum: r.case_num, result: r.result, comment: r.comment, items: r.items,
      executedBy: r.executed_by, executed: ms(r.executed_at), assignee: r.assignee, caseVersion: r.case_version,
    })),
    bugs: bugs.rows.map((b) => ({
      id: `${b.project_key}-B${b.num}`, pid: b.project_key, num: b.num, title: b.title, status: b.status, severity: b.severity,
      assignee: b.assignee, env: b.environment, steps: b.steps, actual: b.actual, expected: b.expected,
      caseNum: b.case_num, runNum: b.run_num, resultId: b.run_result_id, duplicateOf: b.dup_num,
      createdBy: b.created_by, updatedBy: b.updated_by, created: ms(b.created_at), updated: ms(b.updated_at),
      external: b.external_key ? { key: b.external_key, url: b.external_url, status: b.external_status || "" } : null,
    })),
    attachments: files.rows.map((a) => ({
      id: a.id, pid: a.project_key, bugNum: a.bug_num, resultId: a.run_result_id, name: a.filename, mime: a.mime, size: a.size,
      uploadedBy: a.uploaded_by, created: ms(a.created_at),
    })),
    autoruns: autoruns.rows.map((r) => ({
      id: `${r.project_key}-A${r.num}`, pid: r.project_key, num: r.num, title: r.title, build: r.build, env: r.environment, branch: r.branch,
      scope: r.scope, url: r.app_url, state: r.state, createdBy: r.created_by, created: ms(r.created_at), finished: ms(r.finished_at), durationMs: Number(r.duration),
      counts: { passed: r.passed, failed: r.failed, broken: r.broken, skipped: r.skipped }, flaky: r.flaky, params: r.params, ciUrl: r.ci_url,
    })),
    comments: comments.rows.map((c) => ({
      id: c.id, pid: c.project_key, bugNum: c.bug_num, caseNum: c.case_num, author: c.author, text: c.body,
      created: ms(c.created_at), edited: ms(c.edited_at),
    })),
    users: Object.fromEntries(users.rows.map((u) => [u.login, { name: u.name, role: u.role }])),
  });
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
  if (!created) return res.status(409).json({ error: `Ключ ${key} уже занят другим проектом` });
  broadcast("projects");
  res.status(201).json({ id: key });
}));

// Новый проект из файла: экспорт TestBall или выгрузка другой TMS (TestRail, TestLink, Qase)
app.use("/api/projects-import", auth.requireUser, access.requireWriter, projectio.importRouter);

// Всё внутри проекта: доступ только участникам и админам, изменения — только тестировщикам и админам (кроме комментариев)
app.use("/api/projects/:key", auth.requireUser, access.project);
// Настройки интеграций содержат адреса и заголовки внутренних систем — их видят только те, кто может менять проект
app.use(["/api/projects/:key/webhooks", "/api/projects/:key/tracker"], (req, res, next) =>
  access.canWrite(req.projectRole) ? next() : res.status(403).json({ error: access.READ_ONLY }));

app.patch("/api/projects/:key", auth.requireUser, wrap(async (req, res) => {
  const name = str(req.body.name, 200);
  const desc = str(req.body.desc, 2000);
  if (!name) return res.status(400).json({ error: "Укажите название проекта" });
  const r = await pool.query("UPDATE projects SET name=$1, description=$2 WHERE key=$3", [name, desc, req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: "Проект не найден" });
  broadcast("projects");
  res.json({ ok: true });
}));

app.delete("/api/projects/:key", auth.requireUser, wrap(async (req, res) => {
  // кейсы, прогоны и баги удалятся каскадно
  const r = await pool.query("DELETE FROM projects WHERE key=$1", [req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: "Проект не найден" });
  broadcast("projects");
  res.json({ ok: true });
}));

function readCase(body) {
  const c = {
    kind: body.kind === undefined ? "case" : str(body.kind, 20),
    title: str(body.title, 500),
    priority: str(body.priority, 20),
    status: str(body.status, 20),
    pre: str(body.pre),
    steps: str(body.steps),
    expected: str(body.expected),
  };
  if (!checklist.KINDS.includes(c.kind)) return { error: "Неизвестный вид: case или checklist" };
  if (!c.title) return { error: c.kind === "checklist" ? "Укажите название чек-листа" : "Укажите название тест-кейса" };
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
  const folder = await folders.folderId(pool, req.params.key, req.body.folder);
  if (folder === undefined) return res.status(400).json({ error: "Папка не найдена" });
  const n = await tx(async (db) => {
    // атомарно берём следующий номер — два одновременных создания не получат один ID
    const r = await db.query("UPDATE projects SET seq=seq+1 WHERE key=$1 RETURNING seq", [req.params.key]);
    if (!r.rows[0]) return null;
    const next = r.rows[0].seq;
    await db.query(
      `INSERT INTO test_cases(project_key, num, kind, folder_id, title, priority, status, preconditions, steps, expected, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [req.params.key, next, c.kind, folder, c.title, c.priority, c.status, c.pre, c.steps, c.expected, req.user.id]
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
  const { rows } = await pool.query("SELECT kind, folder_id, title, priority, status, preconditions AS pre, steps, expected, version FROM test_cases WHERE project_key=$1 AND num=$2", [req.params.key, n]);
  if (!rows[0]) return res.status(404).json({ error: "Тест-кейс не найден" });
  const { c, error } = readCase({ ...rows[0], ...req.body });
  if (error) return res.status(400).json({ error });
  // folder: null — в корень проекта; не прислали — остаётся где был
  const folder = req.body.folder === undefined ? rows[0].folder_id : await folders.folderId(pool, req.params.key, req.body.folder);
  if (folder === undefined) return res.status(400).json({ error: "Папка не найдена" });
  // защита от затирания: клиент может прислать версию, которую редактировал
  if (req.body.baseVersion !== undefined && Number(req.body.baseVersion) !== rows[0].version) {
    return res.status(409).json({ error: `Кейс уже изменили (сейчас версия ${rows[0].version}). Обновите страницу и повторите правку`, version: rows[0].version });
  }
  const upd = await pool.query(
    `UPDATE test_cases SET folder_id=$1, title=$2, priority=$3, status=$4, preconditions=$5, steps=$6, expected=$7, updated_by=$8, updated_at=now(), kind=$11
     WHERE project_key=$9 AND num=$10 RETURNING version`,
    [folder, c.title, c.priority, c.status, c.pre, c.steps, c.expected, req.user.id, req.params.key, n, c.kind]
  );
  broadcast("cases");
  const version = upd.rows[0].version;
  if (version !== rows[0].version) events.emit(req.params.key, "case.updated", { case: await events.snap.testCase(req.params.key, n), previousVersion: rows[0].version }, req.user);
  res.json({ ok: true, version });
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

app.delete("/api/projects/:key/cases/:num", auth.requireUser, wrap(async (req, res) => {
  const locked = await pool.query(
    `SELECT p.num FROM plan_cases pc JOIN test_plans p ON p.id=pc.plan_id JOIN test_cases c ON c.id=pc.case_id
     WHERE c.project_key=$1 AND c.num=$2 AND p.locked LIMIT 1`,
    [req.params.key, num(req.params.num)]
  );
  if (locked.rows[0]) return res.status(409).json({ error: `Кейс входит в заблокированный тест-план ${req.params.key}-P${locked.rows[0].num}. Пометьте его устаревшим вместо удаления` });
  const r = await pool.query("DELETE FROM test_cases WHERE project_key=$1 AND num=$2 RETURNING title", [req.params.key, num(req.params.num)]);
  if (!r.rowCount) return res.status(404).json({ error: "Тест-кейс не найден" });
  broadcast("cases");
  events.emit(req.params.key, "case.deleted", { case: { id: `${req.params.key}-${req.params.num}`, num: num(req.params.num), title: r.rows[0].title } }, req.user);
  res.json({ ok: true });
}));

// ---------- версии тест-кейса ----------
const versionOut = (v) => ({
  version: v.version, kind: v.kind, title: v.title, priority: v.priority, status: v.status, pre: v.preconditions, steps: v.steps,
  expected: v.expected, changedBy: v.changed_by_login, changed: v.changed_at.getTime(),
});
const versionSql = `SELECT v.*, u.login AS changed_by_login FROM test_case_versions v JOIN test_cases c ON c.id=v.case_id
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
    `UPDATE test_cases SET kind=$1, title=$2, priority=$3, status=$4, preconditions=$5, steps=$6, expected=$7, updated_by=$8, updated_at=now()
     WHERE project_key=$9 AND num=$10 RETURNING version`,
    [v.kind, v.title, v.priority, v.status, v.preconditions, v.steps, v.expected, req.user.id, req.params.key, num(req.params.num)]
  );
  broadcast("cases");
  events.emit(req.params.key, "case.updated", { case: await events.snap.testCase(req.params.key, num(req.params.num)), restoredFrom: v.version }, req.user);
  res.json({ ok: true, version: upd.rows[0].version });
}));

// подсказки языковой модели в формах; запись (черновики бага и кейса) — только тестировщикам, как и сами формы
app.use("/api/projects/:key/ai", auth.requireUser, require("./assist"));
app.use("/api/projects/:key", auth.requireUser, require("./runs"), require("./bugs"), require("./comments"), folders.router, caseio.router, autotests.projectRouter, attachments.projectRouter);
app.use("/api/projects/:key", auth.requireUser, plans.router, webhooks.router, trackers.router, ci.router, require("./analytics"), projectio.projectRouter);
app.use("/api/tokens", auth.requireUser, autotests.tokenRouter);
app.use("/api/attachments", auth.requireUser, attachments.fileRouter);
app.use("/api/admin", auth.requireUser, access.requireAdmin, require("./users"));
app.use("/api/llm", auth.requireUser, llm.router);
// подключения к языковым моделям (облачные сервисы и свои модели) — только администратор
app.use("/api/admin/llm", auth.requireUser, access.requireAdmin, llm.adminRouter);

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

app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Некорректный JSON" });
  // ошибки с понятным пользователю кодом (модель недоступна, сервер перегружен, тело слишком большое) — не ошибки сервера
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.expose && err.status) return res.status(err.status).json({ error: err.status === 413 ? "Слишком большой запрос" : "Некорректный запрос" });
  console.error("[server]", err);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: "Внутренняя ошибка сервера. Подробности в логах." });
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
  trackers.startSync();
  const server = app.listen(PORT, "0.0.0.0", () => {
    ready = true;
    console.log(`[server] TestBall QA запущен: http://localhost:${PORT}`);
  });
  // Kubernetes присылает SIGTERM: сначала перестаём числиться готовыми, дожидаемся текущих запросов, закрываем соединения
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal}: останавливаемся`);
    live.closeAll();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000)).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})().catch((e) => {
  console.error("[server] Не удалось запуститься:", e.message);
  process.exit(1);
});
