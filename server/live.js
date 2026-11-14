// Живые обновления (Server-Sent Events): клиенты получают сигнал «данные изменились» и перечитывают состояние.
// Сигнал идёт через PostgreSQL LISTEN/NOTIFY: при нескольких репликах приложения (Kubernetes) изменение,
// сделанное на одной, видят клиенты всех остальных. Если слушатель не подключён, сигнал рассылается локально.
const { Client } = require("pg");
const { pool } = require("./db");

const CHANNEL = "testball_live";
const clients = new Set();
// Вкладок у человека бывает несколько, но не сотни: каждое соединение держит ресурсы сервера
const MAX_PER_USER = 20;
const perUser = new Map();
let listening = false;

function deliver(type) {
  const msg = `event: change\ndata: ${JSON.stringify({ type, at: Date.now() })}\n\n`;
  for (const res of clients) res.write(msg);
}

function broadcast(type) {
  if (!listening) return deliver(type);
  pool.query("SELECT pg_notify($1, $2)", [CHANNEL, String(type).slice(0, 100)]).catch((e) => {
    console.error("[live] pg_notify не прошёл:", e.message);
    deliver(type);
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

module.exports = { broadcast, events, listen, closeAll };
