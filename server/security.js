// Политики безопасности входа: пароли, сессии, двухфакторная аутентификация (TOTP, RFC 6238).
//
// Пароли:  PASSWORD_MIN_LENGTH (8), PASSWORD_MIN_CLASSES (2: из строчных, прописных, цифр, прочих символов),
//          PASSWORD_MAX_AGE_DAYS (0 — бессрочно), PASSWORD_HISTORY (0 — можно повторять),
//          PASSWORD_CHANGE_ON_RESET (true — пароль, выданный админом, меняется при первом входе).
//          Популярные пароли и пароль, содержащий логин, не принимаются никогда.
// Сессии:  SESSION_DAYS (30), SESSION_IDLE_MINUTES (0 — без тайм-аута), MAX_SESSIONS (0 — без ограничения).
// 2FA:     TWO_FACTOR=optional (по желанию, по умолчанию) | required (всем с паролем) | admins | off.
//          Пользователи OIDC и Kerberos проходят второй фактор у себя в IdP — к ним требование не относится.
const crypto = require("crypto");
const { pool } = require("./db");
const secrets = require("./secrets");

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const cfg = {
  minLength: Math.max(6, Number(env("PASSWORD_MIN_LENGTH", 8))),
  minClasses: Math.min(4, Math.max(1, Number(env("PASSWORD_MIN_CLASSES", 2)))),
  maxAgeDays: Number(env("PASSWORD_MAX_AGE_DAYS", 0)),
  history: Math.min(24, Number(env("PASSWORD_HISTORY", 0))),
  changeOnReset: env("PASSWORD_CHANGE_ON_RESET", "true") !== "false",
  idleMinutes: Number(env("SESSION_IDLE_MINUTES", 0)),
  maxSessions: Number(env("MAX_SESSIONS", 0)),
  twoFactor: ["optional", "required", "admins", "off"].includes(env("TWO_FACTOR", "optional")) ? env("TWO_FACTOR", "optional") : "optional",
};

// ---------- пароли ----------
// Самые частые пароли из утечек (в том числе русские раскладки): такие подбирают первыми
const COMMON = new Set(`password password1 password123 password12 passw0rd p@ssw0rd p@ssword qwerty qwerty123 qwerty1 qwertyuiop
123456 1234567 12345678 123456789 1234567890 12345678910 11111111 00000000 12341234 87654321 123123123 123qwe 1q2w3e4r 1q2w3e4r5t
1qaz2wsx qazwsx qazwsx123 zaq12wsx abc12345 abcd1234 iloveyou admin admin123 administrator letmein welcome welcome1 monkey dragon
football baseball superman sunshine princess master shadow michael trustno1 changeme secret secret123 test1234 testtest
йцукен йцукен123 пароль пароль123 qwerty12345 zxcvbnm asdfghjk asdf1234 testball testball1 testball123`.split(/\s+/));

function checkPassword(password, { login = "", name = "" } = {}) {
  if (typeof password !== "string" || password.length > 200) return "Пароль слишком длинный";
  if (password.length < cfg.minLength) return `Пароль должен быть не короче ${cfg.minLength} символов`;
  const classes = [/[a-zа-яё]/, /[A-ZА-ЯЁ]/, /\d/, /[^\p{L}\d]/u].filter((re) => re.test(password)).length;
  if (classes < cfg.minClasses) {
    return cfg.minClasses >= 3
      ? `Пароль должен содержать ${cfg.minClasses} вида символов из четырёх: строчные и прописные буквы, цифры, знаки`
      : "Пароль должен содержать не только буквы или не только цифры";
  }
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[\d!.]+$/, ""))) return "Это один из самых распространённых паролей — его подберут первым. Придумайте другой";
  if (login && login.length >= 3 && lower.includes(login.toLowerCase())) return "Пароль не должен содержать логин";
  if (name && name.length >= 4 && lower.includes(name.toLowerCase().split(/\s+/)[0])) return "Пароль не должен содержать имя";
  return null;
}

const policyText = () =>
  `не короче ${cfg.minLength} символов${cfg.minClasses >= 2 ? `, ${cfg.minClasses >= 3 ? `${cfg.minClasses} вида символов из: строчные, прописные, цифры, знаки` : "не только буквы или цифры"}` : ""}, без логина и популярных паролей`;

// Повтор недавних паролей: сверяем с последними PASSWORD_HISTORY хэшами (verify — bcrypt из auth.js)
async function reusedPassword(db, userId, password, verify) {
  if (!cfg.history) return false;
  const { rows } = await db.query(
    `SELECT password_hash FROM users WHERE id=$1
     UNION ALL (SELECT hash FROM password_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2)`,
    [userId, cfg.history - 1]
  );
  for (const r of rows) if ((await verify(password, r.password_hash)).ok) return true;
  return false;
}

