// Исправления по итогам ручного тестирования демо-проекта (ноябрь 2026)
const test = require("node:test");
const assert = require("node:assert/strict");
const { netError } = require("../server/util");
const flaky = require("../server/flaky");
const { startServer, seed } = require("./helpers");

test("netError: понятный текст вместо «fetch failed»", () => {
  const e = (code, extra = {}) => Object.assign(new TypeError("fetch failed"), { cause: { code, ...extra } });
  assert.match(netError(e("ENOTFOUND", { hostname: "example.invalid" })), /DNS.*example\.invalid/);
  assert.match(netError(e("ECONNREFUSED")), /Соединение отклонено/);
  assert.match(netError(e("CERT_HAS_EXPIRED")), /просрочен/);
  assert.equal(netError(e("EWHATEVER")), "fetch failed (EWHATEVER)");
  assert.match(netError(Object.assign(new Error("x"), { name: "TimeoutError" })), /время ожидания/);
});

test("нестабильность: по двум запускам смена результата не даёт 100%", () => {
  const s = flaky.score([{ status: "failed" }, { status: "passed", flaky: true }]);
  assert.equal(s.flaky, true);
  assert.equal(s.score, 0.5);
});

let srv, u;
test.before(async () => { srv = await startServer(); u = await seed(srv); });
test.after(async () => srv && srv.stop());

test("слишком длинное название — 400, а не молчаливая обрезка", async () => {
  const long = "x".repeat(501);
  let r = await u.tester.post("/api/projects/LK/cases", { title: long, priority: "low", status: "draft" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /длиннее 500 символов/);
  r = await u.tester.post("/api/projects/LK/cases", { title: "x".repeat(500), priority: "low", status: "draft" });
  assert.equal(r.status, 201);
  assert.equal((await u.tester.post("/api/projects/LK/bugs", { title: long, severity: "minor" })).status, 400);
  assert.equal((await u.tester.post("/api/projects/LK/requirements", { title: long })).status, 400);
  assert.equal((await u.tester.post("/api/projects/LK/plans", { title: "x".repeat(301), mode: "static" })).status, 400);
  assert.equal((await u.tester.post("/api/projects/LK/runs", { title: "x".repeat(301), caseNums: [r.data.num] })).status, 400);
  assert.equal((await u.tester.post("/api/projects/LK/autoruns", { title: "x".repeat(301) })).status, 400);
});

test("в состоянии у ролей есть разрешения — по ним интерфейс выбирает исполнителей", async () => {
  const r = await u.admin.post("/api/admin/roles", { name: "Исполнитель", permissions: ["runs.execute", "comments"] });
  assert.equal(r.status, 201);
  const st = (await u.admin.get("/api/state")).data;
  assert.deepEqual(st.roles[r.data.key].permissions.sort(), ["comments", "runs.execute"]);
  assert.ok(st.roles.tester.permissions.includes("runs.execute"));
  assert.ok(!st.roles.developer.permissions.includes("runs.execute"));
});
