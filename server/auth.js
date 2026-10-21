const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { pool } = require("./db");

const COOKIE = "tb_session";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const BCRYPT_ROUNDS = 12;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function hashPassword(pass) {
  return bcrypt.hash(pass, BCRYPT_ROUNDS);
}

// Поддерживает bcrypt и формат, перенесённый из прошлой версии:
// "pbkdf2$<iterations>$<salt base64>$<hash base64>". Возвращает {ok, legacy}.
async function verifyPassword(pass, stored) {
  if (stored.startsWith("pbkdf2$")) {
    const [, iter, salt, hash] = stored.split("$");
    const derived = crypto.pbkdf2Sync(pass, Buffer.from(salt, "base64"), Number(iter), 32, "sha256");
    const expected = Buffer.from(hash, "base64");
    const ok = expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    return { ok, legacy: true };
  }
  return { ok: await bcrypt.compare(pass, stored), legacy: false };
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await pool.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2,$3)", [
    sha256(token),
    userId,
    expires,
  ]);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    expires,
    path: "/",
  });
}

async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
  res.clearCookie(COOKIE, { path: "/" });
}

// Токен для скриптов: "tb_" + случайная строка. Показывается один раз, в базе только хэш
const newApiToken = () => "tb_" + crypto.randomBytes(24).toString("base64url");

// Кладёт в req.user {id, login, name, role}, если cookie или токен (Authorization: Bearer) валидны.
// Заблокированный пользователь не проходит ни по сессии, ни по токену.
// Вход по токену помечается req.viaToken: такие запросы пускаются только к API автотестов
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
    const token = parseCookies(req.headers.cookie)[COOKIE];
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

// Простое ограничение попыток входа: 10 неудачных попыток за 15 минут на логин+IP
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
function tooManyAttempts(key) {
  const a = attempts.get(key);
  return a && a.count >= 10 && Date.now() - a.first < WINDOW;
}
function recordFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}
function clearFailures(key) {
  attempts.delete(key);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (now - a.first > WINDOW) attempts.delete(k);
  pool.query("DELETE FROM sessions WHERE expires_at < now()").catch(() => {});
}, 10 * 60 * 1000).unref();

module.exports = {
  sha256,
  newApiToken,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadUser,
  requireUser,
  tooManyAttempts,
  recordFailure,
  clearFailures,
};
