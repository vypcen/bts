#!/usr/bin/env node
// Отправляет результаты автотестов в TestBall: каждый вызов — отдельный запуск («папка») во вкладке «Автотесты».
// Читает отчёты JUnit XML (их умеют писать pytest, Playwright, Jest, Cypress, JUnit/TestNG, Go и другие)
// и папки allure-results (allure-pytest, allure-junit5, allure-testng, allure-js, allure-kotlin…),
// к упавшим тестам прикладывает скриншоты и прочие файлы, указанные в отчёте.
// Зависимостей нет, нужен Node.js 20+: файл можно скопировать в любой проект с тестами.
//
//   node report.js [параметры] <отчёт.xml | папка с отчётами>... [-- команда запуска тестов]
//
// Примеры:
//   node report.js results/junit.xml
//   node report.js --title "Смоук перед релизом" results/ -- npx playwright test
//   node report.js allure-results/ -- pytest --alluredir=allure-results
//
// Подробности — в README, раздел «Автотесты».
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

const HELP = `Использование: node report.js [параметры] <отчёт.xml | папка | allure-results>... [-- команда]

  Папка, в которой есть *-result.json, читается как allure-results: шаги, вложения, параметры,
  повторы (retries) и метки. Связь с ручным кейсом: метка testball=LK-12 или ссылка type=tms с именем LK-12.


  --url URL         адрес TestBall (или TESTBALL_URL), например http://localhost:3000
  --token TOKEN     токен из вкладки «Автотесты» → «Подключить» (или TESTBALL_TOKEN)
  --project KEY     ключ проекта, например LK (или TESTBALL_PROJECT)
  --title TEXT      название запуска (по умолчанию «Локальный запуск <ветка>»)
  --build TEXT      сборка / версия (по умолчанию короткий хэш коммита)
  --env TEXT        окружение (по умолчанию имя компьютера и ОС)
  --branch TEXT     ветка (по умолчанию текущая ветка git)
  --run N           номер запуска, созданного в TestBall (или TESTBALL_RUN): так делает кнопка «Запустить в CI»
  --attach-all      прикладывать файлы и к прошедшим тестам, а не только к упавшим
  -- команда        сначала выполнить команду (запуск тестов), затем отправить отчёт.
                    Скрипт завершится с тем же кодом, что и команда.`;

const ATTACH_RE = /\[\[ATTACHMENT\|([^\]\r\n]+)\]\]/g;
const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".txt": "text/plain", ".log": "text/plain", ".json": "application/json", ".html": "text/html", ".xml": "application/xml",
  ".webm": "video/webm", ".mp4": "video/mp4", ".zip": "application/zip",
};

function parseArgs(argv) {
  const opts = { files: [], command: null };
  const flags = { "--url": "url", "--token": "token", "--project": "project", "--title": "title", "--build": "build", "--env": "env", "--branch": "branch", "--run": "run" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      opts.command = argv.slice(i + 1);
      break;
    }
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--attach-all") opts.attachAll = true;
    else if (flags[a]) opts[flags[a]] = argv[++i];
    else if (a.startsWith("--") && flags[a.split("=")[0]]) opts[flags[a.split("=")[0]]] = a.slice(a.indexOf("=") + 1);
    else if (a.startsWith("-")) throw new Error(`Неизвестный параметр ${a}. Справка: node report.js --help`);
    else opts.files.push(a);
  }
  return opts;
}

// ---------- разбор JUnit XML ----------
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()]);

// Небольшой разборщик XML: JUnit-отчёту хватает элементов, атрибутов, текста и CDATA
function parseXml(xml) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1 && top.name === m[2]) stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const el = { name: m[3], attrs, children: [], text: "" };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return root;
}

const child = (el, name) => el.children.find((c) => c.name === name);

function collectTests(file) {
  const dir = path.dirname(path.resolve(file));
  const out = [];
  const walk = (el, suite) => {
    for (const c of el.children) {
      if (c.name === "testsuites" || c.name === "testsuite") walk(c, c.name === "testsuite" ? c.attrs.name || suite : suite);
      else if (c.name === "testcase") out.push(toResult(c, suite, dir));
    }
  };
  walk(parseXml(fs.readFileSync(file, "utf8")), "");
  return out;
}

