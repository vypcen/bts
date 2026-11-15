// Импорт тест-кейсов из Excel с сопоставлением колонок (M-06)
const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { startServer, seed } = require("./helpers");

let srv, u;
test.before(async () => { srv = await startServer(); u = await seed(srv); });
test.after(async () => srv && srv.stop());
const P = "/api/projects/LK";

async function xlsx(rows, name = "Кейсы") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Пусто");
  ws.addRow(["нечего"]);
  const s = wb.addWorksheet(name);
  for (const r of rows) s.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

test("Excel: выгрузка в стиле Zephyr — шаги по строкам, сопоставление, поля, dryRun и импорт", async () => {
  await u.tester.post(P + "/fields", { entity: "case", name: "Платформа", type: "select", options: ["Web", "iOS"] });
  const file = await xlsx([
    [], // пустая строка над заголовками
    ["Name", "Folder", "Priority", "Objective", "Test Script (Step-by-Step) - Step", "Test Script (Step-by-Step) - Test Data", "Test Script (Step-by-Step) - Expected Result", "Платформа", "Labels"],
    ["Вход по паролю", "Auth / Login", "High", "Есть пользователь", "Открыть страницу", "", "Форма видна", "Web", "smoke, auth"],
    ["", "", "", "", "Ввести логин и пароль", "user / Qwerty1", "Поля заполнены", "", ""],
    ["", "", "", "", "Нажать «Войти»", "", "Открыт кабинет", "", ""],
    ["Выход", "Auth", "Low", "", "Нажать «Выйти»", "", "Открыта главная", "iOS", ""],
  ]);
  // шаг 1: разбор и предложения
  let r = await u.tester.post(P + "/cases/import/table", { file, name: "zephyr.xlsx" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sh = r.data.sheets[1];
  assert.equal(sh.name, "Кейсы");
  assert.equal(sh.headerRow, 1);
  assert.equal(sh.total, 4);
  const sug = sh.suggest;
  assert.equal(sug.map.title, 0);
  assert.equal(sug.map.steps, 4);
  assert.equal(sug.map.stepData, 5);
  assert.equal(sug.map.stepExpected, 6);
  assert.equal(sug.map.pre, 3);
  assert.equal(Object.values(sug.fields)[0], 7);

  // без названия — 400; dryRun — сводка
  assert.equal((await u.tester.post(P + "/cases/import/mapped", { file, name: "z.xlsx", sheet: 1, headerRow: 1, map: { steps: 4 } })).status, 400);
  const body = { file, name: "z.xlsx", sheet: 1, headerRow: 1, map: sug.map, fields: sug.fields };
  r = await u.tester.post(P + "/cases/import/mapped", { ...body, dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.summary.create, 2);
  assert.equal(r.data.summary.folders, 2);
  assert.equal(r.data.preview[0].steps, 3);
  assert.equal(r.data.errorCount, 0);
  assert.equal((await u.tester.get(P + "/cases?q=" + encodeURIComponent("Вход по паролю"))).data.items.length, 0, "dryRun ничего не создаёт");

  r = await u.tester.post(P + "/cases/import/mapped", body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const found = (await u.tester.get(P + "/cases?q=" + encodeURIComponent("Вход по паролю"))).data.items[0];
  const c = (await u.tester.get(`${P}/cases/${found.num}`)).data;
  assert.equal(c.priority, "high");
  assert.equal(c.pre, "Есть пользователь");
  assert.deepEqual(c.stepList.map((s) => [s.action, s.data, s.expected]), [
    ["Открыть страницу", "", "Форма видна"], ["Ввести логин и пароль", "user / Qwerty1", "Поля заполнены"], ["Нажать «Войти»", "", "Открыт кабинет"]]);
  assert.deepEqual(c.tags, ["smoke", "auth"]);
  assert.equal(Object.values(c.fields)[0], "Web");
  const st = (await u.tester.get(P + "/state")).data;
  assert.ok(st.folders.some((f) => f.name === "Login"));
});

test("Excel: ошибки по строкам, неизвестный вариант поля, CSV через тот же мастер, права", async () => {
  const file = await xlsx([["Название", "Приоритет", "Платформа"], ["А", "сверхсрочно", "Web"], ["Б", "low", "Android"]]);
  const fid = (await u.tester.get(P + "/fields")).data.fields.find((f) => f.name === "Платформа").id;
  const r = await u.tester.post(P + "/cases/import/mapped", { file, name: "x.xlsx", sheet: 1, headerRow: 0, map: { title: 0, priority: 1 }, fields: { [fid]: 2 } });
  assert.equal(r.status, 400);
  assert.equal(r.data.errorCount, 2);
  assert.ok(r.data.errors.some((e) => /Android/.test(e.error)));
  const csv = Buffer.from("Summary;Action;Expected Result\nCSV-кейс;шаг 1;ок\n").toString("base64");
  const t = await u.tester.post(P + "/cases/import/table", { file: csv, name: "xray.csv" });
  assert.equal(t.data.sheets[0].suggest.map.title, 0);
  assert.equal((await u.viewer.post(P + "/cases/import/table", { file: csv, name: "x.csv" })).status, 403);
  assert.equal((await u.tester.post(P + "/cases/import/table", { file: Buffer.from("PK\x03\x04мусор").toString("base64"), name: "bad.xlsx" })).status, 400);
});
