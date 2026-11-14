// Параметризованные вебхуки проекта. Монтируется на /api/projects/:key.
// URL, заголовки и тело — шаблоны: {{bug.title}}, {{run.counts.failed}}, {{project.key | url}}, {{$ | json}}.
// Фильтры: {"bug.severity": ["blocker","critical"], "autorun.branch": ["main"]} — событие уходит, только если значения совпали.
// Доставка асинхронная, с повторами и журналом; при заданном секрете тело подписывается: X-TestBall-Signature: sha256=<hmac>.
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const express = require("express");
const { pool } = require("./db");
const { broadcast } = require("./live");
const secrets = require("./secrets");
const events = require("./events");
const { wrap, str, num } = require("./util");

const METHODS = ["POST", "PUT", "PATCH", "GET"];
const RETRIES = [5000, 30000]; // задержки перед 2-й и 3-й попыткой
const KEEP_DELIVERIES = 200;
// В облачной установке запросы к внутренним адресам можно запретить (защита от SSRF).
// По умолчанию разрешены: в своей инфраструктуре вебхуки обычно и ходят во внутренние системы
const BLOCK_PRIVATE = process.env.WEBHOOK_BLOCK_PRIVATE === "true";
const TIMEOUT = Number(process.env.WEBHOOK_TIMEOUT_MS || 10000);

// ---------- шаблоны ----------
const get = (obj, path) => (path === "$" ? obj : path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj));
const FILTERS = {
  json: (v) => JSON.stringify(v ?? null),
  url: (v) => encodeURIComponent(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)),
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  // для вставки внутрь строки JSON: "text": "{{bug.title | jsonstr}}"
  jsonstr: (v) => JSON.stringify(String(v ?? "")).slice(1, -1),
};

