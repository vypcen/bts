// Интеграционные тесты HTTP API на настоящем PostgreSQL. Сценарии из docs/API.md
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, seed, SETUP_CODE } = require("./helpers");

let srv, u;
test.before(async () => {
  srv = await startServer();
  u = await seed(srv);
});
test.after(async () => srv && (await srv.stop()));

test("установка: первый пользователь только с кодом, дальше роль developer", async () => {
  const fresh = await startServer();
  try {
    const c = client(fresh.base);
    let r = await c.get("/api/auth/me");
    assert.equal(r.data.setup, true);
    r = await c.post("/api/auth/register", { login: "first", name: "F", password: "password123", setupCode: "wrong" });
    assert.equal(r.status, 403);
    r = await c.post("/api/auth/register", { login: "first", name: "F", password: "password123", setupCode: SETUP_CODE });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.role, "admin");
    const c2 = client(fresh.base);
    r = await c2.post("/api/auth/register", { login: "second", name: "S", password: "password123" });
    assert.equal(r.data.user.role, "developer");
  } finally {
    await fresh.stop();
  }
});

test("вход: неверный пароль 401, без Content-Type 415, без сессии 401", async () => {
  const c = client(srv.base);
  assert.equal((await c.post("/api/auth/login", { login: "tester", password: "nope-nope" })).status, 401);
  const r = await fetch(srv.base + "/api/auth/login", { method: "POST", body: "login=tester" });
  assert.equal(r.status, 415);
  assert.equal((await c.get("/api/state")).status, 401);
});

test("доступ: чужой проект — 404, разработчик не меняет, но комментирует", async () => {
  assert.equal((await u.outsider.get("/api/projects/LK/plans")).status, 404);
  const st = await u.outsider.get("/api/state");
  assert.equal(st.data.projects.length, 0);
  let r = await u.dev.post("/api/projects/LK/cases", { title: "x", priority: "low", status: "draft" });
  assert.equal(r.status, 403);
  r = await u.tester.post("/api/projects/LK/cases", { title: "Комментируемый", priority: "low", status: "ready" });
  assert.equal(r.status, 201);
  r = await u.dev.post(`/api/projects/LK/cases/${r.data.num}/comments`, { text: "вопрос" });
  assert.equal(r.status, 201);
  r = await u.viewer.post("/api/projects/LK/cases/1/comments", { text: "нельзя" });
  assert.equal(r.status, 403);
});

test("кейсы: создание, частичное обновление, версии и защита от затирания", async () => {
  let r = await u.tester.post("/api/projects/LK/cases", { title: "Вход по паролю", priority: "high", status: "draft", steps: "Открыть\nВвести", expected: "Вошёл" });
  assert.equal(r.status, 201);
  const n = r.data.num;
  r = await u.tester.patch(`/api/projects/LK/cases/${n}`, { status: "ready", baseVersion: 1 });
  assert.equal(r.data.version, 2);
  r = await u.tester.patch(`/api/projects/LK/cases/${n}`, { title: "Затирание", baseVersion: 1 });
  assert.equal(r.status, 409);
  r = await u.tester.get(`/api/projects/LK/cases/${n}/versions`);
  assert.equal(r.data.versions.length, 2);
  r = await u.tester.post(`/api/projects/LK/cases/${n}/versions/1/restore`);
  assert.equal(r.data.version, 3);
  r = await u.tester.post("/api/projects/LK/cases", { title: "", priority: "high", status: "draft" });
  assert.equal(r.status, 400);
  r = await u.tester.post("/api/projects/LK/cases", { title: "x", priority: "urgent", status: "draft" });
  assert.equal(r.status, 400);
});

test("прогон: результаты, чек-лист по пунктам, закрытый прогон 409", async () => {
  const a = await u.tester.post("/api/projects/LK/cases", { title: "Кейс", priority: "medium", status: "ready", steps: "a" });
  const b = await u.tester.post("/api/projects/LK/cases", { kind: "checklist", title: "Смоук", priority: "medium", status: "ready", steps: "1. Вход\n2. Выход" });
  let r = await u.tester.post("/api/projects/LK/runs", { title: "Регресс", caseNums: [a.data.num, b.data.num, 9999] });
  assert.equal(r.status, 201);
  const run = r.data.num;
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${a.data.num}`, { result: "failed", comment: "упал" });
  assert.equal(r.status, 200);
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b.data.num}`, { result: "passed" });
  assert.equal(r.status, 400, "у чек-листа отмечаются пункты");
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b.data.num}`, { item: "Вход", result: "passed" });
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b.data.num}`, { item: "Нет такого", result: "passed" });
  assert.equal(r.status, 404);
  let st = await u.tester.get("/api/state");
  const res = (num) => st.data.results.find((x) => x.runNum === run && x.caseNum === num);
  assert.equal(res(a.data.num).result, "failed");
  assert.equal(res(b.data.num).result, "untested");
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b.data.num}`, { item: "Выход", result: "passed" });
  st = await u.tester.get("/api/state");
  assert.equal(res(b.data.num).result, "passed");
  await u.tester.patch(`/api/projects/LK/runs/${run}`, { state: "closed" });
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${a.data.num}`, { result: "passed" });
  assert.equal(r.status, 409);
});

