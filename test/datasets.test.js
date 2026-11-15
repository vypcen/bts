// Параметры и data-driven кейсы (D-06)
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u;
test.before(async () => { srv = await startServer(); u = await seed(srv); });
test.after(async () => srv && srv.stop());

const P = "/api/projects/LK";
const steps = [{ action: "Войти как {{login}}", expected: "Открыт кабинет {{role}}" }, { action: "Открыть настройки", expected: "Видны настройки" }];

test("параметры кейса: проверка таблицы, итерации в прогоне, итог по итерациям", async () => {
  let r = await u.tester.post(P + "/cases", { title: "Вход разными ролями", priority: "high", status: "ready", stepList: steps, params: { columns: ["login"], rows: [] } });
  assert.equal(r.status, 400);
  r = await u.tester.post(P + "/cases", { title: "x", priority: "high", status: "ready", params: { columns: ["bad{name}"], rows: [{ values: {} }] } });
  assert.equal(r.status, 400);
  r = await u.tester.post(P + "/cases", { kind: "checklist", title: "x", priority: "high", status: "ready", steps: "a", params: { columns: ["a"], rows: [{ values: { a: 1 } }] } });
  assert.equal(r.status, 400, "у чек-листа параметров нет");
  r = await u.tester.post(P + "/cases", {
    title: "Вход разными ролями", priority: "high", status: "ready", stepList: steps,
    params: { columns: ["login", "role"], rows: [{ name: "Админ", values: { login: "admin", role: "администратора" } }, { values: { login: "guest", role: "гостя" } }] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const n = r.data.num;
  const c = (await u.tester.get(`${P}/cases/${n}`)).data;
  assert.deepEqual(c.params.columns, ["login", "role"]);
  assert.equal(c.params.rows[1].name, "Набор 2");

  const run = (await u.tester.post(P + "/runs", { title: "Роли", caseNums: [n] })).data.num;
  let res = (await u.tester.get(`${P}/runs/${run}/results`)).data.results[0];
  assert.equal(res.iterations.length, 2);
  assert.deepEqual(res.iterResults, {});

  // без итерации — 400; несуществующая — 404
  assert.equal((await u.tester.patch(`${P}/runs/${run}/results/${n}`, { result: "passed" })).status, 400);
  assert.equal((await u.tester.patch(`${P}/runs/${run}/results/${n}`, { iteration: 5, result: "passed" })).status, 404);
  // комментарий и исполнитель — без итерации
  assert.equal((await u.tester.patch(`${P}/runs/${run}/results/${n}`, { comment: "проверяю" })).status, 200);

  await u.tester.patch(`${P}/runs/${run}/results/${n}`, { iteration: 0, result: "passed" });
  res = (await u.tester.get(`${P}/runs/${run}/results`)).data.results[0];
  assert.equal(res.result, "untested", "второй набор не проверен");
  await u.tester.patch(`${P}/runs/${run}/results/${n}`, { iteration: 1, step: 1, result: "failed", actual: "500" });
  res = (await u.tester.get(`${P}/runs/${run}/results`)).data.results[0];
  assert.equal(res.result, "failed");
  assert.equal(res.iterResults["1"].result, "failed");
  assert.equal(res.iterResults["1"].steps["1"].actual, "500");
  await u.tester.patch(`${P}/runs/${run}/results/${n}`, { iteration: 1, step: 1, result: "passed" });
  await u.tester.patch(`${P}/runs/${run}/results/${n}`, { iteration: 1, step: 0, result: "passed" });
  res = (await u.tester.get(`${P}/runs/${run}/results`)).data.results[0];
  assert.equal(res.result, "passed");

  // правка параметров кейса не меняет уже идущий прогон (снимок), а новый прогон берёт новые наборы
  await u.tester.patch(`${P}/cases/${n}`, { params: { columns: ["login", "role"], rows: [{ name: "Один", values: { login: "a", role: "b" } }] } });
  assert.equal((await u.tester.get(`${P}/runs/${run}/results`)).data.results[0].iterations.length, 2);
  const run2 = (await u.tester.post(P + "/runs", { title: "Роли 2", caseNums: [n] })).data.num;
  assert.equal((await u.tester.get(`${P}/runs/${run2}/results`)).data.results[0].iterations.length, 1);

  // отчёт: итоги итераций в комментарии
  const xlsx = await fetch(`${srv.base}${P}/runs/${run}/report?format=xlsx`, { headers: { cookie: u.tester.cookie } });
  assert.equal(xlsx.status, 200);

  // снять параметры: params: null — кейс снова обычный
  await u.tester.patch(`${P}/cases/${n}`, { params: null });
  assert.equal((await u.tester.get(`${P}/cases/${n}`)).data.params, undefined);
});

test("наборы данных проекта: CRUD, ссылка из кейса, удаление копирует таблицу в кейсы", async () => {
  assert.equal((await u.viewer.post(P + "/datasets", { name: "x", columns: ["a"], rows: [{ values: { a: 1 } }] })).status, 403);
  let r = await u.tester.post(P + "/datasets", { name: "Браузеры", columns: ["browser"], rows: [{ name: "Chrome", values: { browser: "Chrome" } }, { name: "Firefox", values: { browser: "Firefox" } }] });
  assert.equal(r.status, 201);
  const ds = r.data;
  assert.equal((await u.tester.post(P + "/datasets", { name: "браузеры", columns: ["a"], rows: [{ values: {} }] })).status, 409);
  const c = (await u.tester.post(P + "/cases", { title: "Кросс-браузерная проверка в {{browser}}", priority: "low", status: "ready", steps: "Открыть в {{browser}}", dataset: ds.id })).data.num;
  assert.equal((await u.tester.post(P + "/cases", { title: "y", priority: "low", status: "ready", dataset: 99999 })).status, 400);
  let card = (await u.tester.get(`${P}/cases/${c}`)).data;
  assert.equal(card.dataset.name, "Браузеры");
  assert.equal(card.dataset.rows.length, 2);
  const list = (await u.tester.get(P + "/datasets")).data.items;
  assert.equal(list.find((x) => x.id === ds.id).usedIn, 1);

  // правка набора видна в новом прогоне
  await u.tester.patch(`${P}/datasets/${ds.num}`, { rows: [{ name: "Chrome", values: { browser: "Chrome" } }, { name: "Firefox", values: { browser: "Firefox" } }, { name: "Safari", values: { browser: "Safari" } }] });
  const run = (await u.tester.post(P + "/runs", { title: "Браузеры", caseNums: [c] })).data.num;
  assert.equal((await u.tester.get(`${P}/runs/${run}/results`)).data.results[0].iterations.length, 3);

  // удаление: кейс получает копию таблицы
  r = await u.tester.del(`${P}/datasets/${ds.num}`);
  assert.equal(r.data.copiedTo, 1);
  card = (await u.tester.get(`${P}/cases/${c}`)).data;
  assert.equal(card.dataset, undefined);
  assert.equal(card.params.rows.length, 3);

  // экспорт и импорт проекта переносят параметры и наборы
  await u.tester.post(P + "/datasets", { name: "Языки", columns: ["lang"], rows: [{ values: { lang: "ru" } }] });
  const exp = (await u.admin.get(P + "/export")).data;
  assert.ok(exp.datasets.length >= 1);
  const imp = await u.admin.post("/api/projects-import", { source: "testball", data: exp, key: "DSX" });
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  const st = (await u.admin.get(`/api/projects/DSX/cases/${c}`)).data;
  assert.equal(st.params.rows.length, 3);
  assert.equal((await u.admin.get("/api/projects/DSX/datasets")).data.items[0].name, "Языки");
});
