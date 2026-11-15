// Метрики для Prometheus (GET /metrics) и журнал HTTP-запросов.
// /metrics закрыт токеном: METRICS_TOKEN=<случайная строка>, Prometheus передаёт его как Bearer.
// Без METRICS_TOKEN эндпоинт выключен (404) — чтобы метрики не оказались в интернете за обратным прокси.
//
// Номер запроса: берётся из X-Request-Id (если его поставил прокси) или создаётся, возвращается в ответе
// и попадает в журнал и в текст ошибки 500 — по нему поддержка находит запрос в логах.
const crypto = require("crypto");
const client = require("prom-client");
const pg = require("pg");
const log = require("./log");

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: "testball_" });

const httpRequests = new client.Counter({
  name: "testball_http_requests_total", help: "HTTP-запросы по методу, маршруту и коду ответа",
  labelNames: ["method", "route", "status"], registers: [register],
});
const httpDuration = new client.Histogram({
  name: "testball_http_request_duration_seconds", help: "Время ответа на HTTP-запрос",
  labelNames: ["method", "route"], buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [register],
});
const dbDuration = new client.Histogram({
  name: "testball_db_query_duration_seconds", help: "Время запроса к PostgreSQL",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [register],
});
const dbErrors = new client.Counter({ name: "testball_db_query_errors_total", help: "Ошибки запросов к PostgreSQL", registers: [register] });
const logErrors = new client.Counter({
  name: "testball_log_errors_total", help: "Записи уровня error и warn в журнале по компонентам",
  labelNames: ["level", "component"], registers: [register],
});
log.onWrite((level, component) => {
  if (level === "error" || level === "warn") logErrors.inc({ level, component: component || "server" });
});

