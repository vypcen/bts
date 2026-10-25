const crypto = require("crypto");
const path = require("path");
const { Worker } = require("worker_threads");
const { pool } = require("./db");
const { Limiter, MIN } = require("./limits");
const { HttpError } = require("./util");

const COOKIE = "tb_session";
// Через HTTPS cookie называется с префиксом __Host-: браузер не даст соседнему поддомену (чужой *.fxtun.ru и т. п.)
// подставить такую cookie. По HTTP (локально) префикс невозможен — он требует Secure
const SECURE_COOKIE = "__Host-tb_session";
const cookieName = (req) => (req.secure ? SECURE_COOKIE : COOKIE);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const BCRYPT_ROUNDS = 12;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---------- пароли ----------
// bcrypt — в отдельных потоках (server/hash-worker.js). Очередь ограничена: под наплывом запросов
// сервер честно отвечает «занят», а не перестаёт отвечать всем
const WORKERS = Math.max(1, Number(process.env.HASH_WORKERS || 2));
const MAX_PENDING = Number(process.env.HASH_MAX_PENDING || 20);
const workers = [];
const pending = new Map(); // id → {resolve, reject, worker}
let seq = 0;

function spawn() {
  const w = new Worker(path.join(__dirname, "hash-worker.js"));
  w.unref();
  w.on("message", ({ id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  });
  // упавший поток заменяем, его задачи завершаем ошибкой
  w.on("error", (e) => console.error("[auth] поток bcrypt упал:", e.message));
  w.on("exit", () => {
    for (const [id, p] of pending) {
      if (p.worker !== w) continue;
      pending.delete(id);
      p.reject(new Error("поток bcrypt завершился"));
    }
    workers[workers.indexOf(w)] = spawn();
  });
  return w;
}

function run(op, pass, arg) {
  if (pending.size >= MAX_PENDING) throw new HttpError(503, "Сервер перегружен. Повторите через минуту");
  if (!workers.length) for (let i = 0; i < WORKERS; i++) workers.push(spawn());
  const id = ++seq;
  const worker = workers[id % workers.length];
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, worker });
    worker.postMessage({ id, op, pass, arg });
  });
}

const hashPassword = (pass) => run("hash", pass, BCRYPT_ROUNDS);

// Поддерживает bcrypt и формат, перенесённый из прошлой версии:
// "pbkdf2$<iterations>$<salt base64>$<hash base64>". Возвращает {ok, legacy}.
async function verifyPassword(pass, stored) {
  if (stored.startsWith("pbkdf2$")) {
    const [, iter, salt, hash] = stored.split("$");
    const n = Number(iter);
    if (!Number.isInteger(n) || n < 1 || n > 5e6 || !salt || !hash) return { ok: false, legacy: true };
    // асинхронный pbkdf2 считается в пуле потоков libuv и тоже не держит основной поток
    const derived = await new Promise((res, rej) => crypto.pbkdf2(pass, Buffer.from(salt, "base64"), n, 32, "sha256", (e, k) => (e ? rej(e) : res(k))));
    const expected = Buffer.from(hash, "base64");
    const ok = expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    return { ok, legacy: true };
  }
  return { ok: await run("compare", pass, stored), legacy: false };
}

// Правила для новой учётной записи: регистрация, создание админом, смена пароля
const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
function checkLogin(login) {
  return LOGIN_RE.test(login) ? null : "Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание";
}
function checkPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 200 ? null : "Пароль должен быть от 8 до 200 символов";
}

// ---------- сессии ----------
// Битое значение cookie (например, подброшенное с соседнего поддомена) пропускаем, а не роняем запрос
function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

const sessionToken = (req) => parseCookies(req.headers.cookie)[cookieName(req)];

async function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await pool.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2,$3)", [sha256(token), userId, expires]);
  res.cookie(cookieName(req), token, { httpOnly: true, sameSite: "lax", secure: req.secure, expires, path: "/" });
}

async function destroySession(req, res) {
  const token = sessionToken(req);
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
  res.clearCookie(cookieName(req), { path: "/", secure: req.secure });
}

