// Эксплуатация: метрики Prometheus, журнал в JSON, номер запроса
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, seed } = require("./helpers");

let srv;
test.before(async () => {
  srv = await startServer({ METRICS_TOKEN: "metrics-secret-123", LOG_FORMAT: "json", LOG_REQUESTS: "true" });
  await seed(srv);
});
test.after(async () => srv && srv.stop());

test("метрики: закрыты токеном, отдают HTTP, базу, пул и бизнес-показатели", async () => {
  assert.equal((await fetch(`${srv.base}/metrics`)).status, 401);
  assert.equal((await fetch(`${srv.base}/metrics`, { headers: { authorization: "Bearer wrong-token-xxx" } })).status, 401);
  const tester = client(srv.base);
  await tester.post("/api/auth/login", { login: "tester", password: "password123" });
  await tester.get("/api/projects/LK/state");
  await tester.get("/api/projects/LK/cases/999999");
  const r = await fetch(`${srv.base}/metrics`, { headers: { authorization: "Bearer metrics-secret-123" } });
  assert.equal(r.status, 200);
  const text = await r.text();
  const version = require("../package.json").version;
  assert.match(text, new RegExp(`testball_info\\{version="${version.replace(/\./g, "\\.")}"`));
  // маршрут без ключа проекта и номера — иначе у метрики будут тысячи вариантов
  assert.match(text, /testball_http_requests_total\{method="GET",route="\/api\/projects\/:key\/state",status="200"\} \d+/);
  assert.match(text, /route="\/api\/projects\/:key\/cases\/:num",status="404"/);
  assert.doesNotMatch(text, /route="[^"]*LK/);
  assert.match(text, /testball_db_query_duration_seconds_count \d+/);
  assert.match(text, /testball_db_pool_connections\{state="total"\} \d+/);
  assert.match(text, /testball_users\{state="active"\} [1-9]/);
  assert.match(text, /testball_projects 1/);
  assert.match(text, /testball_process_resident_memory_bytes \d+/);
});

test("номер запроса: возвращается в ответе, берётся из X-Request-Id прокси, попадает в журнал JSON", async () => {
  let r = await fetch(`${srv.base}/api/auth/me`);
  assert.match(r.headers.get("x-request-id"), /^[0-9a-f]{12}$/);
  r = await fetch(`${srv.base}/api/auth/me`, { headers: { "x-request-id": "proxy-req-0001" } });
  assert.equal(r.headers.get("x-request-id"), "proxy-req-0001");
  // мусор в заголовке не принимается
  r = await fetch(`${srv.base}/api/auth/me`, { headers: { "x-request-id": "a b<script>" } });
  assert.notEqual(r.headers.get("x-request-id"), "a b<script>");
  await new Promise((ok) => setTimeout(ok, 200));
  const lines = srv.log().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const req = lines.find((l) => l.component === "http" && l.reqId === "proxy-req-0001");
  assert.ok(req, "запрос в журнале");
  assert.equal(req.status, 200);
  assert.equal(req.level, "info");
  assert.ok(typeof req.ms === "number" && req.ts);
  // обычные сообщения сервера тоже в JSON, метка «[migrate]» стала полем component
  assert.ok(lines.some((l) => l.component === "migrate"));
  assert.ok(!srv.log().split("\n").some((l) => l.startsWith("[server]")), "в режиме json нет текстовых строк");
});
