// Автотесты: запуски («папки») с результатами, которые присылает scripts/report.js или любой другой скрипт по токену.
// projectRouter монтируется на /api/projects/:key, tokenRouter — на /api/tokens
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { sha256, newApiToken } = require("./auth");
const access = require("./access");
const events = require("./events");
const flaky = require("./flaky");
const allure = require("./allure");
const { wrap, str, num } = require("./util");

const STATUSES = ["passed", "failed", "broken", "skipped"];
const STEP_STATUSES = ["passed", "failed", "skipped"];
const MAX_BATCH = 1000;
const MAX_STEPS = 300; // на один тест, с вложенными
const MAX_DEPTH = 8;
const router = express.Router({ mergeParams: true });

const findRun = async (db, key, n) =>
  (await db.query("SELECT id, state FROM auto_runs WHERE project_key=$1 AND num=$2", [key, n])).rows[0];

function readRun(body) {
  const r = {
    title: str(body.title, 300), build: str(body.build, 200), env: str(body.env, 500), branch: str(body.branch, 200),
    scope: str(body.scope, 500), url: str(body.url, 500),
  };
  if (!r.title) return { error: "Укажите название запуска" };
  return { r };
}

// Дерево шагов из отчёта: лишнее отбрасываем, слишком глубокое и длинное обрезаем
function readSteps(list, budget = { left: MAX_STEPS }, depth = 0) {
  if (!Array.isArray(list) || depth >= MAX_DEPTH) return [];
  const out = [];
  for (const x of list) {
    if (budget.left <= 0) break;
    const title = x && typeof x === "object" ? str(x.title, 500) : "";
    if (!title) continue;
    budget.left--;
    out.push({
      title,
      status: STEP_STATUSES.includes(x.status) ? x.status : "passed",
      durationMs: Math.min(Math.max(Math.round(Number(x.durationMs) || 0), 0), 2e9),
      error: str(x.error, 2000),
      steps: readSteps(x.steps, budget, depth + 1),
    });
  }
  return out;
}

// Для реестра нужны только названия шагов
const stepTitles = (steps) => steps.map((s) => ({ title: s.title, steps: stepTitles(s.steps) }));

function readResult(x) {
  if (!x || typeof x !== "object") return null;
  const t = {
    suite: str(x.suite, 500),
    name: str(x.name, 1000),
    file: str(x.file, 500),
    status: str(x.status, 20),
    duration: Math.min(Math.max(Math.round(Number(x.durationMs) || 0), 0), 2e9),
    message: str(x.message, 5000),
    details: str(x.details, 50000),
    steps: readSteps(x.steps),
    // сколько повторных попыток понадобилось; прошёл не с первой — признак нестабильности
    retries: Math.min(Math.max(Math.round(Number(x.retries) || 0), 0), 100),
    flaky: x.flaky === true || (x.status === "passed" && Number(x.retries) > 0),
  };
  if (!t.name || !STATUSES.includes(t.status)) return null;
  // по этому ключу тест узнаётся в следующих запусках и не создаётся повторно
  t.key = t.suite ? `${t.suite} › ${t.name}` : t.name;
  return t;
}

