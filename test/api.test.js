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
  assert.equal((await u.outsider.get("/api/projects/LK/state")).status, 404);
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
  let st = await u.tester.get(`/api/projects/LK/runs/${run}/results`);
  const res = (num) => st.data.results.find((x) => x.runNum === run && x.caseNum === num);
  assert.equal(res(a.data.num).result, "failed");
  assert.equal(res(b.data.num).result, "untested");
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${b.data.num}`, { item: "Выход", result: "passed" });
  st = await u.tester.get(`/api/projects/LK/runs/${run}/results`);
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

test("публичный API: права токена read/write, /api/v1, срок действия", async () => {
  // наблюдателю доступен только токен на чтение
  assert.equal((await u.viewer.post("/api/tokens", { name: "v", project: "LK" })).status, 403);
  let r = await u.viewer.post("/api/tokens", { name: "v", project: "LK", scopes: ["read"] });
  assert.equal(r.status, 201);
  const ro = client(srv.base, { token: r.data.token });
  assert.equal((await ro.get("/api/v1/projects/LK/state")).status, 200);
  assert.equal((await ro.get("/api/v1/projects/LK/cases")).status, 200);
  assert.equal((await ro.post("/api/v1/projects/LK/cases", { title: "x" })).status, 403);
  assert.equal((await ro.get("/api/v1/tokens")).status, 403, "токенами токен не управляет");
  assert.equal((await u.tester.post("/api/tokens", { name: "bad", scopes: ["root"] })).status, 400);
  // write-токен тестировщика может создавать кейсы, но только в своём проекте
  r = await u.tester.post("/api/tokens", { name: "sync", project: "LK", scopes: ["read", "write"] });
  const rw = client(srv.base, { token: r.data.token });
  r = await rw.post("/api/v1/projects/LK/cases", { title: "Создан по API", priority: "low", status: "draft" });
  assert.equal(r.status, 201);
  assert.equal((await rw.get("/api/v1/admin/users")).status, 403);
  r = await u.tester.get("/api/tokens");
  assert.deepEqual(r.data.tokens.find((t) => t.name === "sync").scopes, ["read", "write"]);
  // истёкший токен не работает
  r = await u.tester.post("/api/tokens", { name: "old", scopes: ["read"], expiresDays: 1 });
  const old = client(srv.base, { token: r.data.token });
  assert.equal((await old.get("/api/v1/state")).status, 200);
  const { Client } = require("pg");
  const pg = new Client({ connectionString: srv.dbUrl });
  await pg.connect();
  await pg.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE name='old'");
  await pg.end();
  assert.equal((await old.get("/api/v1/state")).status, 401);
});

test("версия: в /api/auth/me и сведения о системе для админа", async () => {
  const v = require("../package.json").version;
  assert.equal((await u.tester.get("/api/auth/me")).data.user.version, v);
  assert.equal((await u.tester.get("/api/admin/system")).status, 403);
  const r = await u.admin.get("/api/admin/system");
  assert.equal(r.data.version, v);
  assert.ok(r.data.migrations.count >= 18);
  assert.equal(r.data.history[0].version, v);
});

test("лицензия: бесплатная редакция ограничивает полные места, ключ их расширяет", async () => {
  const license = require("../server/license");
  const pem = require("node:fs").readFileSync(require("node:path").join(__dirname, "fixtures", "license-test-private.pem"), "utf8");
  let r = await u.admin.get("/api/admin/license");
  assert.equal(r.data.status, "none");
  assert.equal(r.data.full, license.COMMUNITY.full);
  assert.equal((await u.tester.get("/api/admin/license")).status, 403);
  // занимаем все бесплатные полные места
  const used = r.data.seats.full.used;
  for (let i = used; i < license.COMMUNITY.full; i++) {
    assert.equal((await u.admin.post("/api/admin/users", { login: `lic${i}`, name: "L", password: "password123", role: "tester" })).status, 201);
  }
  r = await u.admin.post("/api/admin/users", { login: "licx", name: "L", password: "password123", role: "tester" });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /полные лицензии заняты/);
  // просмотровые места без ограничений
  assert.equal((await u.admin.post("/api/admin/users", { login: "licv", name: "V", password: "password123", role: "viewer" })).status, 201);
  // поддельный ключ не принимается
  assert.equal((await u.admin.put("/api/admin/license", { key: "TB1.e30.AAAA" })).status, 400);
  const key = license.sign({ id: "T-2", customer: "ООО Тест", edition: "enterprise", full: 50, view: null, issued: "2026-01-01", expires: null }, pem);
  r = await u.admin.put("/api/admin/license", { key });
  assert.equal(r.status, 200);
  assert.equal(r.data.full, 50);
  assert.equal(r.data.license.customer, "ООО Тест");
  assert.match((await u.admin.get("/api/auth/me")).data.user.licenseNotice, /Тестовая лицензия/);
  assert.equal((await u.admin.post("/api/admin/users", { login: "licx", name: "L", password: "password123", role: "tester" })).status, 201);
  r = await u.admin.get("/api/admin/audit?action=settings.license");
  assert.ok(r.data.items.length >= 1);
  // вернуться к бесплатной: новых полных мест нет, но существующих не выкидывает
  r = await u.admin.del("/api/admin/license");
  assert.equal(r.data.status, "none");
  assert.equal((await u.tester.get("/api/auth/me")).status, 200);
  for (const login of ["licx", ...Array.from({ length: license.COMMUNITY.full }, (_, i) => `lic${i}`)]) await u.admin.del(`/api/admin/users/${login}`);
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

test("состояние: общее без данных проектов, проект — отдельно, сводка и история", async () => {
  const k = await u.tester.post("/api/projects/LK/cases", { title: "История", priority: "low", status: "ready" });
  const r1 = await u.tester.post("/api/projects/LK/runs", { title: "R1", caseNums: [k.data.num] });
  await u.tester.patch(`/api/projects/LK/runs/${r1.data.num}/results/${k.data.num}`, { result: "failed" });
  const r2 = await u.tester.post("/api/projects/LK/runs", { title: "R2", caseNums: [k.data.num] });
  await u.tester.patch(`/api/projects/LK/runs/${r2.data.num}/results/${k.data.num}`, { result: "passed" });

  const meta = await u.tester.get("/api/state");
  assert.equal(meta.data.cases, undefined, "общее состояние не тащит кейсы");
  const lk = meta.data.projects.find((p) => p.id === "LK");
  assert.ok(lk.stats.cases >= 1 && lk.stats.last.passed >= 1);

  const ps = await u.tester.get("/api/projects/LK/state");
  const last = ps.data.results.filter((r) => r.caseNum === k.data.num);
  assert.equal(last.length, 1, "в состоянии проекта только последний результат кейса");
  assert.equal(last[0].result, "passed");
  const run2 = ps.data.runs.find((r) => r.num === r2.data.num);
  assert.equal(run2.counts.passed, 1);

  const rr = await u.tester.get(`/api/projects/LK/runs/${r2.data.num}/results`);
  assert.equal(rr.data.previous.find((r) => r.caseNum === k.data.num).result, "failed");
  const h = await u.tester.get(`/api/projects/LK/cases/${k.data.num}/history`);
  assert.deepEqual(h.data.results.map((r) => r.result), ["passed", "failed"]);

  // ETag: повторный запрос без изменений — 304
  const raw = await fetch(srv.base + "/api/projects/LK/state", { headers: { cookie: u.tester.cookie } });
  const etag = raw.headers.get("etag");
  // fetch сам помечает условные запросы как no-cache, поэтому — через http, как браузер с кэшем
  const status = await new Promise((resolve, reject) =>
    require("node:http").get(srv.base + "/api/projects/LK/state", { headers: { cookie: u.tester.cookie, "if-none-match": etag } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject)
  );
  assert.equal(status, 304);
});

test("живые события: несут проект и не приходят о чужих проектах", async () => {
  await u.admin.post("/api/projects", { key: "XX", name: "Чужой" });
  const ctrl = new AbortController();
  const got = [];
  const r = await fetch(srv.base + "/api/events", { headers: { cookie: u.tester.cookie }, signal: ctrl.signal });
  const reader = r.body.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      for (const m of dec.decode(value).matchAll(/data: (\{.*\})/g)) got.push(JSON.parse(m[1]));
    }
  })();
  await new Promise((res) => setTimeout(res, 400));
  await u.admin.post("/api/projects/XX/cases", { title: "секрет", priority: "low", status: "ready" });
  await u.tester.post("/api/projects/LK/cases", { title: "наш", priority: "low", status: "ready" });
  await new Promise((res) => setTimeout(res, 600));
  ctrl.abort();
  await pump;
  assert.ok(got.some((e) => e.type === "cases" && e.pid === "LK"));
  assert.ok(!got.some((e) => e.pid === "XX"), "о чужом проекте сигналов нет");
});

test("списки: постраничная выдача, фильтры, поиск с морфологией и по ID", async () => {
  for (let i = 1; i <= 7; i++) await u.tester.post("/api/projects/LK/cases", { title: `Оплата картой ${i}`, priority: i % 2 ? "high" : "low", status: "ready", steps: "Ввести номер карты" });
  await u.tester.post("/api/projects/LK/cases", { title: "Восстановление пароля", priority: "low", status: "draft" });
  let r = await u.tester.get("/api/projects/LK/cases?q=" + encodeURIComponent("оплаты") + "&limit=3&count=1");
  assert.equal(r.data.items.length, 3);
  assert.equal(r.data.total, 7, "«оплаты» находит «Оплата» — русская морфология");
  const second = await u.tester.get(`/api/projects/LK/cases?q=${encodeURIComponent("оплаты")}&limit=3&after=${r.data.next}`);
  assert.equal(second.data.items.length, 3);
  assert.ok(second.data.items[0].num > r.data.items[2].num);
  r = await u.tester.get("/api/projects/LK/cases?q=" + encodeURIComponent("карты") + "&priority=high&count=1");
  assert.equal(r.data.total, 4, "поиск по шагам и фильтр по приоритету");
  const one = r.data.items[0];
  r = await u.tester.get(`/api/projects/LK/cases?q=LK-${one.num}`);
  assert.equal(r.data.items[0].num, one.num);

  await u.tester.post("/api/projects/LK/bugs", { title: "Ошибка при оплате картой", severity: "major" });
  r = await u.tester.get("/api/projects/LK/bugs?q=" + encodeURIComponent("оплата") + "&status=new");
  assert.ok(r.data.items.some((b) => /оплате/.test(b.title)));
  r = await u.tester.get("/api/projects/LK/runs?state=closed");
  assert.ok(r.data.items.every((x) => x.state === "closed"));

  r = await u.tester.get("/api/search?q=" + encodeURIComponent("оплата"));
  assert.ok(r.data.cases.length >= 1 && r.data.bugs.length >= 1);
  r = await u.outsider.get("/api/search?q=" + encodeURIComponent("оплата"));
  assert.equal(r.data.cases.length, 0, "чужие проекты в поиске не видны");
  r = await u.tester.get(`/api/search?q=LK-${one.num}`);
  assert.equal(r.data.cases[0].num, one.num);
});

test("корзина: кейс, прогон и баг восстанавливаются с результатами, комментариями и номерами", async () => {
  const k = await u.tester.post("/api/projects/LK/cases", { title: "В корзину", priority: "low", status: "ready", steps: "шаг" });
  const run = await u.tester.post("/api/projects/LK/runs", { title: "Прогон для корзины", caseNums: [k.data.num] });
  await u.tester.patch(`/api/projects/LK/runs/${run.data.num}/results/${k.data.num}`, { result: "failed", comment: "упал" });
  const bug = await u.tester.post("/api/projects/LK/bugs", { title: "Баг кейса", severity: "minor", caseNum: k.data.num, runNum: run.data.num });
  await u.dev.post(`/api/projects/LK/cases/${k.data.num}/comments`, { text: "заметка" });
  await u.tester.patch(`/api/projects/LK/cases/${k.data.num}`, { title: "В корзину v2" });

  let r = await u.tester.del(`/api/projects/LK/cases/${k.data.num}`);
  assert.equal(r.status, 200);
  assert.equal((await u.tester.get(`/api/projects/LK/cases/${k.data.num}`)).status, 404);
  let ps = await u.tester.get("/api/projects/LK/state");
  assert.equal(ps.data.bugs.find((b) => b.num === bug.data.num).caseNum, null, "ссылка бага на кейс снята");

  const trash = await u.tester.get("/api/projects/LK/trash");
  const item = trash.data.items.find((i) => i.ref === `LK-${k.data.num}`);
  assert.ok(item);
  assert.equal((await u.dev.post(`/api/projects/LK/trash/${item.id}/restore`)).status, 403);
  r = await u.tester.post(`/api/projects/LK/trash/${item.id}/restore`);
  assert.equal(r.status, 200);

  const full = await u.tester.get(`/api/projects/LK/cases/${k.data.num}`);
  assert.equal(full.data.title, "В корзину v2");
  assert.equal(full.data.steps, "шаг");
  assert.equal((await u.tester.get(`/api/projects/LK/cases/${k.data.num}/versions`)).data.versions.length, 2);
  const rr = await u.tester.get(`/api/projects/LK/runs/${run.data.num}/results`);
  assert.equal(rr.data.results.find((x) => x.caseNum === k.data.num).comment, "упал");
  ps = await u.tester.get("/api/projects/LK/state");
  assert.equal(ps.data.bugs.find((b) => b.num === bug.data.num).caseNum, k.data.num, "ссылка бага вернулась");
  assert.ok(ps.data.comments.some((c) => c.caseNum === k.data.num && c.text === "заметка"));
  assert.equal(ps.data.results.find((x) => x.caseNum === k.data.num).result, "failed", "последний результат пересчитан");

  // баг и прогон
  await u.tester.del(`/api/projects/LK/bugs/${bug.data.num}`);
  await u.tester.del(`/api/projects/LK/runs/${run.data.num}`);
  const t2 = (await u.tester.get("/api/projects/LK/trash")).data.items;
  for (const ref of [`LK-B${bug.data.num}`, `LK-R${run.data.num}`]) {
    const it = t2.find((i) => i.ref === ref);
    assert.equal((await u.tester.post(`/api/projects/LK/trash/${it.id}/restore`)).status, 200, ref);
  }
  ps = await u.tester.get("/api/projects/LK/state");
  const back = ps.data.bugs.find((b) => b.num === bug.data.num);
  assert.equal(back.runNum, run.data.num, "баг снова ссылается на результат прогона");
  assert.equal((await u.tester.del(`/api/projects/LK/trash/1`)).status, 403, "навсегда удаляет только админ");
});

test("проект: удаляет только админ с подтверждением, проект исчезает и восстанавливается", async () => {
  await u.admin.post("/api/projects", { key: "DEL", name: "Удаляемый" });
  await u.admin.put("/api/admin/users/tester/projects", { projects: ["LK", "DEL"] });
  assert.equal((await u.tester.del("/api/projects/DEL", { confirm: "DEL" })).status, 403);
  assert.equal((await u.admin.del("/api/projects/DEL", {})).status, 400);
  assert.equal((await u.admin.del("/api/projects/DEL", { confirm: "DEL" })).status, 200);
  assert.equal((await u.tester.get("/api/projects/DEL/state")).status, 404);
  assert.equal((await u.admin.get("/api/projects/DEL/state")).status, 404, "и админу тоже");
  assert.ok(!(await u.admin.get("/api/state")).data.projects.some((p) => p.id === "DEL"));
  const r = await u.admin.post("/api/projects", { key: "DEL", name: "Новый" });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /корзин/);
  const list = await u.admin.get("/api/admin/trash/projects");
  assert.ok(list.data.items.some((p) => p.key === "DEL"));
  assert.equal((await u.admin.post("/api/admin/projects/DEL/restore")).status, 200);
  assert.equal((await u.tester.get("/api/projects/DEL/state")).status, 200);
  await u.admin.put("/api/admin/users/tester/projects", { projects: ["LK"] });
});

test("журнал аудита: входы, неудачи, роли и удаления; фильтр и CSV; только админ", async () => {
  await client(srv.base).post("/api/auth/login", { login: "dev", password: "wrong-pass" });
  await u.admin.patch("/api/admin/users/viewer", { role: "developer" });
  const k = await u.tester.post("/api/projects/LK/cases", { title: "Для аудита", priority: "low", status: "ready" });
  await u.tester.del(`/api/projects/LK/cases/${k.data.num}`);
  await new Promise((r) => setTimeout(r, 200));
  let r = await u.admin.get("/api/admin/audit?limit=200");
  const acts = r.data.items.map((e) => e.action);
  for (const a of ["auth.login", "auth.login_failed", "user.update", "case.delete", "user.projects"]) assert.ok(acts.includes(a), a);
  const failed = r.data.items.find((e) => e.action === "auth.login_failed" && e.target === "dev");
  assert.ok(failed, "неудачный вход виден с логином");
  r = await u.admin.get("/api/admin/audit?action=case.&project=LK");
  assert.ok(r.data.items.every((e) => e.action.startsWith("case.") && e.project === "LK"));
  assert.equal(r.data.items[0].actor, "tester");
  const csv = await fetch(srv.base + "/api/admin/audit.csv?actor=tester", { headers: { cookie: u.admin.cookie } });
  assert.match(await csv.text(), /Тест-кейс удалён в корзину/);
  assert.equal((await u.tester.get("/api/admin/audit")).status, 403);
  await u.admin.patch("/api/admin/users/viewer", { role: "viewer" });
});

test("структурные шаги: создание, правка текстом сохраняет ожидаемые результаты, версии", async () => {
  const stepList = [
    { action: "Открыть страницу входа", expected: "Форма входа" },
    { action: "Ввести логин и пароль", expected: "", data: "user / secret" },
    { action: "Нажать «Войти»", expected: "Открылся профиль" },
  ];
  let r = await u.tester.post("/api/projects/LK/cases", { title: "Структурные шаги", priority: "high", status: "ready", stepList, tags: ["smoke", "Вход", "smoke"] });
  const n = r.data.num;
  let c = (await u.tester.get(`/api/projects/LK/cases/${n}`)).data;
  assert.equal(c.stepList.length, 3);
  assert.equal(c.stepList[1].data, "user / secret");
  assert.equal(c.steps, "Открыть страницу входа\nВвести логин и пароль\nНажать «Войти»");
  assert.deepEqual(c.tags, ["smoke", "Вход"]);
  // старый клиент шлёт steps текстом с теми же действиями — ожидаемые результаты шагов не теряются
  await u.tester.patch(`/api/projects/LK/cases/${n}`, { steps: c.steps, title: "Структурные шаги v2" });
  c = (await u.tester.get(`/api/projects/LK/cases/${n}`)).data;
  assert.equal(c.stepList[2].expected, "Открылся профиль");
  // правка без шагов не трогает шаги
  await u.tester.patch(`/api/projects/LK/cases/${n}`, { priority: "low" });
  c = (await u.tester.get(`/api/projects/LK/cases/${n}`)).data;
  assert.equal(c.stepList.length, 3);
  const v = (await u.tester.get(`/api/projects/LK/cases/${n}/versions`)).data.versions;
  assert.equal(v[v.length - 1].stepList[0].expected, "Форма входа");
  // теги — тоже содержимое: версия растёт
  r = await u.tester.patch(`/api/projects/LK/cases/${n}`, { tags: ["regress"] });
  assert.equal(r.data.version, 4);
});

test("результат по шагам: итог считается сам, вложение к шагу, баг-фильтры по тегам", async () => {
  const k = await u.tester.post("/api/projects/LK/cases", { title: "По шагам", priority: "low", status: "ready", stepList: [{ action: "a" }, { action: "b" }, { action: "c" }], tags: ["шаги"] });
  const run = (await u.tester.post("/api/projects/LK/runs", { title: "Шаги", caseNums: [k.data.num] })).data.num;
  const mark = (body) => u.tester.patch(`/api/projects/LK/runs/${run}/results/${k.data.num}`, body);
  const res = async () => (await u.tester.get(`/api/projects/LK/runs/${run}/results`)).data.results[0];
  await mark({ step: 0, result: "passed" });
  assert.equal((await res()).result, "untested");
  await mark({ step: 1, result: "failed", actual: "кнопки нет" });
  let r = await res();
  assert.equal(r.result, "failed");
  assert.deepEqual(r.steps["1"], { result: "failed", actual: "кнопки нет" });
  await mark({ step: 1, result: "passed" });
  await mark({ step: 2, result: "passed" });
  r = await res();
  assert.equal(r.result, "passed");
  assert.equal(r.steps["1"].actual, "кнопки нет", "фактический результат шага сохраняется");
  assert.equal((await mark({ step: 7, result: "passed" })).status, 404);
  // можно и без шагов — итог целиком
  assert.equal((await mark({ result: "blocked" })).status, 200);
  // вложение к шагу
  const up = await fetch(`${srv.base}/api/projects/LK/runs/${run}/results/${k.data.num}/attachments?step=1`, {
    method: "POST", headers: { cookie: u.tester.cookie, "x-upload": "1", "content-type": "image/png", "x-filename": "step.png" }, body: Buffer.from("png"),
  });
  assert.equal(up.status, 201);
  const files = (await u.tester.get(`/api/projects/LK/runs/${run}/results`)).data.attachments;
  assert.equal(files.find((f) => f.name === "step.png").step, 1);

  const list = await u.tester.get("/api/projects/LK/cases?tag=" + encodeURIComponent("шаги") + "&count=1");
  assert.equal(list.data.total, 1);
  const plan = await u.tester.post("/api/projects/LK/plans", { title: "По тегу", mode: "dynamic", filter: { tags: ["шаги"] } });
  assert.equal((await u.tester.get(`/api/projects/LK/plans/${plan.data.num}/cases`)).data.cases.length, 1);
  const bug = await u.tester.post("/api/projects/LK/bugs", { title: "С тегом", severity: "minor", tags: ["ui"] });
  assert.equal((await u.tester.get("/api/projects/LK/bugs?tag=ui")).data.items[0].num, bug.data.num);
});

test("пользовательские поля: настройка, проверка значений, обязательность, фильтр", async () => {
  assert.equal((await u.dev.post("/api/projects/LK/fields", { entity: "case", name: "x", type: "text" })).status, 403);
  let r = await u.tester.post("/api/projects/LK/fields", { entity: "case", name: "Компонент", type: "select", options: ["Оплата", "Вход"] });
  assert.equal(r.status, 201);
  const comp = r.data.id;
  const story = (await u.tester.post("/api/projects/LK/fields", { entity: "case", name: "История", type: "url" })).data.id;
  const sp = (await u.tester.post("/api/projects/LK/fields", { entity: "bug", name: "Оценка", type: "number", required: true })).data.id;
  assert.equal((await u.tester.post("/api/projects/LK/fields", { entity: "case", name: "Компонент", type: "text" })).status, 409);

  r = await u.tester.post("/api/projects/LK/cases", { title: "С полями", priority: "low", status: "ready", fields: { [comp]: "Доставка" } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /нет варианта/);
  r = await u.tester.post("/api/projects/LK/cases", { title: "С полями", priority: "low", status: "ready", fields: { [comp]: "Оплата", [story]: "ftp://x" } });
  assert.equal(r.status, 400);
  r = await u.tester.post("/api/projects/LK/cases", { title: "С полями", priority: "low", status: "ready", fields: { [comp]: "Оплата", [story]: "https://jira/PAY-1" } });
  assert.equal(r.status, 201);
  const n = r.data.num;
  await u.tester.patch(`/api/projects/LK/cases/${n}`, { title: "С полями v2" });
  const c = (await u.tester.get(`/api/projects/LK/cases/${n}`)).data;
  assert.equal(c.fields[comp], "Оплата", "правка без fields не стирает значения");
  assert.equal((await u.tester.get(`/api/projects/LK/cases?field.${comp}=${encodeURIComponent("Оплата")}&count=1`)).data.total, 1);

  assert.equal((await u.tester.post("/api/projects/LK/bugs", { title: "Без оценки", severity: "minor" })).status, 400, "обязательное поле");
  assert.equal((await u.tester.post("/api/projects/LK/bugs", { title: "С оценкой", severity: "minor", fields: { [sp]: "3" } })).status, 201);
  const ps = (await u.tester.get("/api/projects/LK/state")).data;
  assert.ok(ps.customFields.some((f) => f.name === "Компонент"));
  await u.tester.patch(`/api/projects/LK/fields/${sp}`, { required: false });
});

test("CSV: теги и ожидаемые результаты шагов туда и обратно", async () => {
  const csv = "Название;Шаги;Ожидаемые результаты шагов;Теги\nCSV шаги;\"Открыть\nНажать\";\"Открылось\nНажалось\";\"api, csv\"\n";
  const r = await u.tester.post("/api/projects/LK/cases/import", { csv });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const found = (await u.tester.get("/api/projects/LK/cases?q=" + encodeURIComponent("CSV шаги"))).data.items[0];
  assert.deepEqual(found.stepList.map((s) => s.expected), ["Открылось", "Нажалось"]);
  assert.deepEqual(found.tags, ["api", "csv"]);
  const raw = await fetch(srv.base + "/api/projects/LK/cases/export", { headers: { cookie: u.tester.cookie } });
  const text = await raw.text();
  assert.match(text, /Ожидаемые результаты шагов;Теги/);
  assert.match(text, /"Открылось\r?\nНажалось";api, csv/);
});

test("экспорт и импорт проекта переносят шаги, теги, поля и результаты шагов", async () => {
  const exp = await u.tester.get("/api/projects/LK/export");
  assert.equal(exp.status, 200);
  const r = await u.admin.post("/api/projects-import", { source: "testball", data: exp.data, key: "CPY" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const src = (await u.admin.get("/api/projects/LK/cases?q=" + encodeURIComponent("Структурные шаги"))).data.items[0];
  const dst = (await u.admin.get("/api/projects/CPY/cases?q=" + encodeURIComponent("Структурные шаги"))).data.items[0];
  assert.deepEqual(dst.stepList, src.stepList);
  assert.deepEqual(dst.tags, src.tags);
  const st = (await u.admin.get("/api/projects/CPY/state")).data;
  const comp = st.customFields.find((f) => f.name === "Компонент");
  assert.ok(comp);
  assert.ok(st.cases.some((c) => c.fields[comp.id] === "Оплата"));
});

test("allure-results: шаги, повторы, параметры, вложения и связь с кейсом через report.js", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const kase = await u.tester.post("/api/projects/LK/cases", { title: "Вход для Allure", priority: "high", status: "ready" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allure-"));
  const w = (name, obj) => fs.writeFileSync(path.join(dir, name), typeof obj === "string" ? obj : JSON.stringify(obj));
  const base = { labels: [{ name: "suite", value: "auth" }, { name: "parentSuite", value: "web" }], start: 1000, stop: 1500 };
  w("a1-result.json", { ...base, uuid: "a1", historyId: "h1", name: "Вход по паролю", status: "passed",
    labels: [...base.labels, { name: "testball", value: `LK-${kase.data.num}` }, { name: "tag", value: "smoke" }],
    steps: [{ name: "Открыть страницу", status: "passed", start: 1000, stop: 1100, steps: [] }] });
  w("a2-result.json", { ...base, uuid: "a2", historyId: "h2", name: "Оплата", status: "failed",
    statusDetails: { message: "expected 200 got 500", trace: "at pay.spec.ts:10" },
    steps: [{ name: "Нажать оплатить", status: "failed", statusDetails: { message: "500" }, attachments: [{ name: "screen", source: "s1-attachment.png", type: "image/png" }] }] });
  w("s1-attachment.png", "PNGDATA");
  // повторы: сначала упал, потом прошёл
  w("a3-result.json", { ...base, uuid: "a3", historyId: "h3", name: "Нестабильный", status: "failed", start: 1, stop: 2 });
  w("a4-result.json", { ...base, uuid: "a4", historyId: "h3", name: "Нестабильный", status: "passed", start: 3, stop: 4 });
  // параметризованный
  w("a5-result.json", { ...base, uuid: "a5", historyId: "h5", name: "Логин", status: "passed", parameters: [{ name: "role", value: "admin" }] });
  w("a6-result.json", { ...base, uuid: "a6", historyId: "h6", name: "Логин", status: "unknown", parameters: [{ name: "role", value: "guest" }] });
  w("broken-result.json", "{не json");
  w("c1-container.json", { uuid: "c1", children: ["a1"] });

  const tok = (await u.tester.post("/api/tokens", { name: "allure", project: "LK" })).data.token;
  const r = spawnSync(process.execPath, ["scripts/report.js", dir, "--title", "Allure CI", "--build", "b42"], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, TESTBALL_URL: srv.base, TESTBALL_TOKEN: tok, TESTBALL_PROJECT: "LK" }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const st = (await u.tester.get("/api/projects/LK/state")).data;
  const run = st.autoruns.find((a) => a.title === "Allure CI");
  assert.deepEqual(run.counts, { passed: 3, failed: 1, broken: 1, skipped: 0 });
  assert.equal(run.state, "finished");
  const det = (await u.tester.get(`/api/projects/LK/autoruns/${run.num}`)).data;
  const byName = (n) => det.results.find((x) => x.name === n);
  assert.equal(byName("Оплата").message, "expected 200 got 500");
  assert.equal(byName("Оплата").steps[0].status, "failed");
  assert.equal(byName("Оплата").suite, "web › auth");
  assert.ok(byName("Логин [role=admin]") && byName("Логин [role=guest]").status === "broken");
  assert.ok(det.attachments.some((a) => a.autoResultId === byName("Оплата").id && a.name.startsWith("screen")));
  const tests = (await u.tester.get("/api/projects/LK/autotests")).data.tests;
  assert.equal(tests.find((t) => t.name === "Вход по паролю").caseNum, kase.data.num, "связь с кейсом по метке");
  const flakyRes = (await u.tester.get(`/api/projects/LK/autoruns/${run.num}`)).data.results.find((x) => x.name === "Нестабильный");
  assert.equal(flakyRes.status, "passed");
  assert.ok(flakyRes.flaky || flakyRes.retries >= 1);
});

test("отчёты по прогону и плану: PDF и Excel", async () => {
  const k = await u.tester.post("/api/projects/LK/cases", { title: "Для отчёта: оплата картой", priority: "high", status: "ready", stepList: [{ action: "Открыть" }, { action: "Оплатить", expected: "Успех" }] });
  const run = (await u.tester.post("/api/projects/LK/runs", { title: "Отчётный прогон", build: "3.1", caseNums: [k.data.num] })).data.num;
  await u.tester.patch(`/api/projects/LK/runs/${run}/results/${k.data.num}`, { step: 1, result: "failed", actual: "Ошибка 500" });
  await u.tester.post("/api/projects/LK/bugs", { title: "Оплата падает", severity: "critical", caseNum: k.data.num, runNum: run });
  const get = (url) => fetch(srv.base + url, { headers: { cookie: u.dev.cookie } });
  let r = await get(`/api/projects/LK/runs/${run}/report?format=pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition"), /filename\*=UTF-8''LK-R\d+-/);
  const pdfBuf = Buffer.from(await r.arrayBuffer());
  assert.equal(pdfBuf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdfBuf.length > 5000);
  r = await get(`/api/projects/LK/runs/${run}/report?format=xlsx`);
  assert.equal(r.status, 200);
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const res = wb.getWorksheet("Результаты");
  assert.equal(res.getRow(2).getCell(4).value, "Упал");
  assert.match(String(res.getRow(2).getCell(5).value), /2\. Оплатить — Ошибка 500/);
  assert.equal(wb.getWorksheet("Баги").getRow(2).getCell(3).value, "Критический");
  const plan = (await u.tester.post("/api/projects/LK/plans", { title: "План отчёта", mode: "static", caseNums: [k.data.num] })).data.num;
  await u.tester.post(`/api/projects/LK/plans/${plan}/runs`, { title: "Из плана" });
  r = await get(`/api/projects/LK/plans/${plan}/report?format=pdf`);
  assert.equal(r.status, 200);
  assert.equal((await get(`/api/projects/LK/runs/99999/report`)).status, 404);
});
