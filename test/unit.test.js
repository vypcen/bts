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

test("версии согласованы: package.json, web, Helm, CHANGELOG", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const v = require("../package.json").version;
  assert.equal(require("../web/package.json").version, v, "web/package.json");
  const chart = fs.readFileSync(path.join(root, "deploy/helm/testball/Chart.yaml"), "utf8");
  assert.match(chart, new RegExp(`^appVersion: "${v.replace(/\./g, "\\.")}"$`, "m"), "Chart.yaml appVersion");
  const values = fs.readFileSync(path.join(root, "deploy/helm/testball/values.yaml"), "utf8");
  assert.match(values, new RegExp(`tag: "${v.replace(/\./g, "\\.")}"`), "values.yaml image.tag");
  assert.ok(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").includes(`## [${v}]`), "раздел в CHANGELOG.md");
});

test("сравнение версий", () => {
  const { compare } = require("../server/version");
  assert.equal(compare("1.10.0", "1.9.3"), 1);
  assert.equal(compare("1.1.0", "1.1.0"), 0);
  assert.equal(compare("1.1.0-rc.1", "1.1.0"), -1);
  assert.equal(compare("2.0.0", "10.0.0"), -1);
});

test("лицензия: подпись, срок, льготный период, адрес", () => {
  const license = require("../server/license");
  const pem = require("node:fs").readFileSync(require("node:path").join(__dirname, "fixtures", "license-test-private.pem"), "utf8");
  const terms = { id: "T-1", customer: "ООО Тест", edition: "enterprise", full: 20, view: null, issued: "2026-01-01", expires: "2026-12-31" };
  const key = license.sign(terms, pem);
  assert.equal(license.verify(key).terms.full, 20);
  assert.equal(license.verify(key).test, true);
  // подделка: другое число мест с той же подписью
  const [p, , sig] = key.split(".");
  const forged = `${p}.${Buffer.from(JSON.stringify({ ...terms, full: 999 })).toString("base64url")}.${sig}`;
  assert.throws(() => license.verify(forged), /Подпись ключа не сходится/);
  assert.throws(() => license.verify("abc"), /начинается с TB1/);
  const at = (d) => license.evaluate(key, Date.parse(d));
  assert.equal(at("2026-06-01").status, "active");
  assert.equal(at("2026-06-01").full, 20);
  assert.match(at("2026-12-15").notice, /заканчивается 2026-12-31/);
  assert.equal(at("2027-01-05").status, "grace");
  assert.equal(at("2027-01-05").full, 20);
  const expired = at("2027-02-01");
  assert.equal(expired.status, "expired");
  assert.equal(expired.full, license.COMMUNITY.full);
  assert.equal(license.evaluate(null).status, "none");
  assert.equal(license.evaluate(forged).status, "invalid");
  const bound = license.sign({ ...terms, host: "qa.example.ru", expires: null }, pem);
  const prev = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "https://other.example.ru";
  assert.equal(license.evaluate(bound).status, "wrong-host");
  process.env.PUBLIC_URL = "https://qa.example.ru/";
  assert.equal(license.evaluate(bound).status, "active");
  if (prev === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = prev;
  // в production тестовый ключ не принимается
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  assert.throws(() => license.verify(key), /Подпись/);
  process.env.NODE_ENV = env;
  if (env === undefined) delete process.env.NODE_ENV;
});

test("справка: все документы открываются, ссылки между ними ведут на существующие разделы", () => {
  const help = require("../server/help");
  const rendered = Object.fromEntries(Object.keys(help.PAGES).map((k) => [k, help.render(k)]));
  const broken = [];
  for (const [page, html] of Object.entries(rendered)) {
    for (const m of html.matchAll(/href="#\/help\/(\w+)(?:\/([^"]+))?"/g)) {
      const target = rendered[m[1]];
      if (!target) broken.push(`${page} → ${m[1]} (нет страницы)`);
      else if (m[2] && !target.includes(`id="h-${decodeURIComponent(m[2])}"`)) broken.push(`${page} → ${m[1]}#${decodeURIComponent(m[2])}`);
    }
  }
  assert.deepEqual(broken, []);
  assert.equal(help.slug("Единый вход: OpenID Connect, LDAP / AD, Kerberos"), "единый-вход-openid-connect-ldap--ad-kerberos");
});

test("журнал: метка [компонент] и ошибка разбираются в поля", () => {
  const { spawnSync } = require("node:child_process");
  const code = `const log=require("./server/log");log.install();console.error("[trackers] автосоздание:", Object.assign(new Error("нет связи"),{code:"ECONNREFUSED"}));console.log("просто строка", {a:1});`;
  const r = spawnSync(process.execPath, ["-e", code], { cwd: require("node:path").join(__dirname, ".."), env: { ...process.env, LOG_FORMAT: "json" }, encoding: "utf8" });
  const err = JSON.parse(r.stderr.trim().split("\n")[0]);
  assert.equal(err.level, "error");
  assert.equal(err.component, "trackers");
  assert.equal(err.msg, "автосоздание: нет связи");
  assert.equal(err.err, "ECONNREFUSED");
  assert.match(err.stack, /Error: нет связи/);
  const info = JSON.parse(r.stdout.trim());
  assert.equal(info.component, "server");
  assert.equal(info.msg, "просто строка { a: 1 }");
});

test("TOTP по RFC 6238 и политика паролей", () => {
  const s = require("../server/security");
  // эталон из RFC 6238: секрет «12345678901234567890», T=59 с → 94287082 (последние 6 цифр)
  const secret = s.base32(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(s.totp(secret, Math.floor(59 / 30)), "287082");
  assert.equal(s.totp(secret, Math.floor(1111111109 / 30)), "081804");
  const now = 1111111109 * 1000;
  assert.equal(s.matchTotp(secret, "081804", -1, now), Math.floor(1111111109 / 30));
  assert.equal(s.matchTotp(secret, "081 804", -1, now), Math.floor(1111111109 / 30), "пробелы не мешают");
  assert.equal(s.matchTotp(secret, "081804", Math.floor(1111111109 / 30), now), null, "повтор кода");
  assert.equal(s.matchTotp(secret, "000000", -1, now), null);
  assert.deepEqual(s.unbase32(secret), Buffer.from("12345678901234567890"));
  assert.equal(s.checkPassword("Hoshi-2026", { login: "ivanova" }), null);
  assert.match(s.checkPassword("12345678"), /не только буквы или не только цифры/);
  assert.match(s.checkPassword("P@ssw0rd"), /распространённых/);
});