function toResult(tc, suite, dir) {
  const failure = child(tc, "failure");
  const error = child(tc, "error");
  const skipped = child(tc, "skipped");
  const problem = failure || error;
  const status = failure ? "failed" : error ? "broken" : skipped ? "skipped" : "passed";
  // Maven Surefire/pytest-rerunfailures: <flakyFailure>/<flakyError> у прошедшего теста, <rerunFailure>/<rerunError> у упавшего —
  // каждая такая запись — повторная попытка. Прошёл с повтора — нестабильный
  const reruns = (tc.children || []).filter((c) => /^(flaky|rerun)(Failure|Error)$/.test(c.name)).length;
  const out = (child(tc, "system-out")?.text || "").trim();
  const err = (child(tc, "system-err")?.text || "").trim();
  const text = (problem?.text || "").trim();
  const message = problem ? problem.attrs.message || text.split("\n")[0] : skipped ? skipped.attrs.message || "" : "";
  const details = problem ? [text, err && `--- stderr ---\n${err}`].filter(Boolean).join("\n\n") : "";

  // файлы: [[ATTACHMENT|путь]] в выводе теста или <property name="attachment" value="путь"/>
  const files = new Set();
  for (const src of [out, err, text]) for (const a of src.matchAll(ATTACH_RE)) files.add(a[1].trim());
  for (const p of child(tc, "properties")?.children || []) {
    if (p.name === "property" && /^attachment|screenshot/i.test(p.attrs.name || "") && p.attrs.value) files.add(p.attrs.value.trim());
  }
  return {
    suite: tc.attrs.classname || suite,
    name: tc.attrs.name || "(без названия)",
    file: tc.attrs.file || "",
    status,
    durationMs: Math.round((Number(tc.attrs.time) || 0) * 1000),
    retries: reruns,
    flaky: status === "passed" && reruns > 0,
    message: message.slice(0, 5000),
    details: details.slice(0, 50000),
    attachments: [...files].map((f) => (path.isAbsolute(f) ? f : [path.resolve(dir, f), path.resolve(f)].find(fs.existsSync) || path.resolve(dir, f))),
  };
}

function reportFiles(inputs) {
  const out = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) throw new Error(`Не найден файл отчёта: ${p}`);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (f.toLowerCase().endsWith(".xml")) out.push(path.join(p, f));
    } else out.push(p);
  }
  return out;
}

// ---------- отправка ----------
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

function client(base, token, project) {
  const root = `${base.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(project)}`;
  return async (method, url, body, headers = {}) => {
    let res;
    try {
      res = await fetch(root + url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(Buffer.isBuffer(body) ? headers : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`Нет связи с ${base}: ${e.cause?.message || e.message}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Ошибка сервера (${res.status})`), { status: res.status });
    return json;
  };
}

async function startRun(opts, call) {
  const branch = opts.branch ?? git("rev-parse --abbrev-ref HEAD");
  const fields = {
    build: opts.build ?? git("rev-parse --short HEAD"),
    env: opts.env ?? `${os.hostname()}, ${os.type()} ${os.release()}`,
    branch,
  };
  let run;
  if (/^\d+$/.test(String(opts.run || ""))) {
    // запуск уже создан (кнопкой «Запустить в CI» или testbolctl run start) — дописываем в него; ветку, сборку и окружение
    // меняем, только если их задали явно или их дал CI: догадки по git не должны затирать то, что указали при создании
    const given = Object.fromEntries(["build", "env", "branch"].filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]));
    await call("PATCH", `/autoruns/${opts.run}`, { ...given, state: "running" });
    run = { num: Number(opts.run), id: `${opts.project}-A${opts.run}` };
  } else {
    run = await call("POST", "/autoruns", { title: opts.title || `Локальный запуск${branch ? ` ${branch}` : ""}`, ...fields });
  }
  return run;
}

async function send(opts, tests) {
  const call = client(opts.url, opts.token, opts.project);
  const run = await startRun(opts, call);
  console.log(`[testball] запуск ${run.id}: результатов к отправке: ${tests.length}`);

  const ids = [];
  for (let i = 0; i < tests.length; i += 500) {
    const part = tests.slice(i, i + 500).map(({ attachments, ...t }) => t);
    ids.push(...(await call("POST", `/autoruns/${run.num}/results`, { results: part })).ids);
  }

  let sent = 0;
  for (const [i, t] of tests.entries()) {
    if (t.status === "passed" && !opts.attachAll) continue;
    for (const f of t.attachments) {
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
        console.warn(`[testball] не найден файл ${f} (тест «${t.name}»)`);
        continue;
      }
      try {
        await call("POST", `/autoruns/${run.num}/results/${ids[i]}/attachments`, fs.readFileSync(f), {
          "Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream",
          "X-Filename": encodeURIComponent(path.basename(f)),
          "X-Upload": "1",
        });
        sent++;
      } catch (e) {
        console.warn(`[testball] ${path.basename(f)}: ${e.message}`);
      }
    }
  }

  await call("PATCH", `/autoruns/${run.num}`, { state: "finished" });
  const c = { passed: 0, failed: 0, broken: 0, skipped: 0 };
  for (const t of tests) c[t.status]++;
  console.log(`[testball] готово: пройдено ${c.passed}, упало ${c.failed}, сломано ${c.broken}, пропущено ${c.skipped}, файлов ${sent}`);
  console.log(`[testball] ${opts.url.replace(/\/+$/, "")}/#/p/${encodeURIComponent(opts.project)}/auto/${run.num}`);
}

