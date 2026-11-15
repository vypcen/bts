// Своя учётная запись: двухфакторная аутентификация и активные сессии. Монтируется на /api/auth
const express = require("express");
const QRCode = require("qrcode");
const { pool, tx } = require("./db");
const auth = require("./auth");
const audit = require("./audit");
const secrets = require("./secrets");
const security = require("./security");
const { Limiter, MIN } = require("./limits");
const { wrap } = require("./util");

const router = express.Router();
// подбор кода 2FA при включении/отключении: 10 попыток за 15 минут на пользователя
const codeLimit = new Limiter(10, 15 * MIN);
const TOO_MANY = "Слишком много попыток. Подождите 15 минут";

async function userRow(id) {
  return (await pool.query(
    "SELECT id, login, auth_provider, password_hash, totp_secret, totp_pending, totp_enabled_at, totp_last_step, role FROM users WHERE id=$1", [id]
  )).rows[0];
}

// Состояние 2FA
router.get("/2fa", auth.requireUser, wrap(async (req, res) => {
  const u = await userRow(req.user.id);
  const left = (await pool.query("SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL", [u.id])).rows[0].n;
  res.json({
    enabled: !!u.totp_secret, since: u.totp_enabled_at ? u.totp_enabled_at.getTime() : null, recoveryLeft: left,
    required: security.twoFactorRequired(u), policy: security.cfg.twoFactor,
    available: security.cfg.twoFactor !== "off" && u.auth_provider !== "oidc" && u.auth_provider !== "kerberos",
  });
}));

// Шаг 1: новый секрет и QR-код для приложения-аутентификатора. Включается только после ввода кода (шаг 2)
router.post("/2fa/setup", auth.requireUser, wrap(async (req, res) => {
  const u = await userRow(req.user.id);
  if (security.cfg.twoFactor === "off") return res.status(409).json({ error: "Двухфакторная аутентификация отключена администратором" });
  if (u.auth_provider === "oidc" || u.auth_provider === "kerberos") return res.status(409).json({ error: "Вы входите через корпоративный SSO: второй фактор настраивается там" });
  if (u.totp_secret) return res.status(409).json({ error: "Двухфакторная аутентификация уже включена" });
  const secret = security.newSecret();
  await pool.query("UPDATE users SET totp_pending=$2 WHERE id=$1", [u.id, secrets.encrypt(secret)]);
  const uri = security.otpauthUri(secret, u.login);
  const qr = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  res.json({ secret: secret.replace(/(.{4})/g, "$1 ").trim(), uri, qr });
}));

// Шаг 2: подтвердить кодом — 2FA включена, выдаются резервные коды (показываются один раз)
router.post("/2fa/enable", auth.requireUser, wrap(async (req, res) => {
  if (!codeLimit.take(String(req.user.id))) return res.status(429).json({ error: TOO_MANY });
  const u = await userRow(req.user.id);
  if (u.totp_secret) return res.status(409).json({ error: "Двухфакторная аутентификация уже включена" });
  if (!u.totp_pending) return res.status(409).json({ error: "Сначала получите QR-код" });
  const secret = secrets.decrypt(u.totp_pending);
  const step = security.matchTotp(secret, req.body.code);
  if (step === null) return res.status(400).json({ error: "Код не подошёл. Проверьте, что время на телефоне выставлено автоматически, и введите новый код" });
  const codes = await tx(async (db) => {
    await db.query("UPDATE users SET totp_secret=totp_pending, totp_pending=NULL, totp_enabled_at=now(), totp_last_step=$2 WHERE id=$1", [u.id, step]);
    return security.newRecoveryCodes(db, u.id);
  });
  // остальные сессии закрываются: включение 2FA обычно значит «хочу, чтобы без телефона никто не вошёл»
  await auth.destroyOtherSessions(req, u.id);
  audit.log(req, "auth.2fa_enabled", { project: null, target: u.login });
  res.json({ ok: true, recoveryCodes: codes });
}));

// Подтверждение личности для отключения и новых резервных кодов: пароль (если он есть) и код 2FA
async function confirm(req, u) {
  if (u.auth_provider === "local" && !(await auth.verifyPassword(String(req.body.password || ""), u.password_hash)).ok) return "Пароль указан неверно";
  const second = await security.verifySecondFactor(u.id, req.body.code);
  return second.ok ? null : "Код не подошёл";
}

router.post("/2fa/disable", auth.requireUser, wrap(async (req, res) => {
  if (!codeLimit.take(String(req.user.id))) return res.status(429).json({ error: TOO_MANY });
  const u = await userRow(req.user.id);
  if (!u.totp_secret) return res.status(409).json({ error: "Двухфакторная аутентификация не включена" });
  if (security.twoFactorRequired(u)) return res.status(409).json({ error: "Двухфакторная аутентификация обязательна по политике безопасности — отключить её нельзя" });
  const bad = await confirm(req, u);
  if (bad) return res.status(403).json({ error: bad });
  await pool.query("UPDATE users SET totp_secret=NULL, totp_pending=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE id=$1", [u.id]);
  await pool.query("DELETE FROM user_recovery_codes WHERE user_id=$1", [u.id]);
  audit.log(req, "auth.2fa_disabled", { project: null, target: u.login });
  res.json({ ok: true });
}));

router.post("/2fa/recovery-codes", auth.requireUser, wrap(async (req, res) => {
  if (!codeLimit.take(String(req.user.id))) return res.status(429).json({ error: TOO_MANY });
  const u = await userRow(req.user.id);
  if (!u.totp_secret) return res.status(409).json({ error: "Двухфакторная аутентификация не включена" });
  const bad = await confirm(req, u);
  if (bad) return res.status(403).json({ error: bad });
  const codes = await security.newRecoveryCodes(pool, u.id);
  audit.log(req, "auth.recovery_codes", { project: null, target: u.login });
  res.json({ recoveryCodes: codes });
}));

// Активные сессии: где и когда входили. id — начало хэша токена (сам токен из него не восстановить)
router.get("/sessions", auth.requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT token_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id=$1 AND expires_at > now() ORDER BY last_seen_at DESC",
    [req.user.id]
  );
  res.json({
    sessions: rows.map((s) => ({
      id: s.token_hash.slice(0, 16), created: s.created_at.getTime(), lastSeen: s.last_seen_at.getTime(), ip: s.ip,
      agent: s.user_agent, current: s.token_hash.slice(0, 16) === req.sessionId,
    })),
    idleMinutes: security.cfg.idleMinutes, maxSessions: security.cfg.maxSessions,
  });
}));

router.delete("/sessions/:id", auth.requireUser, wrap(async (req, res) => {
  const id = String(req.params.id).replace(/[^0-9a-f]/g, "").slice(0, 16);
  if (id.length !== 16) return res.status(400).json({ error: "Неверный идентификатор сессии" });
  const { rowCount } = await pool.query("DELETE FROM sessions WHERE user_id=$1 AND left(token_hash, 16)=$2", [req.user.id, id]);
  if (!rowCount) return res.status(404).json({ error: "Сессия не найдена" });
  audit.log(req, "auth.sessions_revoked", { project: null, target: req.user.login, details: { count: rowCount } });
  res.json({ ok: true, current: id === req.sessionId });
}));

// Завершить все сессии, кроме текущей
router.post("/sessions/others", auth.requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id=$1", [req.user.id]);
  await auth.destroyOtherSessions(req, req.user.id);
  audit.log(req, "auth.sessions_revoked", { project: null, target: req.user.login, details: { count: Math.max(0, rows[0].n - 1) } });
  res.json({ ok: true });
}));

module.exports = router;
