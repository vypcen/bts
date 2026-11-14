// Лицензионный ключ: JSON с условиями, подписанный закрытым ключом производителя (Ed25519).
// Формат: TB1.<base64url(JSON)>.<base64url(подпись)>. Сервер проверяет подпись открытым ключом, зашитым ниже,
// поэтому изменить число мест или срок в ключе нельзя — подпись перестанет сходиться.
// Ключ выпускает scripts/license.js issue (нужен закрытый ключ, у заказчика его нет).
//
// Условия (поля JSON): id, customer, edition, full, view (места; null — без ограничений), issued, expires
// (дата окончания или null — бессрочно), updatesUntil (до какой даты выхода версии действует подписка на обновления),
// host (необязательно: ключ работает только на этом адресе PUBLIC_URL).
//
// Без ключа — бесплатная редакция: COMMUNITY.full полных мест, просмотровые без ограничений.
// Ключ истёк — ещё GRACE_DAYS дней всё работает с предупреждением, затем лимиты бесплатной редакции.
// Лимиты никого не блокируют и не закрывают данные: при нехватке мест нельзя только выдать новую полную роль.
const crypto = require("crypto");
const { pool } = require("./db");

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyjxXq4XtBXGPaQc5K+Wv2gFYODsi2YZIIL7s01mejnE=
-----END PUBLIC KEY-----`;
// Ключ для автотестов (закрытый — в test/fixtures). В production-образе (NODE_ENV=production) не принимается
const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAfQ0q4DmsoB+jo+XsIQ9RfXgc1OPFP62dv8KB9auzxIQ=
-----END PUBLIC KEY-----`;

const COMMUNITY = { edition: "community", full: 5, view: null };
const GRACE_DAYS = 14;
const WARN_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

// Разобрать и проверить ключ. Возвращает {terms, test} или бросает Error с понятным текстом
function verify(key) {
  const parts = String(key || "").trim().replace(/\s+/g, "").split(".");
  if (parts.length !== 3 || parts[0] !== "TB1") throw new Error("Это не лицензионный ключ TestBall: он начинается с TB1.");
  const [, body, sig] = parts;
  const data = Buffer.from(`TB1.${body}`);
  const signature = Buffer.from(sig, "base64url");
  const ok = (pem) => {
    try {
      return crypto.verify(null, data, crypto.createPublicKey(pem), signature);
    } catch {
      return false;
    }
  };
  let test = false;
  if (!ok(PUBLIC_KEY)) {
    if (process.env.NODE_ENV !== "production" && ok(TEST_PUBLIC_KEY)) test = true;
    else throw new Error("Подпись ключа не сходится: ключ повреждён при копировании или изменён");
  }
  let terms;
  try {
    terms = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("Ключ повреждён");
  }
  if (!terms || typeof terms !== "object" || !terms.id) throw new Error("Ключ повреждён");
  return { terms, test };
}

// Выпуск ключа (scripts/license.js и тесты)
function sign(terms, privateKeyPem) {
  const body = b64u(JSON.stringify(terms));
  const sig = crypto.sign(null, Buffer.from(`TB1.${body}`), crypto.createPrivateKey(privateKeyPem));
  return `TB1.${body}.${b64u(sig)}`;
}

const dateMs = (d) => (d ? new Date(`${String(d).slice(0, 10)}T23:59:59Z`).getTime() : null);
const hostOf = (u) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
};

// Действующие условия по ключу на момент now
function evaluate(key, now = Date.now()) {
  if (!key) return { ...COMMUNITY, status: "none", notice: null };
  let v;
  try {
    v = verify(key);
  } catch (e) {
    return { ...COMMUNITY, status: "invalid", notice: `Лицензионный ключ не принят: ${e.message}. Действуют условия бесплатной редакции.` };
  }
  const t = v.terms;
  const info = {
    id: t.id, customer: t.customer || "", issued: t.issued || null, expires: t.expires || null,
    updatesUntil: t.updatesUntil || null, host: t.host || null, test: v.test,
  };
  const base = { edition: t.edition || "enterprise", full: t.full ?? null, view: t.view ?? null, license: info };
  if (t.host && hostOf(process.env.PUBLIC_URL) !== String(t.host).toLowerCase()) {
    return { ...COMMUNITY, license: info, status: "wrong-host", notice: `Ключ выдан для адреса ${t.host}, а сервер работает как ${hostOf(process.env.PUBLIC_URL) || "(PUBLIC_URL не задан)"}. Действуют условия бесплатной редакции.` };
  }
  const end = dateMs(t.expires);
  if (end !== null && now > end) {
    const graceEnd = end + GRACE_DAYS * DAY;
    if (now <= graceEnd) {
      return { ...base, status: "grace", notice: `Лицензия истекла ${t.expires}. Продлите её до ${new Date(graceEnd).toISOString().slice(0, 10)}, после этого будут действовать лимиты бесплатной редакции.` };
    }
    return { ...COMMUNITY, license: info, status: "expired", notice: `Лицензия истекла ${t.expires}. Действуют условия бесплатной редакции: ${COMMUNITY.full} полных мест.` };
  }
  let notice = v.test ? "Тестовая лицензия: не для рабочей эксплуатации." : null;
  if (end !== null && end - now < WARN_DAYS * DAY) notice = `Лицензия заканчивается ${t.expires}. Свяжитесь с поставщиком для продления.`;
  const pkg = require("../package.json");
  const released = process.env.BUILD_DATE ? Date.parse(process.env.BUILD_DATE) : null;
  if (!notice && t.updatesUntil && released && released > dateMs(t.updatesUntil)) {
    notice = `Эта версия (${pkg.version}) вышла после окончания подписки на обновления (${t.updatesUntil}). Лицензия действует, но продлите подписку, чтобы получать обновления законно.`;
  }
  return { ...base, status: "active", notice };
}

// Текущий ключ: из базы (введён в интерфейсе) или из LICENSE_KEY. Кэш на минуту — проверяется на каждое назначение роли
let cache = null;
async function current() {
  if (cache && Date.now() - cache.at < 60 * 1000) return cache.value;
  let key = process.env.LICENSE_KEY || null;
  let source = key ? "env" : null;
  try {
    const { rows } = await pool.query("SELECT key FROM license WHERE id=1");
    if (rows[0]) {
      key = rows[0].key;
      source = "db";
    }
  } catch {
    // таблицы ещё нет (до миграций)
  }
  const value = { ...evaluate(key), source };
  cache = { at: Date.now(), value };
  return value;
}
const reset = () => (cache = null);

async function save(key, userId) {
  const v = evaluate(key);
  if (v.status === "invalid" || v.status === "wrong-host") throw Object.assign(new Error(v.notice), { status: 400 });
  await pool.query(
    "INSERT INTO license(id, key, updated_by) VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET key=EXCLUDED.key, updated_by=EXCLUDED.updated_by, updated_at=now()",
    [String(key).trim(), userId]
  );
  reset();
  return current();
}

async function remove() {
  await pool.query("DELETE FROM license WHERE id=1");
  reset();
  return current();
}

module.exports = { verify, sign, evaluate, current, save, remove, reset, COMMUNITY, GRACE_DAYS };
