// H-04: матрица покрытия — срезы «последние результаты», релиз, прогон; выгрузки Excel, PDF, CSV; права
const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { startServer, seed } = require("./helpers");

const P = "/api/projects/LK";
let srv, u;
test.before(async () => {
  srv = await startServer();
  u = await seed(srv);
});
test.after(async () => srv && (await srv.stop()));

test("матрица покрытия: срезы, сводка, баги, выгрузки", async () => {
  const mk = async (title) => (await u.tester.post(P + "/cases", { title, priority: "high", status: "ready", steps: "a" })).data.num;
  const c1 = await mk("Вход по паролю");
  const c2 = await mk("Восстановление пароля");
  const c3 = await mk("Выход");
  await mk("Кейс без требования");
  const rq = async (title, cases) => (await u.tester.post(P + "/requirements", { title, cases, extRef: title.slice(0, 4) })).data.num;
  const r1 = await rq("Вход", [c1, c2]);
  const r2 = await rq("Выход", [c3]);
  const r3 = await rq("Нет кейсов", []);
  const rel = (await u.tester.post(P + "/releases", { name: "2.0" })).data.num;

  // прогон в релизе: c1 пройден, c2 упал; потом вне релиза c2 пройден
  const run1 = (await u.tester.post(P + "/runs", { title: "Регресс 2.0", caseNums: [c1, c2], release: rel })).data.num;
  await u.tester.patch(`${P}/runs/${run1}/results/${c1}`, { result: "passed" });
  await u.tester.patch(`${P}/runs/${run1}/results/${c2}`, { result: "failed" });
  const bug = (await u.tester.post(P + "/bugs", { title: "Письмо не приходит", severity: "major", caseNum: c2, run: run1 })).data.num;
  const run2 = (await u.tester.post(P + "/runs", { title: "Повтор", caseNums: [c2] })).data.num;
  await u.tester.patch(`${P}/runs/${run2}/results/${c2}`, { result: "passed" });

  // последние результаты: r1 пройдено (c2 уже пройден повторно), r2 не проверено, r3 не покрыто
  let m = (await u.viewer.get(P + "/requirements/matrix")).data;
  assert.equal(m.scope.kind, "latest");
  const cov = (d) => Object.fromEntries(d.requirements.map((r) => [r.num, r.coverage]));
  assert.deepEqual(cov(m), { [r1]: "passed", [r2]: "untested", [r3]: "none" });
  assert.equal(m.summary.total, 3);
  assert.equal(m.summary.coveredPct, 67);
  assert.equal(m.summary.passedPct, 33);
  assert.equal(m.summary.casesLinked, 3);
  assert.equal(m.summary.casesUnlinked, 1);
  const k2 = m.cases.find((c) => c.num === c2);
  assert.equal(k2.result, "passed");
  assert.equal(k2.run, run2);
  assert.ok(k2.bugs.some((b) => b.num === bug), "открытый баг по кейсу");

  // срез релиза: c2 упал в релизе, c3 вне среза
  m = (await u.viewer.get(`${P}/requirements/matrix?release=${rel}`)).data;
  assert.equal(m.scope.kind, "release");
  assert.match(m.scope.label, /2\.0/);
  assert.deepEqual(cov(m), { [r1]: "failed", [r2]: "untested", [r3]: "none" });
  assert.equal(m.cases.find((c) => c.num === c3).inScope, false);
  assert.equal(m.cases.find((c) => c.num === c2).result, "failed");

  // срез прогона
  m = (await u.viewer.get(`${P}/requirements/matrix?run=${run2}`)).data;
  assert.equal(m.cases.find((c) => c.num === c1).inScope, false);
  assert.equal(cov(m)[r1], "partial");
  assert.equal((await u.viewer.get(`${P}/requirements/matrix?run=999`)).status, 404);
  assert.equal((await u.viewer.get(`${P}/requirements/matrix?release=999`)).status, 404);
  assert.equal((await u.outsider.get(`${P}/requirements/matrix`)).status, 404);

  // устаревшие требования по умолчанию не входят
  await u.tester.patch(`${P}/requirements/${r3}`, { status: "obsolete" });
  assert.equal((await u.viewer.get(P + "/requirements/matrix")).data.summary.total, 2);
  assert.equal((await u.viewer.get(P + "/requirements/matrix?obsolete=1")).data.summary.total, 3);

  // Excel: сводка, сетка с цветом, детально
  let r = await fetch(`${srv.base}${P}/requirements/matrix/export?format=xlsx&release=${rel}`, { headers: { cookie: u.viewer.cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /LK-coverage-matrix-release-1\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Сводка", "Матрица", "Детально"]);
  const grid = wb.getWorksheet("Матрица");
  assert.equal(grid.getRow(1).getCell(4).value, `LK-${c1}`);
  const row1 = grid.getRow(2);
  assert.equal(row1.getCell(1).value, `LK-REQ${r1}`);
  assert.equal(row1.getCell(3).value, "Провалено");
  assert.equal(row1.getCell(4).value, "✓");
  assert.equal(row1.getCell(5).value, "✗");
  assert.equal(grid.getRow(3).getCell(6).value, "—", "вне среза");
  const det = wb.getWorksheet("Детально");
  const vals = [];
  det.eachRow((row) => vals.push(row.values.slice(1).join("|")));
  assert.ok(vals.some((v) => v.includes(`LK-${c2}`) && v.includes("Упал") && v.includes(`LK-B${bug}`)));

  // PDF и CSV
  r = await fetch(`${srv.base}${P}/requirements/matrix/export?format=pdf`, { headers: { cookie: u.viewer.cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  r = await fetch(`${srv.base}${P}/requirements/matrix/export?format=csv&run=${run1}`, { headers: { cookie: u.viewer.cookie } });
  const text = await r.text();
  assert.match(text, /Требование;Название/);
  assert.match(text, new RegExp(`LK-${c1};Вход по паролю;Пройден;LK-R${run1}`));
});