// Записать новый пароль: история, дата смены, флаг «сменить при входе»
async function setPassword(db, userId, hash, { byAdmin = false } = {}) {
  if (cfg.history) {
    await db.query("INSERT INTO password_history(user_id, hash) SELECT id, password_hash FROM users WHERE id=$1", [userId]);
    await db.query(
      `DELETE FROM password_history WHERE user_id=$1 AND id NOT IN (SELECT id FROM password_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2)`,
      [userId, cfg.history]
    );
  }
  await db.query("UPDATE users SET password_hash=$2, password_changed_at=now(), must_change_password=$3 WHERE id=$1", [userId, hash, byAdmin && cfg.changeOnReset]);
}

// ---------- ограничения сессии ----------
// Что пользователь обязан сделать, прежде чем работать: сменить пароль или включить 2FA. null — ничего
function pendingAction(u) {
  if (!u || u.auth_provider === "oidc" || u.auth_provider === "kerberos") return null;
  if (u.auth_provider === "local" || !u.auth_provider) {
    if (u.must_change_password) return "password";
    if (cfg.maxAgeDays > 0 && u.password_changed_at && Date.now() - new Date(u.password_changed_at).getTime() > cfg.maxAgeDays * 864e5) return "password";
  }
  if (!u.totp_enabled && twoFactorRequired(u)) return "2fa";
  return null;
}
const twoFactorRequired = (u) =>
  u.auth_provider !== "oidc" && u.auth_provider !== "kerberos" && (cfg.twoFactor === "required" || (cfg.twoFactor === "admins" && u.role === "admin"));

const PENDING_TEXT = {
  password: "Смените пароль, чтобы продолжить работу",
  "2fa": "Включите двухфакторную аутентификацию, чтобы продолжить работу",
};

// ---------- TOTP ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totp(secretB32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", unbase32(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0");
}
const stepNow = (now = Date.now()) => Math.floor(now / 30000);
// Код подходит в окне ±1 шаг (30 с) — на случай расхождения часов. Возвращает шаг или null
function matchTotp(secretB32, code, lastStep = -1, now = Date.now()) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const s = stepNow(now);
  for (const d of [0, -1, 1]) {
    const step = s + d;
    // один и тот же код дважды не принимается: перехваченный код нельзя использовать повторно
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(totp(secretB32, step)), Buffer.from(c))) return step;
  }
  return null;
}
const newSecret = () => base32(crypto.randomBytes(20));
const otpauthUri = (secret, login) => {
  const issuer = process.env.TOTP_ISSUER || "TestBall";
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${login}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
};

// Резервные коды: 10 одноразовых кодов вида 4f2a-91c0, в базе — только хэши
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const normCode = (c) => String(c || "").toLowerCase().replace(/[^a-f0-9]/g, "");
async function newRecoveryCodes(db, userId) {
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString("hex").replace(/^(.{4})/, "$1-"));
  await db.query("DELETE FROM user_recovery_codes WHERE user_id=$1", [userId]);
  await db.query("INSERT INTO user_recovery_codes(user_id, code_hash) SELECT $1, unnest($2::text[])", [userId, codes.map((c) => sha256(normCode(c)))]);
  return codes;
}
async function useRecoveryCode(db, userId, code) {
  const n = normCode(code);
  if (n.length !== 8) return false;
  const { rowCount } = await db.query("UPDATE user_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL", [userId, sha256(n)]);
  return rowCount === 1;
}

// Проверка второго фактора при входе: код из приложения или резервный код
async function verifySecondFactor(userId, code) {
  const { rows } = await pool.query("SELECT totp_secret, totp_last_step FROM users WHERE id=$1", [userId]);
  const u = rows[0];
  if (!u?.totp_secret) return { ok: false };
  const secret = secrets.decrypt(u.totp_secret);
  const step = matchTotp(secret, code, Number(u.totp_last_step ?? -1));
  if (step !== null) {
    // шаг записывается условно: два параллельных входа с одним кодом — пройдёт только один
    const { rowCount } = await pool.query("UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2)", [userId, step]);
    return { ok: rowCount === 1, method: "totp" };
  }
  if (await useRecoveryCode(pool, userId, code)) {
    const left = (await pool.query("SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL", [userId])).rows[0].n;
    return { ok: true, method: "recovery", recoveryLeft: left };
  }
  return { ok: false };
}

module.exports = {
  cfg, checkPassword, policyText, reusedPassword, setPassword, pendingAction, twoFactorRequired, PENDING_TEXT,
  totp, matchTotp, stepNow, newSecret, otpauthUri, base32, unbase32, newRecoveryCodes, verifySecondFactor,
};