function render(template, ctx) {
  return String(template).replace(/\{\{\s*([\w.$]+)\s*((?:\|\s*[\w]+(?::"[^"]*")?\s*)*)\}\}/g, (_, path, pipes) => {
    let v = get(ctx, path);
    for (const m of pipes.matchAll(/\|\s*(\w+)(?::"([^"]*)")?/g)) {
      if (m[1] === "default") v = v === undefined || v === null || v === "" ? m[2] ?? "" : v;
      else if (FILTERS[m[1]]) v = FILTERS[m[1]](v);
    }
    return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

function matches(filter, ctx) {
  return Object.entries(filter || {}).every(([path, allowed]) => {
    if (!Array.isArray(allowed) || !allowed.length) return true;
    const v = get(ctx, path);
    return allowed.map(String).includes(String(v));
  });
}

// ---------- проверка адреса ----------
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const s = ip.toLowerCase();
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80") || s.startsWith("::ffff:") && privateIp(s.slice(7));
}

async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Некорректный URL"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Поддерживаются только http и https");
  if (BLOCK_PRIVATE) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (addrs.some((a) => privateIp(a.address))) throw new Error("Адреса внутренней сети запрещены (WEBHOOK_BLOCK_PRIVATE)");
  }
  return u;
}

// ---------- доставка ----------
async function deliver(hook, event, attempt = 1) {
  const started = Date.now();
  let status = null, error = "", body = "", response = "";
  try {
    const url = await checkUrl(render(hook.url, event));
    body = hook.method === "GET" ? "" : hook.body ? render(hook.body, event) : JSON.stringify(event);
    const headers = { "User-Agent": "TestBall-Webhook/1.0", "X-TestBall-Event": event.event, "X-TestBall-Delivery": crypto.randomUUID() };
    if (body) headers["Content-Type"] = "application/json";
    for (const [k, v] of Object.entries(hook.headers || {})) if (/^[\w-]{1,100}$/.test(k)) headers[k] = render(v, event).replace(/[\r\n]/g, " ");
    const secret = secrets.decrypt(hook.secret_enc);
    if (secret) headers["X-TestBall-Signature"] = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    const res = await fetch(url, { method: hook.method, headers, body: body || undefined, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
    status = res.status;
    response = (await res.text().catch(() => "")).slice(0, 2000);
    if (status >= 300) error = `HTTP ${status}`;
  } catch (e) {
    error = e.name === "TimeoutError" ? `Нет ответа за ${TIMEOUT} мс` : e.message;
  }
  await pool.query(
    `INSERT INTO webhook_deliveries(webhook_id, event, attempt, status, error, duration_ms, request, response) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [hook.id, event.event, attempt, status, error.slice(0, 1000), Date.now() - started, body.slice(0, 10000), response]
  ).catch(() => {});
  // повторяем при сетевой ошибке и 5xx/429; 4xx — ошибка настройки, повтор не поможет
  if (error && attempt <= RETRIES.length && (status === null || status >= 500 || status === 429)) {
    setTimeout(() => deliver(hook, event, attempt + 1).catch(() => {}), RETRIES[attempt - 1]).unref();
  }
  return { status, error, durationMs: Date.now() - started, response };
}

events.subscribe(async (event) => {
  const { rows } = await pool.query("SELECT * FROM webhooks WHERE project_key=$1 AND active AND $2 = ANY(events)", [event.project.key, event.event]);
  for (const hook of rows) if (matches(hook.filter, event)) deliver(hook, event).catch((e) => console.error("[webhooks]", e.message));
});

// раз в час журнал каждого вебхука обрезается до последних KEEP_DELIVERIES записей
setInterval(() => {
  pool.query(
    `DELETE FROM webhook_deliveries d USING (
       SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY webhook_id ORDER BY created_at DESC) AS n FROM webhook_deliveries) x WHERE n > $1
     ) old WHERE d.id = old.id`,
    [KEEP_DELIVERIES]
  ).catch(() => {});
}, 3600e3).unref();

// ---------- API ----------
const router = express.Router({ mergeParams: true });

function readHook(body) {
  const h = {
    name: str(body.name, 100),
    url: str(body.url, 2000),
    method: METHODS.includes(body.method) ? body.method : "POST",
    events: Array.isArray(body.events) ? [...new Set(body.events.filter((e) => events.EVENTS[e]))] : [],
    headers: {},
    body: typeof body.body === "string" ? body.body.slice(0, 20000) : "",
    filter: {},
    active: body.active !== false,
  };
  if (!h.name) return { error: "Укажите название вебхука" };
  if (!/^https?:\/\//i.test(h.url)) return { error: "URL должен начинаться с http:// или https://" };
  if (!h.events.length) return { error: "Выберите хотя бы одно событие" };
  if (body.headers && typeof body.headers === "object") {
    for (const [k, v] of Object.entries(body.headers).slice(0, 30)) {
      if (!/^[\w-]{1,100}$/.test(k)) return { error: `Недопустимое имя заголовка «${k}»` };
      h.headers[k] = str(v, 2000);
    }
  }
  if (body.filter && typeof body.filter === "object") {
    for (const [k, v] of Object.entries(body.filter).slice(0, 20)) {
      if (!/^[\w.]{1,100}$/.test(k)) return { error: `Недопустимое поле фильтра «${k}»` };
      const vals = (Array.isArray(v) ? v : String(v).split(",")).map((x) => str(String(x), 200)).filter(Boolean);
      if (vals.length) h.filter[k] = vals;
    }
  }
  return { h };
}

const toHook = (w) => ({
  id: w.id, name: w.name, url: w.url, method: w.method, events: w.events, headers: w.headers, body: w.body, filter: w.filter,
  active: w.active, hasSecret: Boolean(w.secret_enc), created: w.created_at.getTime(),
  last: w.last_at ? { at: w.last_at.getTime(), status: w.last_status, error: w.last_error } : null,
});

router.get("/webhooks", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT w.*, d.created_at AS last_at, d.status AS last_status, d.error AS last_error FROM webhooks w
     LEFT JOIN LATERAL (SELECT created_at, status, error FROM webhook_deliveries WHERE webhook_id=w.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE w.project_key=$1 ORDER BY w.id`,
    [req.params.key]
  );
  res.json({ webhooks: rows.map(toHook), events: events.EVENTS });
}));

