// Общие шаги: блок вставляется в кейсы ссылкой и раскрывается при чтении, в прогоне и отчётах
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u;
test.before(async () => {
  srv = await startServer();
  u = await seed(srv);
});
test.after(async () => srv && srv.stop());

test("общие шаги: вставка ссылкой, раскрытие, правка видна во всех кейсах, прогон по шагам", async () => {
  let r = await u.tester.post("/api/projects/LK/shared-steps", { title: "Вход как администратор", stepList: [
    { action: "Открыть страницу входа", expected: "Форма входа" },
    { action: "Ввести admin / пароль", expected: "Открыт кабинет", data: "admin" },
  ] });
  assert.equal(r.status, 201);
  const sid = r.data.id;
  const snum = r.data.num;
  assert.equal((await u.viewer.post("/api/projects/LK/shared-steps", { title: "x", stepList: [{ action: "a" }] })).status, 403);
  assert.equal((await u.tester.post("/api/projects/LK/shared-steps", { title: "Пустой", stepList: [] })).status, 400);
  const mk = async (title, extra) => (await u.tester.post("/api/projects/LK/cases", { title, priority: "high", status: "ready",
    stepList: [{ shared: sid }, { action: extra, expected: "Готово" }] })).data.num;
  const a = await mk("Создать пользователя", "Создать пользователя");
  const b = await mk("Удалить пользователя", "Удалить пользователя");
  let c = (await u.tester.get(`/api/projects/LK/cases/${a}`)).data;
  assert.equal(c.stepList.length, 3);
  assert.equal(c.stepList[0].action, "Открыть страницу входа");
  assert.equal(c.stepList[0].sharedTitle, "Вход как администратор");
  assert.deepEqual(c.stepSource, [{ shared: sid }, { action: "Создать пользователя", expected: "Готово", data: "" }]);
  // правка блока — сразу в обоих кейсах, без новых версий кейсов
  await u.tester.patch(`/api/projects/LK/shared-steps/${snum}`, { stepList: [
    { action: "Открыть страницу входа", expected: "Форма входа" }, { action: "Ввести логин и пароль", expected: "Кабинет" }, { action: "Подтвердить код", expected: "Вход выполнен" },
  ] });
  c = (await u.tester.get(`/api/projects/LK/cases/${b}`)).data;
  assert.equal(c.stepList.length, 4);
  assert.equal(c.stepList[2].action, "Подтвердить код");
  assert.equal(c.version, 1);
  r = await u.viewer.get(`/api/projects/LK/shared-steps/${snum}`);
  assert.deepEqual(r.data.cases.map((x) => x.num).sort(), [a, b].sort());
  assert.equal((await u.viewer.get("/api/projects/LK/shared-steps")).data.items[0].usedIn, 2);
  // прогон: отметка по раскрытым шагам
  const run = (await u.tester.post("/api/projects/LK/runs", { title: "Общие шаги", caseNums: [a] })).data.num;
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${a}`, { step: 2, result: "failed", actual: "Код не пришёл" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await u.tester.patch(`/api/projects/LK/runs/${run}/results/${a}`, { step: 3, result: "passed" });
  assert.equal(r.status, 200);
  assert.equal((await u.tester.patch(`/api/projects/LK/runs/${run}/results/${a}`, { step: 4, result: "passed" })).status, 404);
  // отчёт PDF строится (раскрытые шаги)
  const pdf = await fetch(`${srv.base}/api/projects/LK/runs/${run}/report?format=pdf`, { headers: { cookie: u.tester.cookie } });
  assert.equal(pdf.status, 200);
  // сохранение кейса с раскрытыми шагами из формы не задваивает блок
  r = await u.tester.patch(`/api/projects/LK/cases/${a}`, { stepList: [...c.stepList.slice(0, 3), { shared: sid }, { action: "Создать пользователя", expected: "Готово" }], baseVersion: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await u.tester.get(`/api/projects/LK/cases/${a}`)).data.stepList.length, 4);
  // чужой блок нельзя
  assert.equal((await u.tester.post("/api/projects/LK/cases", { title: "x", priority: "low", status: "draft", stepList: [{ shared: 999999 }] })).status, 400);
  // удаление используемого блока — только с копированием шагов в кейсы
  r = await u.tester.del(`/api/projects/LK/shared-steps/${snum}`);
  assert.equal(r.status, 409);
  assert.equal(r.data.inUse, 2);
  r = await u.tester.del(`/api/projects/LK/shared-steps/${snum}`, { inline: true });
  assert.equal(r.data.inlined, 2);
  c = (await u.tester.get(`/api/projects/LK/cases/${b}`)).data;
  assert.equal(c.stepList.length, 4);
  assert.equal(c.stepList[0].sharedTitle, undefined);
  assert.equal(c.stepSource, undefined);
});

test("общие шаги переносятся при экспорте и импорте проекта", async () => {
  const s = (await u.tester.post("/api/projects/LK/shared-steps", { title: "Оформить заказ", stepList: [{ action: "Корзина" }, { action: "Оплата" }] })).data;
  await u.tester.post("/api/projects/LK/cases", { title: "Заказ со скидкой", priority: "high", status: "ready", stepList: [{ shared: s.id }, { action: "Проверить скидку" }] });
  const exp = (await u.tester.get("/api/projects/LK/export")).data;
  const r = await u.admin.post("/api/projects-import", { source: "testball", data: exp, key: "SHR" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const items = (await u.admin.get("/api/projects/SHR/cases?q=" + encodeURIComponent("Заказ со скидкой"))).data.items;
  const c = (await u.admin.get(`/api/projects/SHR/cases/${items[0].num}`)).data;
  assert.equal(c.stepList.length, 3);
  assert.equal(c.stepList[0].sharedTitle, "Оформить заказ");
  assert.notEqual(c.stepSource[0].shared, s.id, "ссылка на блок нового проекта");
});
