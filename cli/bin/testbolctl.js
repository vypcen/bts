#!/usr/bin/env node
// testbolctl — утилита TestBall QA для CI: загрузка результатов автотестов и управление запусками.
// Зависимостей нет, нужен Node.js 20+ (или самостоятельный бинарник, см. README).
//
//   testbolctl upload [параметры] <junit.xml | папка | allure-results>... [-- команда запуска тестов]
//   testbolctl run start --title "Nightly"        создать запуск, напечатать номер (для TESTBALL_RUN)
//   testbolctl run finish [--run N] [--failed]    завершить запуск
//   testbolctl run status [--run N] [--fail-on failed|any]   сводка; код выхода 1, если есть падения
//   testbolctl check                               проверить адрес, токен и проект
//
// Общие параметры: --url / TESTBALL_URL, --token / TESTBALL_TOKEN, --project / TESTBALL_PROJECT
const fs = require("fs");
const path = require("path");

const VERSION = "1.1.0";
// report.js лежит в lib/ в npm-пакете и в scripts/ в репозитории TestBall
const report = require(fs.existsSync(path.join(__dirname, "../lib/report.js")) ? "../lib/report.js" : "../../scripts/report.js");

const HELP = `testbolctl ${VERSION} — TestBall QA из командной строки и CI

Команды:
  upload <отчёты>... [-- команда]   отправить JUnit XML или allure-results (один вызов — один запуск)
  run start [--title T]             создать запуск автотестов и напечатать его номер
  run finish [--run N] [--failed]   завершить запуск (--failed — запуск сорвался)
  run status [--run N] [--fail-on failed|any] [--json]
                                    сводка запуска; с --fail-on код выхода 1 при падениях
                                    (failed — упавшие и сломанные кроме карантина, any — включая карантин)
  check                             проверить адрес, токен и доступ к проекту
  help [команда]                    справка

Общие параметры (или переменные окружения):
  --url URL        TESTBALL_URL       адрес TestBall
  --token TOKEN    TESTBALL_TOKEN     токен: «Автотесты» → «Подключить»
  --project KEY    TESTBALL_PROJECT   ключ проекта
  --run N          TESTBALL_RUN       номер запуска (run finish/status, upload в существующий запуск)

В CI ветка, коммит и номер сборки подставляются сами (GitLab, GitHub Actions, Jenkins, TeamCity, Bitbucket, Azure DevOps).

Пример для GitLab CI:
  export TESTBALL_RUN=$(testbolctl run start --title "Nightly e2e")
  testbolctl upload results/junit.xml -- npx playwright test
  testbolctl run finish
  testbolctl run status --fail-on failed`;

