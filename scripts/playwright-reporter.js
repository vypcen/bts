// Репортер Playwright для TestBol: каждый запуск `npx playwright test` становится отдельной папкой во вкладке «Автотесты».
// Результаты уходят по ходу запуска, к упавшим тестам прикладываются скриншоты, видео и трейс.
// Зависимостей нет: положите файл рядом с playwright.config и подключите его:
//
//   reporter: [["list"], ["./testbol-reporter.js"]],
//   use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
//
// Настройки — переменные окружения TESTBOL_URL, TESTBOL_TOKEN, TESTBOL_PROJECT (или опции репортера url, token, project).
// Необязательные: TESTBOL_TITLE, TESTBOL_BUILD, TESTBOL_ENV, TESTBOL_BRANCH,
// TESTBOL_APP_URL — адрес тестируемого приложения (или опция appUrl; по умолчанию baseURL из конфига).
// Шаги теста (test.step) уходят вместе с результатом: видно, какие шаги прошли и на каком тест упал.
// Если настройки не заданы, репортер молча выключается и тесты работают как обычно.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ANSI = /\x1b\[[0-9;]*m/g;
const clean = (s) => (s || "").replace(ANSI, "");
const BATCH = 50;
const FLUSH_MS = 2000;
// Файлы крупнее не отправляем: сервер их всё равно не примет (MAX_UPLOAD_MB, по умолчанию 20 МБ)
const MAX_FILE = Number(process.env.TESTBOL_MAX_FILE_MB || 20) * 1024 * 1024;
const MAX_STEPS = 300;

