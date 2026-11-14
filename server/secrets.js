// Шифрование секретов интеграций (токены трекеров, CI, подписи вебхуков) в базе: AES-256-GCM.
// Ключ — из APP_SECRET. Если он не задан, ключ создаётся один раз и хранится в app_settings —
// так секреты хотя бы не лежат открытым текстом в дампах таблиц интеграций. Для промышленной установки задайте APP_SECRET.
const crypto = require("crypto");
const { pool } = require("./db");

let key = null;
// прежний ключ из базы: если APP_SECRET задали позже, уже сохранённые секреты продолжают расшифровываться
let fallback = null;

async function init() {
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key='secret_key'");
  const stored = rows[0] ? Buffer.from(rows[0].value, "base64") : null;
  if (process.env.APP_SECRET) {
    if (process.env.APP_SECRET.length < 32) console.warn("[secrets] APP_SECRET короче 32 символов — задайте длинное случайное значение");
    key = crypto.createHash("sha256").update(process.env.APP_SECRET).digest();
    fallback = stored;
    return;
  }
  if (stored) {
    key = stored;
  } else {
    const fresh = crypto.randomBytes(32).toString("base64");
    await pool.query("INSERT INTO app_settings(key, value) VALUES ('secret_key', $1) ON CONFLICT (key) DO NOTHING", [fresh]);
    const again = await pool.query("SELECT value FROM app_settings WHERE key='secret_key'");
    key = Buffer.from(again.rows[0].value, "base64");
  }
  console.warn("[secrets] APP_SECRET не задан: ключ шифрования секретов интеграций хранится в базе");
}

function encrypt(plain) {
  if (!plain) return "";
  if (!key) throw new Error("secrets.init() не вызван");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

function decryptWith(k, iv, tag, data) {
  const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

function decrypt(enc) {
  if (!enc) return "";
  const [v, iv, tag, data] = enc.split(":");
  if (v !== "v1") throw new Error("Неизвестный формат секрета");
  try {
    return decryptWith(key, iv, tag, data);
  } catch (e) {
    if (fallback) return decryptWith(fallback, iv, tag, data);
    throw new Error("Не удалось расшифровать секрет интеграции: APP_SECRET изменили? Задайте токен заново");
  }
}

// Для ответа API: секрет не возвращается, только признак, что он задан
const mask = (enc) => (enc ? "••••••" : "");

module.exports = { init, encrypt, decrypt, mask };