function args(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === "--") { out["--"] = list.slice(i + 1); break; }
    if (a.startsWith("--")) {
      const [k, v] = a.includes("=") ? [a.slice(2, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a.slice(2), list[i + 1] && !list[i + 1].startsWith("--") ? list[++i] : true];
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

function conf(a) {
  const c = {
    url: a.url || process.env.TESTBALL_URL, token: a.token || process.env.TESTBALL_TOKEN,
    project: a.project || process.env.TESTBALL_PROJECT, run: a.run || process.env.TESTBALL_RUN,
  };
  const miss = [["url", "--url / TESTBALL_URL"], ["token", "--token / TESTBALL_TOKEN"], ["project", "--project / TESTBALL_PROJECT"]].filter(([k]) => !c[k]);
  if (miss.length) throw new Error(`Не заданы: ${miss.map(([, l]) => l).join(", ")}`);
  c.base = `${String(c.url).replace(/\/+$/, "")}/api/projects/${encodeURIComponent(c.project)}`;
  return c;
}

async function call(c, method, p, body) {
  let res;
  try {
    res = await fetch(c.base + p, {
      method, headers: { Authorization: `Bearer ${c.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Нет связи с ${c.url}: ${e.cause?.code || e.cause?.message || e.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `Ошибка сервера (${res.status})`), { status: res.status });
  return json;
}

const needRun = (c) => {
  if (!/^\d+$/.test(String(c.run || ""))) throw new Error("Не задан номер запуска: --run N или TESTBALL_RUN (его печатает testbolctl run start)");
  return Number(c.run);
};

async function main(argv) {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    if (sub === "upload") console.log(report.HELP.replace(/node report\.js/g, "testbolctl upload"));
    else console.log(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "version") return console.log(VERSION), 0;

  if (cmd === "upload") return report.main(argv.slice(1));

  if (cmd === "check") {
    const c = conf(args(argv.slice(1)));
    const r = await fetch(`${String(c.url).replace(/\/+$/, "")}/healthz`).catch((e) => { throw new Error(`Нет связи с ${c.url}: ${e.cause?.code || e.message}`); });
    if (!r.ok) throw new Error(`${c.url} отвечает ${r.status}: это точно адрес TestBall?`);
    // токен результатов умеет создавать запуск; проверяем без создания — запросом сводки несуществующего запуска
    try {
      await call(c, "GET", "/autoruns/0/summary");
    } catch (e) {
      if (e.status === 404 && /Запуск не найден/.test(e.message)) { console.log(`OK: ${c.url}, проект ${c.project}, токен принят`); return 0; }
      if (e.status === 401) throw new Error("Токен не принят: проверьте TESTBALL_TOKEN (истёк, отозван или пользователь заблокирован)");
      if (e.status === 404) throw new Error(`Проект ${c.project} не найден или токен выдан для другого проекта`);
      throw e;
    }
    return 0;
  }

  if (cmd === "run") {
    const a = args(rest);
    const c = conf(a);
    if (sub === "start") {
      const ci = report.ciDefaults();
      const body = {
        title: a.title || ci.title || "Запуск автотестов", build: a.build || ci.build || "", env: a.env || ci.env || "", branch: a.branch || ci.branch || "",
        scope: a.scope || "", url: a["app-url"] || "",
      };
      const r = await call(c, "POST", "/autoruns", body);
      // на stdout — только номер, чтобы можно было написать TESTBALL_RUN=$(testbolctl run start)
      console.log(r.num);
      console.error(`[testball] создан запуск ${r.id}: ${String(c.url).replace(/\/+$/, "")}/#/p/${encodeURIComponent(c.project)}/auto/${r.num}`);
      return 0;
    }
    if (sub === "finish") {
      const n = needRun(c);
      await call(c, "PATCH", `/autoruns/${n}`, { state: a.failed ? "failed" : "finished" });
      console.error(`[testball] запуск ${c.project}-A${n} завершён${a.failed ? " (сорвался)" : ""}`);
      return 0;
    }
    if (sub === "status") {
      const n = needRun(c);
      const s = await call(c, "GET", `/autoruns/${n}/summary`);
      if (a.json) console.log(JSON.stringify(s, null, 2));
      else {
        const k = s.counts;
        console.log(`${s.id} «${s.title}»: ${s.state}. Всего ${k.total}: пройдено ${k.passed}, упало ${k.failed}, сломано ${k.broken}, пропущено ${k.skipped}${k.flaky ? `, с повтора ${k.flaky}` : ""}`);
      }
      const mode = a["fail-on"];
      if (mode && !["failed", "any"].includes(mode)) throw new Error("--fail-on: failed или any");
      const bad = mode === "any" ? s.counts.failed + s.counts.broken : mode === "failed" ? s.failedBlocking : 0;
      if (bad) console.error(`[testball] падений: ${bad} — код выхода 1`);
      return bad ? 1 : 0;
    }
    throw new Error("run: start, finish или status");
  }
  throw new Error(`Неизвестная команда «${cmd}». Справка: testbolctl help`);
}

module.exports = { main };
if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(`[testball] ${e.message}`); process.exit(1); }
  );
}