// Из дерева шагов Playwright берём только test.step. Хуки (beforeEach), фикстуры, действия и expect
// не показываем, но test.step внутри них поднимаем на уровень выше
function collectSteps(steps, budget = { left: MAX_STEPS }) {
  const out = [];
  for (const s of steps || []) {
    if (budget.left <= 0) break;
    if (s.category !== "test.step") {
      out.push(...collectSteps(s.steps, budget));
      continue;
    }
    budget.left--;
    const skipped = s.annotations?.some((a) => a.type === "skip");
    out.push({
      title: clean(s.title).slice(0, 500),
      status: s.error ? "failed" : skipped ? "skipped" : "passed",
      durationMs: Math.max(0, Math.round(s.duration)),
      error: s.error ? clean(s.error.message).split("\n").find(Boolean)?.slice(0, 2000) || "" : "",
      steps: collectSteps(s.steps, budget),
    });
  }
  return out;
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

class TestbolReporter {
  constructor(options = {}) {
    const env = process.env;
    this.url = (options.url || env.TESTBOL_URL || "").replace(/\/+$/, "");
    this.token = options.token || env.TESTBOL_TOKEN || "";
    this.project = options.project || env.TESTBOL_PROJECT || "";
    this.opts = {
      title: options.title || env.TESTBOL_TITLE,
      build: options.build ?? env.TESTBOL_BUILD,
      env: options.env ?? env.TESTBOL_ENV,
      branch: options.branch ?? env.TESTBOL_BRANCH,
      appUrl: options.appUrl ?? env.TESTBOL_APP_URL,
    };
    // `--list` только показывает тесты, не запуская их: такой «запуск» в TestBol не нужен
    this.enabled = Boolean(this.url && this.token && this.project) && !process.argv.includes("--list");
    this.queue = []; // результаты, ещё не отправленные на сервер
    this.reported = new Set(); // тесты с итоговым результатом
    this.chain = Promise.resolve(); // все обращения к серверу идут по очереди
    this.timer = null;
    this.stats = { passed: 0, failed: 0, broken: 0, skipped: 0, files: 0 };
  }

  printsToStdio() {
    return false;
  }

  log(msg) {
    console.log(`[testbol] ${msg}`);
  }

  async call(method, url, body, headers) {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(`${this.url}/api/projects/${encodeURIComponent(this.project)}${url}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(raw ? headers : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `ошибка сервера (${res.status})`);
    return json;
  }

  // Ставит действие в общую очередь. Ошибка отправки не роняет тесты: пишем предупреждение и идём дальше
  enqueue(fn) {
    this.chain = this.chain.then(fn).catch((e) => this.log(`не удалось отправить данные: ${e.cause?.message || e.message}`));
    return this.chain;
  }

  onBegin(config, suite) {
    this.root = suite;
    this.rootDir = config.rootDir;
    if (!this.enabled) return;
    // только проекты, которые реально запускаются (с учётом --project), а не все из конфига
    const running = suite.suites.filter((s) => s.allTests().length).map((s) => s.project());
    const urls = [...new Set(running.map((p) => p?.use?.baseURL).filter(Boolean))];
    const branch = this.opts.branch ?? git("rev-parse --abbrev-ref HEAD");
    this.enqueue(async () => {
      this.run = await this.call("POST", "/autoruns", {
        title: this.opts.title || `Локальный запуск${branch ? ` ${branch}` : ""}`,
        build: this.opts.build ?? git("rev-parse --short HEAD"),
        env: this.opts.env ?? "",
        branch,
        scope: running.map((p) => p?.name).filter(Boolean).join(", "),
        url: this.opts.appUrl ?? urls.join(", "),
      });
      this.log(`запуск ${this.run.id}: ${this.url}/#/p/${encodeURIComponent(this.project)}/auto/${this.run.num}`);
    });
  }

  onTestEnd(test, result) {
    if (!this.enabled) return;
    // при повторах onTestEnd приходит на каждую попытку — ждём итоговую
    const final = result.status === "skipped" || result.status === test.expectedStatus || result.retry >= test.retries;
    if (!final) return;
    this.reported.add(test.id);
    this.push(this.toResult(test, result));
  }

  toResult(test, result) {
    const [, projectName, file, ...titles] = test.titlePath();
    const outcome = test.outcome();
    const err = result.errors?.[0] || result.error;
    let status = "passed";
    let message = "";
    if (outcome === "skipped") {
      status = "skipped";
      message = test.annotations.find((a) => a.type === "skip" || a.type === "fixme")?.description || "";
    } else if (outcome === "unexpected") {
      const text = clean(err?.message);
      // упала проверка expect — это «упал»; таймаут или исключение в самом тесте — «сломан»
      status = result.status === "failed" && /expect\(|toHave|toBe|toEqual|toMatch|toContain/.test(text) ? "failed" : result.status === "interrupted" ? "skipped" : "broken";
      message = result.status === "timedOut" ? `Тест превысил таймаут ${test.timeout} мс` : result.status === "interrupted" ? "Запуск прерван" : text.split("\n")[0];
    } else if (outcome === "flaky") {
      message = `Нестабильный: прошёл с ${result.retry + 1}-й попытки`;
    }
    const details = status === "failed" || status === "broken"
      ? [
          ...result.errors.map((e) => clean([e.message, e.snippet, e.location && `at ${path.relative(this.rootDir, e.location.file)}:${e.location.line}:${e.location.column}`].filter(Boolean).join("\n\n"))),
          result.stderr.length && `--- stderr ---\n${result.stderr.map(String).join("").slice(-5000)}`,
        ].filter(Boolean).join("\n\n────────\n\n")
      : "";
    return {
      // проект (браузер) входит в набор: «вход» в desktop и в mobile — разные тесты
      suite: [projectName && `[${projectName}]`, file].filter(Boolean).join(" "),
      name: titles.join(" › ") || test.title,
      file: test.location ? `${path.relative(this.rootDir, test.location.file)}:${test.location.line}` : "",
      status,
      durationMs: result.duration,
      message: message.slice(0, 5000),
      details: details.slice(0, 50000),
      steps: collectSteps(result.steps),
      attachments: status === "failed" || status === "broken" ? result.attachments : [],
    };
  }

  push(r) {
    this.stats[r.status]++;
    this.queue.push(r);
    if (this.queue.length >= BATCH) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const part = this.queue.splice(0);
    if (!part.length) return this.chain;
    return this.enqueue(async () => {
      if (!this.run) return;
      const { ids } = await this.call("POST", `/autoruns/${this.run.num}/results`, {
        results: part.map(({ attachments, ...r }) => r),
      });
      for (const [i, r] of part.entries()) for (const a of r.attachments) await this.upload(ids[i], a);
    });
  }

  async upload(resultId, a) {
    let body = a.body;
    let name = a.name;
    if (a.path) {
      if (!fs.existsSync(a.path)) return;
      if (fs.statSync(a.path).size > MAX_FILE) return this.log(`${path.basename(a.path)} больше ${MAX_FILE / 1024 / 1024} МБ, пропускаем`);
      body = fs.readFileSync(a.path);
      name = a.name === "screenshot" || a.name === "video" || a.name === "trace" ? `${a.name}${path.extname(a.path)}` : path.basename(a.path);
    }
    if (!body?.length) return;
    try {
      await this.call("POST", `/autoruns/${this.run.num}/results/${resultId}/attachments`, Buffer.from(body), {
        "Content-Type": a.contentType || "application/octet-stream",
        "X-Filename": encodeURIComponent(name),
        "X-Upload": "1",
      });
      this.stats.files++;
    } catch (e) {
      this.log(`${name}: ${e.message}`);
    }
  }

  async onEnd() {
    if (!this.enabled) return;
    // тесты, до которых не дошло дело (прервали запуск, сработал maxFailures), — «не выполнялся»
    for (const test of this.root?.allTests() || []) {
      if (this.reported.has(test.id)) continue;
      const [, projectName, file, ...titles] = test.titlePath();
      this.push({
        suite: [projectName && `[${projectName}]`, file].filter(Boolean).join(" "),
        name: titles.join(" › ") || test.title,
        file: test.location ? `${path.relative(this.rootDir, test.location.file)}:${test.location.line}` : "",
        status: "skipped",
        durationMs: 0,
        message: "Не выполнялся: запуск остановлен раньше",
        details: "",
        steps: [],
        attachments: [],
      });
    }
    await this.flush();
    await this.enqueue(async () => {
      if (!this.run) return;
      await this.call("PATCH", `/autoruns/${this.run.num}`, { state: "finished" });
      const s = this.stats;
      this.log(`${this.run.id} готов: пройдено ${s.passed}, упало ${s.failed}, сломано ${s.broken}, пропущено ${s.skipped}, файлов ${s.files}`);
    });
  }
}

module.exports = TestbolReporter;
