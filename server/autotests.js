// Автотесты: запуски («папки») с результатами, которые присылает scripts/report.js или любой другой скрипт по токену.
// projectRouter монтируется на /api/projects/:key, tokenRouter — на /api/tokens
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { sha256, newApiToken } = require("./auth");
const { wrap, str, num } = require("./util");

const STATUSES = ["passed", "failed", "broken", "skipped"];
const MAX_BATCH = 1000;
const router = express.Router({ mergeParams: true });

const findRun = async (db, key, n) =>
  (await db.query("SELECT id, state FROM auto_runs WHERE project_key=$1 AND num=$2", [key, n])).rows[0];

function readRun(body) {
  const r = { title: str(body.title, 300), build: str(body.build, 200), env: str(body.env, 500), branch: str(body.branch, 200) };
  if (!r.title) return { error: "Укажите название запуска" };
  return { r };
}

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
      "INSERT INTO auto_runs(project_key, num, title, build, environment, branch, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [req.params.key, next, r.title, r.build, r.env, r.branch, req.user.id]
    );
    return next;
  });
  if (n === null) return res.status(404).json({ error: "Проект не найден" });
  broadcast("autoruns");
  res.status(201).json({ num: n, id: `${req.params.key}-A${n}` });
}));

// Результаты можно присылать частями по ходу запуска. Повторный результат того же теста в запуске
// (например, после перезапуска упавшего) заменяет прежний. В ответе — id результатов в порядке присланных
router.post("/autoruns/:num/results", wrap(async (req, res) => {
  const list = Array.isArray(req.body.results) ? req.body.results : [];
  if (!list.length) return res.status(400).json({ error: "Передайте непустой список results" });
  if (list.length > MAX_BATCH) return res.status(413).json({ error: `Не больше ${MAX_BATCH} результатов за один запрос` });
  const parsed = list.map(readResult);
  const bad = parsed.findIndex((t) => !t);
  if (bad >= 0) return res.status(400).json({ error: `results[${bad}]: нужны name и status (${STATUSES.join(", ")})` });
  // в одном запросе тест может встретиться дважды — берём последний результат
  const byKey = new Map(parsed.map((t) => [t.key, t]));
  const uniq = [...byKey.values()];

  const out = await tx(async (db) => {
    const run = await findRun(db, req.params.key, num(req.params.num));
    if (!run) return null;
    await db.query(
      `INSERT INTO auto_tests(project_key, test_key, suite, name, file)
       SELECT $1::text, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
       ON CONFLICT (project_key, test_key) DO NOTHING`,
      [req.params.key, uniq.map((t) => t.key), uniq.map((t) => t.suite), uniq.map((t) => t.name), uniq.map((t) => t.file)]
    );
    const tests = await db.query("SELECT id, test_key FROM auto_tests WHERE project_key=$1 AND test_key = ANY($2::text[])", [
      req.params.key,
      uniq.map((t) => t.key),
    ]);
    const testId = new Map(tests.rows.map((t) => [t.test_key, t.id]));
    const rows = await db.query(
      `INSERT INTO auto_results(run_id, test_id, status, duration_ms, message, details)
       SELECT $1::int, * FROM unnest($2::int[], $3::text[], $4::int[], $5::text[], $6::text[])
       ON CONFLICT (run_id, test_id) DO UPDATE SET status=EXCLUDED.status, duration_ms=EXCLUDED.duration_ms,
         message=EXCLUDED.message, details=EXCLUDED.details, created_at=now()
       RETURNING id, test_id`,
      [run.id, uniq.map((t) => testId.get(t.key)), uniq.map((t) => t.status), uniq.map((t) => t.duration), uniq.map((t) => t.message), uniq.map((t) => t.details)]
    );
    const resultId = new Map(rows.rows.map((r) => [r.test_id, r.id]));
    return parsed.map((t) => resultId.get(testId.get(t.key)));
  });
  if (!out) return res.status(404).json({ error: "Запуск не найден" });
  broadcast("autoruns");
  res.json({ ids: out });
}));

router.patch("/autoruns/:num", wrap(async (req, res) => {
  const n = num(req.params.num);
  const { rows } = await pool.query(
    "SELECT title, build, environment AS env, branch, state FROM auto_runs WHERE project_key=$1 AND num=$2",
    [req.params.key, n]
  );
  if (!rows[0]) return res.status(404).json({ error: "Запуск не найден" });
  const { r, error } = readRun({ ...rows[0], ...req.body });
  if (error) return res.status(400).json({ error });
  const state = req.body.state === undefined ? rows[0].state : req.body.state;
  if (!["running", "finished"].includes(state)) return res.status(400).json({ error: "Неизвестное состояние запуска" });
  await pool.query(
    `UPDATE auto_runs SET title=$1, build=$2, environment=$3, branch=$4, state=$5,
       finished_at = CASE WHEN $5='finished' THEN COALESCE(finished_at, now()) ELSE NULL END
     WHERE project_key=$6 AND num=$7`,
    [r.title, r.build, r.env, r.branch, state, req.params.key, n]
  );
  broadcast("autoruns");
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
      `SELECT ar.id, ar.test_id, t.suite, t.name, t.file, ar.status, ar.duration_ms, ar.message, ar.details,
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
      message: r.message, details: r.details, prev: r.prev_status ? { status: r.prev_status, runNum: r.prev_num } : null,
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
    `SELECT t.id, t.suite, t.name, t.file, t.created_at,
       ARRAY(SELECT ar.status || ':' || r.num FROM auto_results ar JOIN auto_runs r ON r.id=ar.run_id
             WHERE ar.test_id=t.id ORDER BY r.num DESC LIMIT 10) AS history
     FROM auto_tests t WHERE t.project_key=$1 ORDER BY t.suite, t.name`,
    [req.params.key]
  );
  res.json({
    tests: rows.map((t) => ({
      id: t.id, suite: t.suite, name: t.name, file: t.file, created: t.created_at.getTime(),
      history: t.history.map((h) => {
        const [status, runNum] = h.split(":");
        return { status, runNum: Number(runNum) };
      }),
    })),
  });
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
    "SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json({ tokens: rows.map((t) => ({ id: t.id, name: t.name, created: t.created_at.getTime(), used: t.last_used_at ? t.last_used_at.getTime() : null })) });
}));

tokenRouter.post("/", wrap(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) return res.status(400).json({ error: "Укажите название токена, например «Ноутбук» или «CI»" });
  const token = newApiToken();
  await pool.query("INSERT INTO api_tokens(user_id, name, token_hash) VALUES ($1,$2,$3)", [req.user.id, name, sha256(token)]);
  res.status(201).json({ token });
}));

tokenRouter.delete("/:id", wrap(async (req, res) => {
  const r = await pool.query("DELETE FROM api_tokens WHERE id=$1 AND user_id=$2", [num(req.params.id), req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Токен не найден" });
  res.json({ ok: true });
}));

module.exports = { projectRouter: router, tokenRouter };