router.post("/webhooks", wrap(async (req, res) => {
  const { h, error } = readHook(req.body);
  if (error) return res.status(400).json({ error });
  const { rows } = await pool.query(
    `INSERT INTO webhooks(project_key, name, url, method, events, headers, body, filter, secret_enc, active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [req.params.key, h.name, h.url, h.method, h.events, h.headers, h.body, h.filter, secrets.encrypt(str(req.body.secret, 500)), h.active, req.user.id]
  );
  broadcast("webhooks");
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/webhooks/:id", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM webhooks WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: "Вебхук не найден" });
  const { h, error } = readHook({ ...rows[0], ...req.body });
  if (error) return res.status(400).json({ error });
  // секрет: не прислали — прежний, пустая строка — убрать
  const secret = req.body.secret === undefined ? rows[0].secret_enc : secrets.encrypt(str(req.body.secret, 500));
  await pool.query(
    "UPDATE webhooks SET name=$1, url=$2, method=$3, events=$4, headers=$5, body=$6, filter=$7, active=$8, secret_enc=$9 WHERE id=$10",
    [h.name, h.url, h.method, h.events, h.headers, h.body, h.filter, h.active, secret, rows[0].id]
  );
  broadcast("webhooks");
  res.json({ ok: true });
}));

router.delete("/webhooks/:id", wrap(async (req, res) => {
  const r = await pool.query("DELETE FROM webhooks WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Вебхук не найден" });
  broadcast("webhooks");
  res.json({ ok: true });
}));

router.get("/webhooks/:id/deliveries", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.event, d.attempt, d.status, d.error, d.duration_ms, d.request, d.response, d.created_at FROM webhook_deliveries d
     JOIN webhooks w ON w.id=d.webhook_id WHERE w.project_key=$1 AND w.id=$2 ORDER BY d.created_at DESC LIMIT 50`,
    [req.params.key, num(req.params.id)]
  );
  res.json({
    deliveries: rows.map((d) => ({
      id: Number(d.id), event: d.event, attempt: d.attempt, status: d.status, error: d.error, durationMs: d.duration_ms,
      request: d.request, response: d.response, at: d.created_at.getTime(),
    })),
  });
}));

// Пробная отправка: пример события выбранного типа, ответ получателя — сразу в ответе
router.post("/webhooks/:id/test", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM webhooks WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: "Вебхук не найден" });
  const type = events.EVENTS[req.body.event] ? req.body.event : rows[0].events[0];
  const sample = {
    event: type, title: events.EVENTS[type], at: new Date().toISOString(), test: true,
    project: { key: req.params.key, name: "" }, actor: { login: req.user.login, name: req.user.name },
    bug: { id: `${req.params.key}-B1`, num: 1, title: "Пример: не работает вход", status: "new", severity: "critical", assignee: null, url: "" },
    run: { id: `${req.params.key}-R1`, num: 1, title: "Пример прогона", build: "1.0.0", state: "closed", counts: { total: 10, passed: 8, failed: 2, blocked: 0, skipped: 0, untested: 0 }, passRate: 80 },
    case: { id: `${req.params.key}-1`, num: 1, title: "Пример кейса", version: 2 },
    autorun: { id: `${req.params.key}-A1`, num: 1, title: "Пример запуска", branch: "main", state: "finished", counts: { total: 100, passed: 95, failed: 3, broken: 1, skipped: 1, flaky: 2 } },
  };
  res.json(await deliver(rows[0], sample));
}));

module.exports = { router, render, matches };
