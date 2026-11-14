// Модульные тесты чистых функций сервера: без базы и сети
const test = require("node:test");
const assert = require("node:assert/strict");

const checklist = require("../server/checklist");
const flaky = require("../server/flaky");
const { render, matches } = require("../server/webhooks");
const { parseCsv, csvCell } = require("../server/caseio");
const { weight } = require("../server/distribute");
const { escapeFilter, normalizeLogin, roleFromGroups } = require("../server/sso");
const { Limiter } = require("../server/limits");
const xml = require("../server/xml");

test("чек-лист: пункты очищаются от нумерации, маркеров и повторов", () => {
  assert.deepEqual(checklist.items("1. Вход\n- Выход\n[ ] Профиль\n\n• Вход\n2) Настройки"), ["Вход", "Выход", "Профиль", "Настройки"]);
  assert.equal(checklist.check("").error, "Добавьте хотя бы один пункт чек-листа");
  assert.equal(checklist.check(Array.from({ length: 201 }, (_, i) => `п${i}`).join("\n")).error.includes("200"), true);
});

test("чек-лист: итог по пунктам", () => {
  const list = ["a", "b", "c"];
  assert.equal(checklist.verdict(list, {}), "untested");
  assert.equal(checklist.verdict(list, { a: "passed", b: "failed", c: "passed" }), "failed");
  assert.equal(checklist.verdict(list, { a: "passed", b: "blocked" }), "blocked");
  assert.equal(checklist.verdict(list, { a: "passed", b: "passed" }), "untested");
  assert.equal(checklist.verdict(list, { a: "passed", b: "skipped", c: "passed" }), "passed");
  assert.equal(checklist.verdict(list, { a: "skipped", b: "skipped", c: "skipped" }), "skipped");
});

test("flaky: ретрай — сразу нестабилен", () => {
  const s = flaky.score([{ status: "passed" }, { status: "passed", flaky: true }]);
  assert.equal(s.flaky, true);
  assert.match(s.reason, /повторной попытки/);
});

test("flaky: один переход сломали→починили — не нестабильность", () => {
  const h = ["passed", "passed", "failed", "failed", "passed", "passed"].map((status) => ({ status }));
  assert.equal(flaky.score(h).flaky, false);
});

test("flaky: частые смены и разный результат на одной сборке", () => {
  const h = ["passed", "failed", "passed", "failed", "passed"].map((status) => ({ status }));
  assert.equal(flaky.score(h).flaky, true);
  const same = flaky.score([{ status: "passed", build: "a1" }, { status: "failed", build: "a1" }]);
  assert.equal(same.flaky, true);
  assert.match(same.reason, /одной сборке/);
});

test("вебхуки: подстановки и фильтры шаблона", () => {
  const ctx = { bug: { title: 'Кнопка "Войти"', severity: "critical" }, project: { key: "LK" }, n: null };
  assert.equal(render("{{bug.title | jsonstr}}", ctx), 'Кнопка \\"Войти\\"');
  assert.equal(render("{{project.key | lower}}-{{n | default:\"нет\"}}", ctx), "lk-нет");
  assert.equal(render("{{missing}}", ctx), "");
  assert.equal(matches({ "bug.severity": ["critical", "blocker"] }, ctx), true);
  assert.equal(matches({ "bug.severity": ["minor"] }, ctx), false);
  assert.equal(matches({}, ctx), true);
});

test("CSV: разбор кавычек, переводов строк и разделителя", () => {
  const rows = parseCsv('Название;Шаги\n"Вход; по паролю";"1. Открыть\n2. Ввести"\n');
  assert.deepEqual(rows.map((r) => r.cells), [["Название", "Шаги"], ["Вход; по паролю", "1. Открыть\n2. Ввести"]]);
  assert.equal(rows[1].line, 2);
  assert.match(csvCell("=SUM(A1)"), /'=SUM/);
});

test("распределение: трудоёмкость по шагам и пунктам", () => {
  assert.equal(weight({ kind: "case", steps: "a\nb\n\nc" }), 3);
  assert.equal(weight({ kind: "case", steps: "" }), 1);
  assert.equal(weight({ kind: "checklist", steps: "1. a\n2. b" }), 2);
});

test("SSO: экранирование LDAP-фильтра и логины", () => {
  assert.equal(escapeFilter("a*(b)\\"), "a\\2a\\28b\\29\\5c");
  assert.equal(normalizeLogin("CORP\\Ivanov"), "ivanov");
  assert.equal(normalizeLogin("Ivanov@corp.local"), "ivanov");
  assert.equal(normalizeLogin("Ivanov@corp.local", true), "ivanov@corp.local");
  assert.equal(typeof roleFromGroups, "function");
});

test("лимитер: блокирует после max событий", () => {
  const l = new Limiter(2, 60000);
  assert.equal(l.take("k"), true);
  assert.equal(l.take("k"), true);
  assert.equal(l.take("k"), false);
  l.clear("k");
  assert.equal(l.take("k"), true);
});

test("XML: разбор и текст узлов", () => {
  const doc = xml.parse("<?xml version=\"1.0\"?><a><b x=\"1\">т&amp;т</b><b>2</b></a>");
  const bs = xml.children(xml.child(doc, "a"), "b");
  assert.equal(bs[0].attrs.x, "1");
  assert.equal(bs.length, 2);
  assert.equal(xml.text(bs[0]), "т&т");
});
