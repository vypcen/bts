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
