// Живые обновления (Server-Sent Events): клиенты получают сигнал «данные изменились» и перечитывают состояние.
// Сигнал несёт тип и проект ({type, pid}): клиент перечитывает только открытый проект, а не всё подряд,
// и получает сигналы только о проектах, к которым у него есть доступ. Проект берётся из запроса
// (/api/projects/:key/...) сам — через AsyncLocalStorage, поэтому обработчикам достаточно вызвать broadcast(type).
// Сигнал идёт через PostgreSQL LISTEN/NOTIFY: при нескольких репликах приложения (Kubernetes) изменение,
// сделанное на одной, видят клиенты всех остальных. Если слушатель не подключён, сигнал рассылается локально.
const { AsyncLocalStorage } = require("node:async_hooks");
const { Client } = require("pg");
const { pool } = require("./db");
const access = require("./access");

// Контекст запроса: проект, в котором идёт изменение
const context = new AsyncLocalStorage();
const inProject = (req, _res, next) => context.run({ pid: req.params.key }, next);

const CHANNEL = "testball_live";
const clients = new Set();
// Вкладок у человека бывает несколько, но не сотни: каждое соединение держит ресурсы сервера
const MAX_PER_USER = 20;
const perUser = new Map();
let listening = false;

// Типы, после которых меняется круг доступных проектов
const ACCESS_TYPES = new Set(["users", "projects"]);

function deliver(payload) {
  let type, pid;
  try {
    ({ type, pid = null } = JSON.parse(payload));
  } catch {
    type = String(payload);
    pid = null;
  }
  const msg = `event: change\ndata: ${JSON.stringify({ type, pid, at: Date.now() })}\n\n`;
  for (const res of clients) {
    const keys = res.tbKeys; // null — все проекты (админ)
    if (pid && keys && !keys.has(pid)) continue;
    res.write(msg);
    if (ACCESS_TYPES.has(type)) refreshKeys(res);
  }
}

// Роль и проекты могли поменяться, пока вкладка открыта; заблокированному — закрываем поток
async function refreshKeys(res) {
  try {
    const { rows } = await pool.query("SELECT role, blocked FROM users WHERE id=$1", [res.tbUser.id]);
    if (!rows[0] || rows[0].blocked) return res.end();
    res.tbUser = { ...res.tbUser, role: rows[0].role };
    const keys = await access.projectKeys(res.tbUser);
    res.tbKeys = keys ? new Set(keys) : null;
  } catch {}
}

function broadcast(type, pid = context.getStore()?.pid ?? null) {
  const payload = JSON.stringify({ type: String(type).slice(0, 50), pid });
  if (!listening) return deliver(payload);
  pool.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]).catch((e) => {
    console.error("[live] pg_notify не прошёл:", e.message);
    deliver(payload);
  });
}

// Отдельное соединение под LISTEN: соединения пула выдаются запросам и не годятся для подписки
async function listen() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  const retry = () => {
    listening = false;
    setTimeout(() => listen().catch(() => {}), 5000).unref();
  };
  c.on("error", (e) => {
    console.error("[live] соединение LISTEN оборвалось:", e.message);
    c.end().catch(() => {});
    retry();
  });
  try {
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
  } catch (e) {
    console.error("[live] не удалось подписаться на изменения:", e.message);
    c.end().catch(() => {});
    return retry();
  }
  c.on("notification", (n) => deliver(n.payload));
  listening = true;
}

function events(req, res) {
  const id = req.user.id;
  if ((perUser.get(id) || 0) >= MAX_PER_USER) return res.status(429).json({ error: "Слишком много открытых вкладок" });
  perUser.set(id, (perUser.get(id) || 0) + 1);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  res.tbUser = req.user;
  res.tbKeys = new Set(); // до ответа базы — только общие сигналы
  refreshKeys(res);
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
    const n = perUser.get(id) - 1;
    if (n > 0) perUser.set(id, n);
    else perUser.delete(id);
  });
}

// При остановке (SIGTERM в Kubernetes) закрываем потоки: браузеры переподключатся к другой реплике
function closeAll() {
  for (const res of clients) res.end();
  clients.clear();
}

module.exports = { broadcast, events, listen, closeAll, inProject, context };
