// Релизы и майлстоуны (E-01)
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed } = require("./helpers");

let srv, u;
test.before(async () => { srv = await startServer(); u = await seed(srv); });
test.after(async () => srv && srv.stop());
const P = "/api/projects/LK";

test("релизы: спринты, привязка, наследование, готовность", async () => {
  assert.equal((await u.dev.post(P + "/releases", { name: "2.0" })).status, 403);
  assert.equal((await u.tester.post(P + "/releases", { name: "2.0", starts: "2026-12-10", due: "2026-12-01" })).status, 400);
  assert.equal((await u.tester.post(P + "/releases", { name: "2.0", due: "31.12.2026" })).status, 400);
  let r = await u.tester.post(P + "/releases", { name: "2.0", starts: "2026-11-01", due: "2026-12-31", status: "active", description: "Новая корзина" });
  assert.equal(r.status, 201);
  assert.equal(r.data.ref, "LK-V1");
  assert.equal((await u.tester.post(P + "/releases", { name: "2.0" })).status, 409);
  const sprint = (await u.tester.post(P + "/releases", { name: "Спринт 1", parent: 1, starts: "2026-11-01", due: "2026-11-14" })).data.num;
  assert.equal((await u.tester.post(P + "/releases", { name: "Подспринт", parent: sprint })).status, 400, "спринт в спринте нельзя");

  // пустой релиз не готов
  let rel = (await u.tester.get(P + "/releases/1")).data;
  assert.equal(rel.ready, false);
  assert.match(rel.blockers.join(), /нет прогонов/);
  assert.equal(rel.sprints[0].name, "Спринт 1");

  const c1 = (await u.tester.post(P + "/cases", { title: "Оплата", priority: "high", status: "ready", steps: "a" })).data.num;
  const c2 = (await u.tester.post(P + "/cases", { title: "Доставка", priority: "high", status: "ready", steps: "a" })).data.num;
  // прогон в спринте — учитывается в релизе
  const run = (await u.tester.post(P + "/runs", { title: "Спринт 1: смоук", caseNums: [c1, c2], release: sprint })).data.num;
  assert.equal((await u.tester.post(P + "/runs", { title: "x", caseNums: [c1], release: 999 })).status, 400);
  await u.tester.patch(`${P}/runs/${run}/results/${c1}`, { result: "passed" });
  await u.tester.patch(`${P}/runs/${run}/results/${c2}`, { result: "failed" });
  // баг из прогона наследует релиз (спринт)
  const bug = (await u.tester.post(P + "/bugs", { title: "Доставка не считается", severity: "critical", caseNum: c2, runNum: run })).data.num;
  const st = (await u.tester.get(P + "/state")).data;
  assert.equal(st.bugs.find((b) => b.num === bug).release, sprint);
  assert.equal(st.runs.find((x) => x.num === run).release, sprint);

  rel = (await u.tester.get(P + "/releases/1")).data;
  assert.equal(rel.cases.total, 2);
  assert.equal(rel.cases.progress, 100);
  assert.equal(rel.cases.passRate, 50);
  assert.equal(rel.bugs.severe, 1);
  assert.equal(rel.ready, false);
  assert.ok(rel.blockers.some((b) => /Упало/.test(b)) && rel.blockers.some((b) => /критичных/.test(b)));

  // план с релизом: прогон по плану и перезапуск наследуют релиз
  const plan = (await u.tester.post(P + "/plans", { title: "Регресс 2.0", mode: "static", caseNums: [c1, c2], release: 1 })).data.num;
  const prun = (await u.tester.post(`${P}/plans/${plan}/runs`, { title: "Регресс 2.0 — прогон" })).data.num;
  await u.tester.patch(`${P}/runs/${prun}/results/${c2}`, { result: "passed" });
  await u.tester.patch(`${P}/runs/${prun}/results/${c1}`, { result: "failed" });
  const re = (await u.tester.post(`${P}/runs/${prun}/rerun`, {})).data.num;
  const st2 = (await u.tester.get(P + "/state")).data;
  assert.equal(st2.runs.find((x) => x.num === prun).release, 1);
  assert.equal(st2.runs.find((x) => x.num === re).release, 1);
  assert.equal(st2.plans.find((x) => x.num === plan).release, 1);

  // починили: баг закрыт, упавший кейс пройден в перезапуске → готов
  for (const s of ["in_progress", "fixed", "verified", "closed"]) await u.tester.patch(`${P}/bugs/${bug}`, { status: s });
  await u.tester.patch(`${P}/runs/${re}/results/${c1}`, { result: "passed" });
  rel = (await u.tester.get(P + "/releases/1")).data;
  assert.equal(rel.ready, true, JSON.stringify(rel.blockers));
  assert.equal(rel.runs.length, 3);
  assert.equal(rel.plans[0].num, plan);

  // список релизов со сводкой
  const list = (await u.tester.get(P + "/releases")).data.items;
  assert.equal(list.find((x) => x.num === 1).runs, 3);

  // отвязать и привязать
  let l = await u.tester.post(P + "/releases/1/link", { runs: [re], linked: false });
  assert.equal(l.data.runs, 1);
  l = await u.tester.post(P + "/releases/1/link", { bugs: [bug] });
  assert.equal(l.data.bugs, 1);

  // экспорт/импорт переносит релизы и связи
  const exp = (await u.admin.get(P + "/export")).data;
  assert.equal(exp.releases.length, 2);
  const imp = await u.admin.post("/api/projects-import", { source: "testball", data: exp, key: "RLX" });
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  const r2 = (await u.admin.get("/api/projects/RLX/releases/1")).data;
  assert.equal(r2.sprints.length, 1);
  assert.equal(r2.runs.length, 2);

  // релизованный: дата выпуска; удаление релиза оставляет прогоны
  await u.tester.patch(P + "/releases/1", { status: "released" });
  assert.ok((await u.tester.get(P + "/releases/1")).data.released);
  assert.equal((await u.tester.del(P + "/releases/1")).status, 200);
  const st3 = (await u.tester.get(P + "/state")).data;
  assert.equal(st3.runs.find((x) => x.num === prun).release, null);
  assert.equal(st3.runs.length >= 3, true);
});