// ---------- allure-results ----------
const isAllureDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory() && fs.readdirSync(p).some((f) => f.endsWith("-result.json"));

function allureResults(dirs, since = 0) {
  const out = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith("-result.json")) continue;
      const file = path.join(dir, f);
      if (since && fs.statSync(file).mtimeMs < since) continue;
      try {
        out.push({ dir, json: JSON.parse(fs.readFileSync(file, "utf8")) });
      } catch {
        console.warn(`[testball] пропущен повреждённый ${f}`);
      }
    }
  }
  return out;
}

async function sendAllure(opts, items) {
  const call = client(opts.url, opts.token, opts.project);
  const run = await startRun(opts, call);
  console.log(`[testball] запуск ${run.id}: результатов Allure к отправке: ${items.length}`);
  // повторы одного теста должны попасть в одну пачку: группируем по historyId
  const groups = new Map();
  for (const it of items) {
    const k = it.json.historyId || it.json.uuid || Math.random();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const batches = [[]];
  for (const g of groups.values()) {
    if (batches[batches.length - 1].length + g.length > 300) batches.push([]);
    batches[batches.length - 1].push(...g);
  }
  const c = { passed: 0, failed: 0, broken: 0, skipped: 0 };
  let sent = 0;
  for (const batch of batches.filter((b) => b.length)) {
    const dirOf = new Map(batch.flatMap((it) => collectSources(it.json).map((src) => [src, it.dir])));
    const res = await call("POST", `/autoruns/${run.num}/allure`, { results: batch.map((it) => it.json) });
    for (const a of res.attachments) {
      if (a.status === "passed" && !opts.attachAll) continue;
      const file = path.join(dirOf.get(a.source) || batch[0].dir, a.source);
      if (!fs.existsSync(file)) continue;
      try {
        await call("POST", `/autoruns/${run.num}/results/${a.id}/attachments`, fs.readFileSync(file), {
          "Content-Type": a.type || MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "X-Filename": encodeURIComponent(a.name.includes(".") ? a.name : `${a.name}${path.extname(file)}`),
          "X-Upload": "1",
        });
        sent++;
      } catch (e) {
        console.warn(`[testball] ${a.name}: ${e.message}`);
      }
    }
    const statusOf = new Map();
    for (const it of batch) statusOf.set(it.json.historyId || it.json.uuid, it.json.status);
    for (const st of statusOf.values()) c[st === "unknown" ? "broken" : st] = (c[st === "unknown" ? "broken" : st] || 0) + 1;
  }
  await call("PATCH", `/autoruns/${run.num}`, { state: "finished" });
  console.log(`[testball] готово: пройдено ${c.passed}, упало ${c.failed}, сломано ${c.broken}, пропущено ${c.skipped}, файлов ${sent}`);
  console.log(`[testball] ${opts.url.replace(/\/+$/, "")}/#/p/${encodeURIComponent(opts.project)}/auto/${run.num}`);
}

function collectSources(r) {
  const out = [];
  const walk = (x) => {
    for (const a of Array.isArray(x?.attachments) ? x.attachments : []) if (a?.source) out.push(a.source);
    for (const s of Array.isArray(x?.steps) ? x.steps : []) walk(s);
  };
  walk(r);
  return out;
}

// Значения по умолчанию из CI: GitLab, GitHub Actions, Jenkins, TeamCity, Bitbucket, Azure DevOps
function ciDefaults(env = process.env) {
  const branch = env.CI_COMMIT_REF_NAME || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || env.BRANCH_NAME || env.GIT_BRANCH?.replace(/^origin\//, "")
    || env.BITBUCKET_BRANCH || env.BUILD_SOURCEBRANCHNAME || env.TEAMCITY_BUILD_BRANCH || undefined;
  const sha = env.CI_COMMIT_SHORT_SHA || env.GITHUB_SHA?.slice(0, 8) || env.GIT_COMMIT?.slice(0, 8) || env.BITBUCKET_COMMIT?.slice(0, 8) || env.BUILD_SOURCEVERSION?.slice(0, 8) || undefined;
  const pipeline = env.CI_PIPELINE_ID ? `GitLab #${env.CI_PIPELINE_ID}` : env.GITHUB_RUN_NUMBER ? `GitHub Actions #${env.GITHUB_RUN_NUMBER}`
    : env.BUILD_NUMBER && env.JENKINS_URL ? `Jenkins #${env.BUILD_NUMBER}` : env.BUILD_NUMBER ? `Сборка #${env.BUILD_NUMBER}` : env.BITBUCKET_BUILD_NUMBER ? `Bitbucket #${env.BITBUCKET_BUILD_NUMBER}` : undefined;
  const ci = Boolean(env.CI || env.JENKINS_URL || env.TEAMCITY_VERSION || env.TF_BUILD);
  return { branch, build: sha, title: pipeline ? `${pipeline}${branch ? ` · ${branch}` : ""}` : undefined, env: ci ? env.CI_ENVIRONMENT_NAME || env.CI_JOB_NAME || env.GITHUB_JOB || undefined : undefined };
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  // в CI — ветка, коммит и номер сборки из переменных окружения, если не заданы явно
  const ci = ciDefaults();
  for (const k of ["branch", "build", "title", "env"]) if (opts[k] === undefined && ci[k]) opts[k] = ci[k];
  if (opts.help) return console.log(HELP), 0;
  opts.url ??= process.env.TESTBALL_URL;
  opts.token ??= process.env.TESTBALL_TOKEN;
  opts.project ??= process.env.TESTBALL_PROJECT;
  opts.run ??= process.env.TESTBALL_RUN;
  const missing = [["url", "--url / TESTBALL_URL"], ["token", "--token / TESTBALL_TOKEN"], ["project", "--project / TESTBALL_PROJECT"]].filter(([k]) => !opts[k]);
  if (missing.length) throw new Error(`Не заданы: ${missing.map(([, l]) => l).join(", ")}. Справка: node report.js --help`);
  if (!opts.files.length) throw new Error("Укажите файл JUnit XML или папку с отчётами. Справка: node report.js --help");

  let code = 0;
  const allureDirs = opts.files.filter(isAllureDir);
  const startedAt = Date.now();
  if (opts.command?.length) {
    // старые отчёты не должны попасть в новый запуск
    const started = Date.now();
    const r = spawnSync(opts.command[0], opts.command.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
    if (r.error) throw new Error(`Не удалось выполнить ${opts.command[0]}: ${r.error.message}`);
    code = r.status ?? 1;
    // allure-results: папки появляются только после запуска
    if (opts.files.some(isAllureDir)) {
      const items = allureResults(opts.files.filter(isAllureDir), startedAt - 1000);
      if (!items.length) {
        console.error("[testball] команда не записала новых результатов Allure — отправлять нечего");
        return code || 1;
      }
      try {
        await sendAllure(opts, items);
      } catch (e) {
        console.error(`[testball] не удалось отправить результаты: ${e.message}`);
        return code || 1;
      }
      return code;
    }
    const fresh = reportFiles(opts.files).filter((f) => fs.statSync(f).mtimeMs >= started - 1000);
    if (!fresh.length) {
      console.error("[testball] команда не записала новый отчёт JUnit — отправлять нечего. Проверьте путь к отчёту и настройки репортера");
      return code || 1;
    }
    opts.files = fresh;
  }

  if (allureDirs.length) {
    const items = allureResults(allureDirs);
    if (!items.length) throw new Error("В allure-results нет ни одного *-result.json");
    try {
      await sendAllure(opts, items);
    } catch (e) {
      console.error(`[testball] не удалось отправить результаты: ${e.message}`);
      return 1;
    }
    return 0;
  }
  const tests = reportFiles(opts.files).flatMap(collectTests);
  if (!tests.length) throw new Error("В отчётах нет ни одного <testcase>");
  try {
    await send(opts, tests);
  } catch (e) {
    console.error(`[testball] не удалось отправить результаты: ${e.message}`);
    return code || 1;
  }
  return code;
}

// Файл можно запускать напрямую или подключать (так его использует утилита testbolctl: testbolctl upload …)
module.exports = { main, parseArgs, ciDefaults, HELP };
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[testball] ${e.message}`);
      process.exit(1);
    }
  );
}
