#!/usr/bin/env node
// Отправляет результаты автотестов в TestBol: каждый вызов — отдельный запуск («папка») во вкладке «Автотесты».
// Читает отчёты JUnit XML (их умеют писать pytest, Playwright, Jest, Cypress, JUnit/TestNG, Go и другие),
// к упавшим тестам прикладывает скриншоты и прочие файлы, указанные в отчёте.
// Зависимостей нет, нужен Node.js 20+: файл можно скопировать в любой проект с тестами.
//
//   node report.js [параметры] <отчёт.xml | папка с отчётами>... [-- команда запуска тестов]
//
// Примеры:
//   node report.js results/junit.xml
//   node report.js --title "Смоук перед релизом" results/ -- npx playwright test
//
// Подробности — в README, раздел «Автотесты».
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

const HELP = `Использование: node report.js [параметры] <отчёт.xml | папка>... [-- команда]

  --url URL         адрес TestBol (или TESTBOL_URL), например http://localhost:3000
  --token TOKEN     токен из вкладки «Автотесты» → «Подключить» (или TESTBOL_TOKEN)
  --project KEY     ключ проекта, например LK (или TESTBOL_PROJECT)
  --title TEXT      название запуска (по умолчанию «Локальный запуск <ветка>»)
  --build TEXT      сборка / версия (по умолчанию короткий хэш коммита)
  --env TEXT        окружение (по умолчанию имя компьютера и ОС)
  --branch TEXT     ветка (по умолчанию текущая ветка git)
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
  const flags = { "--url": "url", "--token": "token", "--project": "project", "--title": "title", "--build": "build", "--env": "env", "--branch": "branch" };
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

async function send(opts, tests) {
  const call = client(opts.url, opts.token, opts.project);
  const branch = opts.branch ?? git("rev-parse --abbrev-ref HEAD");
  const run = await call("POST", "/autoruns", {
    title: opts.title || `Локальный запуск${branch ? ` ${branch}` : ""}`,
    build: opts.build ?? git("rev-parse --short HEAD"),
    env: opts.env ?? `${os.hostname()}, ${os.type()} ${os.release()}`,
    branch,
  });
  console.log(`[testbol] запуск ${run.id}: результатов к отправке: ${tests.length}`);

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
        console.warn(`[testbol] не найден файл ${f} (тест «${t.name}»)`);
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
        console.warn(`[testbol] ${path.basename(f)}: ${e.message}`);
      }
    }
  }

  await call("PATCH", `/autoruns/${run.num}`, { state: "finished" });
  const c = { passed: 0, failed: 0, broken: 0, skipped: 0 };
  for (const t of tests) c[t.status]++;
  console.log(`[testbol] готово: пройдено ${c.passed}, упало ${c.failed}, сломано ${c.broken}, пропущено ${c.skipped}, файлов ${sent}`);
  console.log(`[testbol] ${opts.url.replace(/\/+$/, "")}/#/p/${encodeURIComponent(opts.project)}/auto/${run.num}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP), 0;
  opts.url ??= process.env.TESTBOL_URL;
  opts.token ??= process.env.TESTBOL_TOKEN;
  opts.project ??= process.env.TESTBOL_PROJECT;
  const missing = [["url", "--url / TESTBOL_URL"], ["token", "--token / TESTBOL_TOKEN"], ["project", "--project / TESTBOL_PROJECT"]].filter(([k]) => !opts[k]);
  if (missing.length) throw new Error(`Не заданы: ${missing.map(([, l]) => l).join(", ")}. Справка: node report.js --help`);
  if (!opts.files.length) throw new Error("Укажите файл JUnit XML или папку с отчётами. Справка: node report.js --help");

  let code = 0;
  if (opts.command?.length) {
    // старые отчёты не должны попасть в новый запуск
    const started = Date.now();
    const r = spawnSync(opts.command[0], opts.command.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
    if (r.error) throw new Error(`Не удалось выполнить ${opts.command[0]}: ${r.error.message}`);
    code = r.status ?? 1;
    const fresh = reportFiles(opts.files).filter((f) => fs.statSync(f).mtimeMs >= started - 1000);
    if (!fresh.length) {
      console.error("[testbol] команда не записала новый отчёт JUnit — отправлять нечего. Проверьте путь к отчёту и настройки репортера");
      return code || 1;
    }
    opts.files = fresh;
  }

  const tests = reportFiles(opts.files).flatMap(collectTests);
  if (!tests.length) throw new Error("В отчётах нет ни одного <testcase>");
  try {
    await send(opts, tests);
  } catch (e) {
    console.error(`[testbol] не удалось отправить результаты: ${e.message}`);
    return code || 1;
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[testbol] ${e.message}`);
    process.exit(1);
  }
);