// Медленные запросы к базе — в журнал (SLOW_QUERY_MS, по умолчанию 1000 мс; 0 — не писать)
const SLOW_MS = Number(process.env.SLOW_QUERY_MS ?? 1000);
const sqlText = (q) => String(typeof q === "string" ? q : q?.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
function observe(start, query, failed) {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  dbDuration.observe(ms / 1000);
  if (failed) dbErrors.inc();
  if (SLOW_MS > 0 && ms >= SLOW_MS) log.warn("db", "медленный запрос", { ms: Math.round(ms), sql: sqlText(query) });
}
// Замер всех запросов: и pool.query, и запросов внутри транзакций идут через Client.prototype.query
if (!pg.Client.prototype.query.__timed) {
  const orig = pg.Client.prototype.query;
  pg.Client.prototype.query = function (config, values, callback) {
    // курсоры и потоки (объекты с submit) не трогаем
    if (config && typeof config.submit === "function") return orig.apply(this, arguments);
    const start = process.hrtime.bigint();
    const cb = typeof values === "function" ? values : typeof callback === "function" ? callback : null;
    if (cb) {
      const wrapped = (err, res) => {
        observe(start, config, !!err);
        cb(err, res);
      };
      return typeof values === "function" ? orig.call(this, config, wrapped) : orig.call(this, config, values, wrapped);
    }
    const p = orig.apply(this, arguments);
    if (p && typeof p.then === "function") p.then(() => observe(start, config, false), () => observe(start, config, true));
    return p;
  };
  pg.Client.prototype.query.__timed = true;
}

// Метрики, которые снимаются в момент запроса Prometheus
function gauges({ pool, live, version }) {
  new client.Gauge({
    name: "testball_info", help: "Версия и сборка", labelNames: ["version", "commit"], registers: [register],
    collect() { this.reset(); this.set({ version: version.VERSION, commit: version.COMMIT || "" }, 1); },
  });
  new client.Gauge({
    name: "testball_db_pool_connections", help: "Соединения пула PostgreSQL: всего, свободные, ожидающие запросы",
    labelNames: ["state"], registers: [register],
    collect() {
      this.set({ state: "total" }, pool.totalCount);
      this.set({ state: "idle" }, pool.idleCount);
      this.set({ state: "waiting" }, pool.waitingCount);
    },
  });
  new client.Gauge({
    name: "testball_live_clients", help: "Открытые потоки живых обновлений (вкладки браузера)", registers: [register],
    collect() { this.set(live.clientCount()); },
  });
  // данные из базы — не чаще раза в минуту, чтобы частый опрос не нагружал базу
  let cached = null;
  let at = 0;
  const fromDb = async () => {
    if (cached && Date.now() - at < 60000) return cached;
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM users WHERE NOT blocked)::int AS active, (SELECT count(*) FROM users WHERE blocked)::int AS blocked,
              (SELECT count(*) FROM projects WHERE deleted_at IS NULL)::int AS projects,
              (SELECT count(*) FROM sessions WHERE expires_at > now())::int AS sessions,
              (SELECT count(*) FROM webhook_deliveries WHERE (status IS NULL OR status >= 400) AND created_at > now() - interval '1 hour')::int AS hooks_failed`
    );
    cached = rows[0];
    at = Date.now();
    return cached;
  };
  new client.Gauge({
    name: "testball_users", help: "Пользователи", labelNames: ["state"], registers: [register],
    async collect() { const d = await fromDb(); this.set({ state: "active" }, d.active); this.set({ state: "blocked" }, d.blocked); },
  });
  new client.Gauge({ name: "testball_projects", help: "Проекты", registers: [register], async collect() { this.set((await fromDb()).projects); } });
  new client.Gauge({ name: "testball_sessions", help: "Действующие сессии", registers: [register], async collect() { this.set((await fromDb()).sessions); } });
  new client.Gauge({
    name: "testball_webhook_failed_last_hour", help: "Неудачные доставки вебхуков за последний час", registers: [register],
    async collect() { this.set((await fromDb()).hooks_failed); },
  });
}

// Маршрут без идентификаторов, чтобы у метрик не было тысяч вариантов меток: /api/projects/:key/cases/:num
function routeOf(req) {
  if (req.route?.path) {
    const base = (req.baseUrl || "").replace(/^\/api\/projects\/[^/]+/, "/api/projects/:key");
    const p = typeof req.route.path === "string" ? req.route.path.replace(/\(\\\\d\+\)/g, "").replace(/\(\\d\+\)/g, "") : "regexp";
    return (base + p).replace(/\/$/, "") || "/";
  }
  if (!req.originalUrl.startsWith("/api/")) return "static";
  return "unmatched";
}

const QUIET = /^\/(livez|readyz|healthz|metrics)$|^\/api\/events$/;
const REQ_ID = /^[\w.-]{6,100}$/;

function middleware() {
  return (req, res, next) => {
    const incoming = req.get("x-request-id");
    req.id = incoming && REQ_ID.test(incoming) ? incoming : crypto.randomBytes(6).toString("hex");
    res.set("X-Request-Id", req.id);
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      if (QUIET.test(req.path)) return;
      const route = routeOf(req);
      const sec = Number(process.hrtime.bigint() - start) / 1e9;
      httpRequests.inc({ method: req.method, route, status: res.statusCode });
      httpDuration.observe({ method: req.method, route }, sec);
      if (log.REQUESTS && route !== "static") {
        log.info("http", `${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode}`, {
          reqId: req.id, ms: Math.round(sec * 1000), status: res.statusCode, user: req.user?.login || null, ip: req.ip,
          ...(req.viaToken ? { token: true } : {}),
        });
      }
    });
    next();
  };
}

// GET /metrics: только с METRICS_TOKEN (заголовок Authorization: Bearer <токен>)
function handler() {
  const token = process.env.METRICS_TOKEN || "";
  return async (req, res) => {
    if (!token) return res.status(404).end();
    const got = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const ok = got.length === token.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
    if (!ok) return res.status(401).set("WWW-Authenticate", "Bearer").end();
    try {
      res.set("Content-Type", register.contentType).send(await register.metrics());
    } catch (e) {
      log.error("metrics", "не удалось собрать метрики", { err: e.message });
      res.status(500).end();
    }
  };
}

module.exports = { middleware, handler, gauges, register, routeOf };
