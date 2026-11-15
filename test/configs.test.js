// Конфигурации и матрица прогонов (E-02)
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u;
test.before(async () => { srv = await startServer(); u = await seed(srv); });
test.after(async () => srv && srv.stop());
const P = "/api/projects/LK";

test("конфигурации: справочник, прогон по плану на N конфигураций, матрица, перезапуск", async () => {
  assert.equal((await u.dev.post(P + "/configs", { name: "Браузер", options: ["Chrome"] })).status, 403);
  assert.equal((await u.tester.post(P + "/configs", { name: "Браузер", options: [] })).status, 400);
  assert.equal((await u.tester.post(P + "/configs", { name: "Браузер", options: ["Chrome", "Firefox", "Safari"] })).status, 201);
  assert.equal((await u.tester.post(P + "/configs", { name: "браузер", options: ["x"] })).status, 409);
  assert.equal((await u.tester.post(P + "/configs", { name: "ОС", options: ["Windows", "macOS"] })).status, 201);
  const groups = (await u.tester.get(P + "/configs")).data.groups;
  assert.deepEqual(groups.map((g) => g.name), ["Браузер", "ОС"]);

  const c1 = (await u.tester.post(P + "/cases", { title: "Корзина", priority: "high", status: "ready", steps: "a" })).data.num;
  const c2 = (await u.tester.post(P + "/cases", { title: "Оплата", priority: "high", status: "ready", steps: "a" })).data.num;
  const plan = (await u.tester.post(P + "/plans", { title: "Кросс-браузер", mode: "static", caseNums: [c1, c2] })).data.num;
  // неизвестный вариант — 400
  assert.equal((await u.tester.post(`${P}/plans/${plan}/runs`, { title: "x", configs: [{ Браузер: "Opera" }] })).status, 400);
  const r = await u.tester.post(`${P}/plans/${plan}/runs`, {
    title: "Регресс 3.1", configs: [{ "браузер": "chrome", "ОС": "Windows" }, { "ОС": "macOS", "Браузер": "Safari" }, { "Браузер": "Chrome", "ОС": "Windows" }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.runs.length, 2, "повтор конфигурации не создаёт лишний прогон");
  assert.match(r.data.batch, /^[0-9a-f-]{36}$/);
  const st = (await u.tester.get(P + "/state")).data;
  const made = st.runs.filter((x) => r.data.runs.includes(x.num));
  assert.deepEqual(made.map((x) => x.title).sort(), ["Регресс 3.1 — Chrome, Windows", "Регресс 3.1 — Safari, macOS"]);
  assert.deepEqual(made.find((x) => x.title.includes("Safari")).config, { "Браузер": "Safari", "ОС": "macOS" }, "порядок групп как в справочнике");

  const [ra, rb] = r.data.runs;
  await u.tester.patch(`${P}/runs/${ra}/results/${c1}`, { result: "passed" });
  await u.tester.patch(`${P}/runs/${rb}/results/${c1}`, { result: "failed" });
  const m = (await u.tester.get(`${P}/runs/matrix/${r.data.batch}`)).data;
  assert.equal(m.runs.length, 2);
  assert.equal(m.runs[0].label, "Chrome, Windows");
  const row = m.cases.find((x) => x.num === c1);
  assert.equal(row.results[ra], "passed");
  assert.equal(row.results[rb], "failed");
  assert.equal(m.cases.find((x) => x.num === c2).results[ra], "untested");

  // перезапуск сохраняет конфигурацию; обычный прогон — с конфигурацией
  const re = (await u.tester.post(`${P}/runs/${rb}/rerun`, {})).data.num;
  const run = (await u.tester.post(P + "/runs", { title: "Ручной", caseNums: [c1], config: { "ОС": "Windows" } })).data.num;
  const st2 = (await u.tester.get(P + "/state")).data;
  assert.deepEqual(st2.runs.find((x) => x.num === re).config, { "Браузер": "Safari", "ОС": "macOS" });
  assert.deepEqual(st2.runs.find((x) => x.num === run).config, { "ОС": "Windows" });
  assert.equal((await u.tester.patch(`${P}/runs/${run}`, { config: null })).status, 200);
  assert.equal((await u.tester.get(P + "/state")).data.runs.find((x) => x.num === run).config, null);

  // экспорт/импорт
  const exp = (await u.admin.get(P + "/export")).data;
  const imp = await u.admin.post("/api/projects-import", { source: "testball", data: exp, key: "CFX" });
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  assert.equal((await u.admin.get("/api/projects/CFX/configs")).data.groups.length, 2);
  assert.equal((await u.admin.get(`/api/projects/CFX/runs/matrix/${r.data.batch}`)).data.runs.length, 2);
});