router.post("/autoruns", wrap(async (req, res) => {
  const { r, error } = readRun(req.body);
  if (error) return res.status(400).json({ error });
  const n = await tx(async (db) => {
    const seq = await db.query("UPDATE projects SET auto_seq=auto_seq+1 WHERE key=$1 RETURNING auto_seq", [req.params.key]);
    if (!seq.rows[0]) return null;
    const next = seq.rows[0].auto_seq;
    await db.query(
      `INSERT INTO auto_runs(project_key, num, title, build, environment, branch, scope, app_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [req.params.key, next, r.title, r.build, r.env, r.branch, r.scope, r.url, req.user.id]
    );
    return next;
  });
  if (n === null) return res.status(404).json({ error: "Проект не найден" });
  broadcast("autoruns");
  events.emit(req.params.key, "autorun.created", { autorun: await events.snap.autorun(req.params.key, n) }, req.user);
  res.status(201).json({ num: n, id: `${req.params.key}-A${n}` });
}));

// Результаты можно присылать частями по ходу запуска. Повторный результат того же теста в запуске
// (например, после перезапуска упавшего) заменяет прежний. В ответе — id результатов в порядке присланных
// Сохранить пачку результатов в запуск: заводит тесты в реестре, обновляет шаги, пишет результаты.
// Возвращает id результатов в порядке list или null, если запуска нет. Используется /results и /allure
async function storeResults(key, runNum, parsed) {
  // в одном запросе тест может встретиться дважды — берём последний результат
  const byKey = new Map(parsed.map((t) => [t.key, t]));
  const uniq = [...byKey.values()];
  return tx(async (db) => {
    const run = await findRun(db, key, runNum);
    if (!run) return null;
    await db.query(
      `INSERT INTO auto_tests(project_key, test_key, suite, name, file)
       SELECT $1::text, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
       ON CONFLICT (project_key, test_key) DO NOTHING`,
      [key, uniq.map((t) => t.key), uniq.map((t) => t.suite), uniq.map((t) => t.name), uniq.map((t) => t.file)]
    );
    const tests = await db.query("SELECT id, test_key FROM auto_tests WHERE project_key=$1 AND test_key = ANY($2::text[])", [
      key,
      uniq.map((t) => t.key),
    ]);
    const testId = new Map(tests.rows.map((t) => [t.test_key, t.id]));
    // шаги в реестре: упавший тест прошёл не все шаги, поэтому он только заполняет пустой список,
    // а заменяет его прошедший
    const withSteps = uniq.filter((t) => t.steps.length);
    if (withSteps.length) {
      await db.query(
        `UPDATE auto_tests t SET steps=u.steps FROM unnest($1::int[], $2::jsonb[], $3::bool[]) AS u(id, steps, passed)
         WHERE t.id=u.id AND (u.passed OR t.steps='[]'::jsonb)`,
        [
          withSteps.map((t) => testId.get(t.key)), withSteps.map((t) => JSON.stringify(stepTitles(t.steps))),
          withSteps.map((t) => t.status === "passed"),
        ]
      );
    }
    // связь с ручным кейсом по ID из отчёта (метка или ссылка LK-12) — только если связи ещё нет
    for (const t of uniq) {
      const ref = (t.cases || []).find((c) => c.startsWith(`${key}-`));
      if (!ref) continue;
      await db.query(
        `UPDATE auto_tests SET case_id=(SELECT id FROM test_cases WHERE project_key=$1 AND num=$2) WHERE id=$3 AND case_id IS NULL`,
        [key, Number(ref.split("-")[1]), testId.get(t.key)]
      );
    }
    const rows = await db.query(
      `INSERT INTO auto_results(run_id, test_id, status, duration_ms, message, details, steps, retries, flaky)
       SELECT $1::int, * FROM unnest($2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::jsonb[], $8::int[], $9::bool[])
       ON CONFLICT (run_id, test_id) DO UPDATE SET status=EXCLUDED.status, duration_ms=EXCLUDED.duration_ms,
         message=EXCLUDED.message, details=EXCLUDED.details, steps=EXCLUDED.steps, created_at=now(),
         -- повторная отправка того же теста (перезапуск упавшего) — тоже повторная попытка
         retries=GREATEST(EXCLUDED.retries, auto_results.retries + 1),
         flaky=EXCLUDED.flaky OR (EXCLUDED.status='passed' AND auto_results.status IN ('failed','broken'))
       RETURNING id, test_id`,
      [
        run.id, uniq.map((t) => testId.get(t.key)), uniq.map((t) => t.status), uniq.map((t) => t.duration),
        uniq.map((t) => t.message), uniq.map((t) => t.details), uniq.map((t) => JSON.stringify(t.steps)),
        uniq.map((t) => t.retries), uniq.map((t) => t.flaky),
      ]
    );
    const resultId = new Map(rows.rows.map((r) => [r.test_id, r.id]));
    return parsed.map((t) => resultId.get(testId.get(t.key)));
  });
}

router.post("/autoruns/:num/results", wrap(async (req, res) => {
  const list = Array.isArray(req.body.results) ? req.body.results : [];
  if (!list.length) return res.status(400).json({ error: "Передайте непустой список results" });
  if (list.length > MAX_BATCH) return res.status(413).json({ error: `Не больше ${MAX_BATCH} результатов за один запрос` });
  const parsed = list.map(readResult);
  const bad = parsed.findIndex((t) => !t);
  if (bad >= 0) return res.status(400).json({ error: `results[${bad}]: нужны name и status (${STATUSES.join(", ")})` });
  const out = await storeResults(req.params.key, num(req.params.num), parsed);
  if (!out) return res.status(404).json({ error: "Запуск не найден" });
  broadcast("autoruns");
  res.json({ ids: out });
}));

// Результаты в формате Allure: {"results": [содержимое *-result.json, …]}. Повторы одного теста (retries) сводятся
// в один результат. Ответ: {ids, attachments: [{id: результат, source, name, type}]} — какие файлы из allure-results
// приложить запросом POST …/results/:rid/attachments
router.post("/autoruns/:num/allure", wrap(async (req, res) => {
  const list = Array.isArray(req.body.results) ? req.body.results : [];
  if (!list.length) return res.status(400).json({ error: "Передайте непустой список results (содержимое *-result.json)" });
  if (list.length > MAX_BATCH) return res.status(413).json({ error: `Не больше ${MAX_BATCH} результатов за один запрос` });
  const converted = allure.convert(list);
  if (!converted.length) return res.status(400).json({ error: "Ни одного результата Allure: нужны name и status" });
  const parsed = converted.map((x) => ({ ...readResult(x), cases: x.cases }));
  const ids = await storeResults(req.params.key, num(req.params.num), parsed);
  if (!ids) return res.status(404).json({ error: "Запуск не найден" });
  broadcast("autoruns");
  res.json({
    ids,
    tests: converted.length,
    attachments: converted.flatMap((x, i) => x.attachments.map((a) => ({ id: ids[i], status: x.status, ...a }))),
  });
}));

router.patch("/autoruns/:num", wrap(async (req, res) => {
  const n = num(req.params.num);
  const { rows } = await pool.query(
    "SELECT title, build, environment AS env, branch, scope, app_url AS url, state FROM auto_runs WHERE project_key=$1 AND num=$2",
    [req.params.key, n]
  );
  if (!rows[0]) return res.status(404).json({ error: "Запуск не найден" });
  const { r, error } = readRun({ ...rows[0], ...req.body });
  if (error) return res.status(400).json({ error });
  const state = req.body.state === undefined ? rows[0].state : req.body.state;
  if (!["queued", "running", "finished", "failed"].includes(state)) return res.status(400).json({ error: "Неизвестное состояние запуска" });
  await pool.query(
    `UPDATE auto_runs SET title=$1, build=$2, environment=$3, branch=$4, scope=$5, app_url=$6, state=$7,
       finished_at = CASE WHEN $7 IN ('finished','failed') THEN COALESCE(finished_at, now()) ELSE NULL END
     WHERE project_key=$8 AND num=$9`,
    [r.title, r.build, r.env, r.branch, r.scope, r.url, state, req.params.key, n]
  );
  broadcast("autoruns");
  if (state === "finished" && rows[0].state !== "finished") {
    // нестабильность пересчитывается по завершённым запускам — для тестов этого запуска
    const key = req.params.key;
    setImmediate(async () => {
      try {
        const { rows: ids } = await pool.query(
          "SELECT ar.test_id FROM auto_results ar JOIN auto_runs r ON r.id=ar.run_id WHERE r.project_key=$1 AND r.num=$2", [key, n]
        );
        await flaky.recompute(key, ids.map((x) => x.test_id));
        broadcast("autoruns");
      } catch (e) {
        console.error("[flaky]", e.message);
      }
      events.emit(key, "autorun.finished", { autorun: await events.snap.autorun(key, n) }, req.user);
    });
  }
  res.json({ ok: true });
}));

router.delete("/autoruns/:num", wrap(async (req, res) => {
  const r = await pool.query("DELETE FROM auto_runs WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  if (!r.rowCount) return res.status(404).json({ error: "Запуск не найден" });
  broadcast("autoruns");
  res.json({ ok: true });
}));

// Содержимое «папки»: результаты, вложения и что было с каждым тестом в предыдущем запуске.
// Результатов бывает тысячи, поэтому они не входят в /api/state и загружаются отдельно
router.get("/autoruns/:num", wrap(async (req, res) => {
  const run = await findRun(pool, req.params.key, num(req.params.num));
  if (!run) return res.status(404).json({ error: "Запуск не найден" });
  const [results, files] = await Promise.all([
    pool.query(
      `SELECT ar.id, ar.test_id, t.suite, t.name, t.file, ar.status, ar.duration_ms, ar.message, ar.details, ar.steps,
         ar.retries, ar.flaky, t.quarantined, t.flaky_since IS NOT NULL AS unstable,
         prev.status AS prev_status, prev.num AS prev_num
       FROM auto_results ar JOIN auto_tests t ON t.id=ar.test_id
       LEFT JOIN LATERAL (
         SELECT p.status, r.num FROM auto_results p JOIN auto_runs r ON r.id=p.run_id
         WHERE p.test_id=ar.test_id AND r.num < $2 AND r.project_key=$3 ORDER BY r.num DESC LIMIT 1
       ) prev ON true
       WHERE ar.run_id=$1 ORDER BY t.suite, t.name`,
      [run.id, num(req.params.num), req.params.key]
    ),
    pool.query(
      `SELECT a.id, a.auto_result_id, a.filename, a.mime, a.size, u.login AS uploaded_by, a.created_at
       FROM attachments a JOIN auto_results ar ON ar.id=a.auto_result_id LEFT JOIN users u ON u.id=a.uploaded_by
       WHERE ar.run_id=$1 ORDER BY a.created_at`,
      [run.id]
    ),
  ]);
  res.json({
    results: results.rows.map((r) => ({
      id: r.id, testId: r.test_id, suite: r.suite, name: r.name, file: r.file, status: r.status, durationMs: r.duration_ms,
      message: r.message, details: r.details, steps: r.steps, prev: r.prev_status ? { status: r.prev_status, runNum: r.prev_num } : null,
      retries: r.retries, flaky: r.flaky, quarantined: r.quarantined, unstable: r.unstable,
    })),
    attachments: files.rows.map((a) => ({
      id: a.id, pid: req.params.key, bugNum: null, resultId: null, autoResultId: a.auto_result_id, name: a.filename, mime: a.mime,
      size: a.size, uploadedBy: a.uploaded_by, created: a.created_at.getTime(),
    })),
  });
}));

// Реестр автотестов проекта с историей последних 10 запусков (сначала самый свежий)
router.get("/autotests", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.suite, t.name, t.file, t.steps, t.created_at, t.flaky_score, t.flaky_since, t.flaky_reason, t.quarantined, c.num AS case_num,
       ARRAY(SELECT ar.status || ':' || r.num || ':' || ar.flaky::int FROM auto_results ar JOIN auto_runs r ON r.id=ar.run_id
             WHERE ar.test_id=t.id ORDER BY r.num DESC LIMIT 10) AS history
     FROM auto_tests t LEFT JOIN test_cases c ON c.id=t.case_id WHERE t.project_key=$1 ORDER BY t.suite, t.name`,
    [req.params.key]
  );
  res.json({
    tests: rows.map((t) => ({
      id: t.id, suite: t.suite, name: t.name, file: t.file, steps: t.steps, created: t.created_at.getTime(),
      flaky: t.flaky_since ? { score: t.flaky_score, reason: t.flaky_reason, since: t.flaky_since.getTime() } : null,
      flakyScore: t.flaky_score, quarantined: t.quarantined, caseNum: t.case_num,
      history: t.history.map((h) => {
        const [status, runNum, retried] = h.split(":");
        return { status, runNum: Number(runNum), flaky: retried === "1" };
      }),
    })),
  });
}));

// Карантин и связь с ручным кейсом: {"quarantined": true} / {"caseNum": 12 | null}
router.patch("/autotests/:id", wrap(async (req, res) => {
  const id = num(req.params.id);
  const { rows } = await pool.query("SELECT id, quarantined, case_id FROM auto_tests WHERE project_key=$1 AND id=$2", [req.params.key, id]);
  if (!rows[0]) return res.status(404).json({ error: "Автотест не найден" });
  const q = req.body.quarantined === undefined ? rows[0].quarantined : req.body.quarantined === true;
  let caseId = rows[0].case_id;
  if (req.body.caseNum !== undefined) {
    if (req.body.caseNum === null) caseId = null;
    else {
      const c = await pool.query("SELECT id FROM test_cases WHERE project_key=$1 AND num=$2", [req.params.key, num(req.body.caseNum)]);
      if (!c.rows[0]) return res.status(400).json({ error: "Тест-кейс не найден" });
      caseId = c.rows[0].id;
    }
  }
  await pool.query("UPDATE auto_tests SET quarantined=$1, case_id=$2 WHERE id=$3", [q, caseId, id]);
  broadcast("autoruns");
  res.json({ ok: true });
}));

// Пересчитать нестабильность всех автотестов проекта (например, после смены порогов FLAKY_*)
router.post("/autotests/flaky/recompute", wrap(async (req, res) => {
  const fresh = await flaky.recompute(req.params.key);
  broadcast("autoruns");
  res.json({ newlyFlaky: fresh.length });
}));

router.delete("/autotests/:id", wrap(async (req, res) => {
  const r = await pool.query("DELETE FROM auto_tests WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Автотест не найден" });
  broadcast("autoruns");
  res.json({ ok: true });
}));

// ---------- токены для скриптов ----------
const tokenRouter = express.Router();

tokenRouter.get("/", wrap(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, project_key, created_at, last_used_at FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json({
    tokens: rows.map((t) => ({ id: t.id, name: t.name, project: t.project_key, created: t.created_at.getTime(), used: t.last_used_at ? t.last_used_at.getTime() : null })),
  });
}));

// токен нужен только чтобы отправлять результаты — для этого нужна роль с правом записи.
// {"project": "LK"} — токен только для этого проекта (рекомендуется для CI: утёкший токен не откроет другие проекты)
tokenRouter.post("/", wrap(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) return res.status(400).json({ error: "Укажите название токена, например «Ноутбук» или «CI»" });
  const project = req.body.project ? str(req.body.project, 10).toUpperCase() : null;
  if (project) {
    if (!access.canWrite(await access.projectRole(req.user, project))) return res.status(403).json({ error: "В этом проекте у вас нет права отправлять результаты" });
  } else if (!(await access.writesSomewhere(req.user))) return res.status(403).json({ error: access.READ_ONLY });
  const token = newApiToken();
  await pool.query("INSERT INTO api_tokens(user_id, name, token_hash, project_key) VALUES ($1,$2,$3,$4)", [req.user.id, name, sha256(token), project]);
  res.status(201).json({ token });
}));

tokenRouter.delete("/:id", wrap(async (req, res) => {
  const r = await pool.query("DELETE FROM api_tokens WHERE id=$1 AND user_id=$2", [num(req.params.id), req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Токен не найден" });
  res.json({ ok: true });
}));

module.exports = { projectRouter: router, tokenRouter };