test("баги: жизненный цикл и недопустимые переходы", async () => {
  let r = await u.tester.post("/api/projects/LK/bugs", { title: "Не входит", severity: "critical", assignee: "dev" });
  assert.equal(r.status, 201);
  const n = r.data.num;
  assert.equal((await u.tester.patch(`/api/projects/LK/bugs/${n}`, { status: "closed" })).status, 409);
  for (const s of ["in_progress", "fixed", "verified", "closed"]) assert.equal((await u.tester.patch(`/api/projects/LK/bugs/${n}`, { status: s })).status, 200, s);
  r = await u.tester.post("/api/projects/LK/bugs", { title: "Дубль", severity: "minor" });
  assert.equal((await u.tester.patch(`/api/projects/LK/bugs/${r.data.num}`, { status: "duplicate" })).status, 400);
  assert.equal((await u.tester.patch(`/api/projects/LK/bugs/${r.data.num}`, { status: "duplicate", duplicateOf: n })).status, 200);
  assert.equal((await u.tester.post("/api/projects/LK/bugs", { title: "x", severity: "minor", assignee: "outsider" })).status, 400);
});

test("CSV: пробный импорт ничего не пишет, ошибки по строкам, экспорт с BOM", async () => {
  const csv = "Название;Приоритет;Папка\nИмпорт 1;Высокий;Импорт / Вход\n;Низкий;\nИмпорт 2;Normal;\n";
  let r = await u.tester.post("/api/projects/LK/cases/import", { csv, dryRun: true });
  assert.equal(r.data.errorCount, 1);
  r = await u.tester.post("/api/projects/LK/cases/import", { csv, dryRun: false });
  assert.equal(r.status, 400, "при ошибке не импортируется ничего");
  r = await u.tester.post("/api/projects/LK/cases/import", { csv: "Название;Приоритет;Папка\nИмпорт 1;Высокий;Импорт / Вход\n" });
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.create, 1);
  const raw = await fetch(srv.base + "/api/projects/LK/cases/export", { headers: { cookie: u.tester.cookie } });
  const bytes = Buffer.from(await raw.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 с BOM для Excel");
  assert.match(bytes.toString("utf8"), /Импорт 1/);
});

test("токен: только отправка результатов автотестов", async () => {
  let r = await u.tester.post("/api/tokens", { name: "CI", project: "LK" });
  assert.equal(r.status, 201);
  const ci = client(srv.base, { token: r.data.token });
  assert.equal((await ci.get("/api/state")).status, 403);
  r = await ci.post("/api/projects/LK/autoruns", { title: "Смоук", build: "b1" });
  assert.equal(r.status, 201);
  const run = r.data.num;
  r = await ci.post(`/api/projects/LK/autoruns/${run}/results`, { results: [{ suite: "auth", name: "Вход", status: "failed", message: "нет кнопки" }, { name: "Выход", status: "passed" }] });
  assert.equal(r.data.ids.length, 2);
  assert.equal((await ci.get(`/api/projects/LK/autoruns/${run}`)).status, 403);
  assert.equal((await ci.patch(`/api/projects/LK/autoruns/${run}`, { state: "finished" })).status, 200);
  r = await u.tester.get(`/api/projects/LK/autoruns/${run}`);
  assert.equal(r.data.results.length, 2);
  assert.equal((await u.dev.post("/api/tokens", { name: "dev" })).status, 403);
});

test("тест-планы: динамический фильтр, блокировка, прогон по плану", async () => {
  let r = await u.tester.post("/api/projects/LK/plans", { title: "Высокий приоритет", mode: "dynamic", filter: { priorities: ["high"], statuses: ["ready", "draft"] } });
  assert.equal(r.status, 201);
  const p = r.data.num;
  r = await u.tester.get(`/api/projects/LK/plans/${p}/cases`);
  assert.ok(r.data.cases.length >= 1);
  assert.ok(r.data.cases.every((c) => c.priority === "high"));
  assert.equal((await u.tester.post(`/api/projects/LK/plans/${p}/lock`)).status, 200);
  assert.equal((await u.tester.del(`/api/projects/LK/plans/${p}`)).status, 409);
  r = await u.tester.post(`/api/projects/LK/plans/${p}/runs`, { title: "По плану" });
  assert.equal(r.status, 201);
});

test("администрирование: блокировка выкидывает из сессий, свою роль не поменять", async () => {
  const c = client(srv.base);
  await u.admin.post("/api/admin/users", { login: "temp", name: "T", password: "password123", role: "tester" });
  await c.post("/api/auth/login", { login: "temp", password: "password123" });
  assert.equal((await c.get("/api/state")).status, 200);
  await u.admin.patch("/api/admin/users/temp", { blocked: true });
  assert.equal((await c.get("/api/state")).status, 401);
  assert.equal((await u.admin.patch("/api/admin/users/admin", { role: "tester" })).status, 409);
  assert.equal((await u.tester.get("/api/admin/users")).status, 403);
});

test("служебное: проверки готовности и заголовки безопасности", async () => {
  const r = await fetch(srv.base + "/readyz");
  assert.equal(r.status, 200);
  const page = await fetch(srv.base + "/api/auth/me");
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
});