// Выйти на всех устройствах, кроме текущего (после смены пароля)
async function destroyOtherSessions(req, userId) {
  const token = sessionToken(req);
  await pool.query("DELETE FROM sessions WHERE user_id=$1 AND token_hash IS DISTINCT FROM $2", [userId, token ? sha256(token) : null]);
}

// Токен для скриптов: "tb_" + случайная строка. Показывается один раз, в базе только хэш
const newApiToken = () => "tb_" + crypto.randomBytes(24).toString("base64url");

// Кладёт в req.user {id, login, name, role}, если cookie или токен (Authorization: Bearer) валидны.
// Заблокированный пользователь не проходит ни по сессии, ни по токену.
// Вход по токену помечается req.viaToken: такие запросы пускаются только к отправке результатов автотестов
async function loadUser(req, _res, next) {
  try {
    const bearer = /^Bearer\s+(tb_[\w-]{20,64})$/.exec(req.get("authorization") || "");
    if (bearer) {
      const { rows } = await pool.query(
        `UPDATE api_tokens t SET last_used_at=now() FROM users u
         WHERE t.token_hash=$1 AND u.id=t.user_id AND NOT u.blocked RETURNING u.id, u.login, u.name, u.role`,
        [sha256(bearer[1])]
      );
      if (rows[0]) {
        req.user = rows[0];
        req.viaToken = true;
      }
      return next();
    }
    const token = sessionToken(req);
    if (token) {
      const { rows } = await pool.query(
        `SELECT u.id, u.login, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash=$1 AND s.expires_at > now() AND NOT u.blocked`,
        [sha256(token)]
      );
      if (rows[0]) req.user = rows[0];
    }
    next();
  } catch (e) {
    next(e);
  }
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Войдите в систему" });
  next();
}

// ---------- ограничение попыток ----------
// IP можно подделать заголовком X-Forwarded-For, если приложение доступно не только через прокси,
// поэтому есть и лимиты, не зависящие от IP: на логин и общий на регистрацию
const limits = {
  loginIpLogin: new Limiter(10, 15 * MIN), // неудачные попытки: логин + IP
  loginIp: new Limiter(30, 15 * MIN), // неудачные попытки с одного IP по любым логинам
  loginAny: new Limiter(50, 15 * MIN), // неудачные попытки на один логин с любых IP — перебор пароля админа
  registerIp: new Limiter(5, 60 * MIN),
  registerAll: new Limiter(30, 60 * MIN),
  password: new Limiter(10, 15 * MIN), // проверки текущего пароля при смене, на пользователя
};
const TOO_MANY = "Слишком много попыток. Подождите 15 минут";

// ---------- первый вход ----------
// В пустой базе первый зарегистрированный становится админом. Чтобы этим не воспользовался посторонний,
// успевший открыть свежую установку раньше хозяина, нужен код из логов сервера (или SETUP_CODE из .env)
let setupCode = null;
async function needsSetup() {
  const { rows } = await pool.query("SELECT NOT EXISTS (SELECT 1 FROM users) AS empty");
  return rows[0].empty;
}
// Код создаётся один раз и не меняется до регистрации админа — его можно спокойно взять из логов
async function prepareSetup() {
  if (setupCode || !(await needsSetup())) return;
  setupCode = process.env.SETUP_CODE || crypto.randomBytes(6).toString("hex");
  console.log(`[server] Пользователей ещё нет. Код для регистрации первого администратора: ${setupCode}`);
}
function checkSetupCode(code) {
  if (!setupCode || typeof code !== "string") return false;
  const a = Buffer.from(code.trim()), b = Buffer.from(setupCode);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const setupDone = () => (setupCode = null);

module.exports = {
  sha256,
  newApiToken,
  hashPassword,
  verifyPassword,
  checkLogin,
  checkPassword,
  createSession,
  destroySession,
  destroyOtherSessions,
  loadUser,
  requireUser,
  limits,
  TOO_MANY,
  needsSetup,
  prepareSetup,
  checkSetupCode,
  setupDone,
};
