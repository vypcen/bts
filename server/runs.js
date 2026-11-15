// Тест-прогоны и результаты кейсов в них. Монтируется на /api/projects/:key
const express = require("express");
const casemodel = require("./casemodel");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const checklist = require("./checklist");
const events = require("./events");
const { distribute, executors } = require("./distribute");
const { wrap, str, tooLong, num } = require("./util");

const RESULTS = ["untested", "passed", "failed", "blocked", "skipped"];
const router = express.Router({ mergeParams: true });

// locked — прогон создан из заблокированного тест-плана: его состав зафиксирован, удалить его нельзя
const findRun = async (db, key, n) =>
  (await db.query(
    `SELECT r.id, r.state, COALESCE(p.locked, false) AS locked FROM test_runs r LEFT JOIN test_plans p ON p.id=r.plan_id
     WHERE r.project_key=$1 AND r.num=$2`,
    [key, n]
  )).rows[0];

// caseNums → id кейсов этого проекта (чужие и несуществующие номера отбрасываются)
async function caseIds(db, key, nums) {
  const list = Array.isArray(nums) ? nums.map(num).filter(Boolean) : [];
  if (!list.length) return [];
  const { rows } = await db.query("SELECT id FROM test_cases WHERE project_key=$1 AND num = ANY($2::int[])", [key, list]);
  return rows.map((r) => r.id);
}

// Режим «готов только после ревью»: в прогон идут только утверждённые (готовые) кейсы
async function unapproved(db, key, ids) {
  const { rows } = await db.query(
    `SELECT c.num FROM test_cases c JOIN projects p ON p.key=c.project_key
     WHERE p.review_required AND c.project_key=$1 AND c.id = ANY($2::int[]) AND c.status <> 'ready' ORDER BY c.num`, [key, ids]);
  return rows.length ? `В этом проекте в прогон попадают только утверждённые кейсы. Не готовы: ${rows.slice(0, 10).map((r) => `${key}-${r.num}`).join(", ")}${rows.length > 10 ? "…" : ""}` : null;
}

function readRun(body) {
  const r = { title: str(body.title, 300), build: str(body.build, 200), env: str(body.env, 500) };
  if (!r.title) return { error: "Укажите название прогона" };
  if (tooLong(body.title, 300)) return { error: tooLong(body.title, 300) };
  return { r };
}

router.post("/runs", wrap(async (req, res) => {
  const { r, error } = readRun(req.body);
  if (error) return res.status(400).json({ error });
  const cf = await casemodel.readFields(pool, req.params.key, "run", req.body.fields, {});
  if (cf.error) return res.status(400).json({ error: cf.error });
  const out = await tx(async (db) => {
    const seq = await db.query("UPDATE projects SET run_seq=run_seq+1 WHERE key=$1 RETURNING run_seq", [req.params.key]);
    if (!seq.rows[0]) return { status: 404, error: "Проект не найден" };
    const ids = await caseIds(db, req.params.key, req.body.caseNums);
    if (!ids.length) return { status: 400, error: "Выберите хотя бы один тест-кейс" };
    const notReady = await unapproved(db, req.params.key, ids);
    if (notReady) return { status: 409, error: notReady };
    const n = seq.rows[0].run_seq;
    const run = await db.query(
      "INSERT INTO test_runs(project_key, num, title, build, environment, created_by, fields) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [req.params.key, n, r.title, r.build, r.env, req.user.id, cf.fields]
    );
    await db.query("INSERT INTO run_results(run_id, case_id) SELECT $1, unnest($2::int[])", [run.rows[0].id, ids]);
    // {"assign": {"users": [...], "strategy": "balanced"}} — сразу распределить кейсы
    const dist = req.body.assign?.users?.length ? await distribute(db, req.params.key, run.rows[0].id, req.body.assign.users, req.body.assign.strategy) : null;
    return { n, dist };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  broadcast("runs");
  events.emit(req.params.key, "run.created", { run: await events.snap.run(req.params.key, out.n) }, req.user);
  res.status(201).json({ num: out.n, distribution: out.dist });
}));

// Перезапуск: новый прогон из кейсов с выбранными результатами (по умолчанию «упал» и «заблокирован»).
// Сборка и окружение — новые или прежние; исполнители и пользовательские поля переносятся
const RERUN_RESULTS = ["failed", "blocked", "skipped", "untested", "passed"];
router.post("/runs/:num/rerun", wrap(async (req, res) => {
  const key = req.params.key;
  const results = Array.isArray(req.body.results) && req.body.results.length ? req.body.results.filter((r) => RERUN_RESULTS.includes(r)) : ["failed", "blocked"];
  if (!results.length) return res.status(400).json({ error: `results: ${RERUN_RESULTS.join(", ")}` });
  const out = await tx(async (db) => {
    const { rows } = await db.query("SELECT id, title, build, environment, fields, plan_id FROM test_runs WHERE project_key=$1 AND num=$2", [key, num(req.params.num)]);
    const old = rows[0];
    if (!old) return { status: 404, error: "Прогон не найден" };
    const picked = await db.query(
      `SELECT rr.case_id, rr.assignee_id FROM run_results rr JOIN test_cases c ON c.id=rr.case_id
       WHERE rr.run_id=$1 AND rr.result = ANY($2::text[]) AND c.status <> 'deprecated' ORDER BY c.num`,
      [old.id, results]
    );
    if (!picked.rows.length) return { status: 409, error: "В прогоне нет кейсов с такими результатами — перезапускать нечего" };
    const seq = await db.query("UPDATE projects SET run_seq=run_seq+1 WHERE key=$1 RETURNING run_seq", [key]);
    const n = seq.rows[0].run_seq;
    const title = str(req.body.title, 300) || `${old.title.replace(/ — перезапуск( \d+)?$/, "")} — перезапуск`;
    const run = await db.query(
      `INSERT INTO test_runs(project_key, num, title, build, environment, created_by, fields, plan_id, rerun_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [key, n, title, req.body.build !== undefined ? str(req.body.build, 200) : old.build, req.body.env !== undefined ? str(req.body.env, 500) : old.environment,
        req.user.id, old.fields, old.plan_id, old.id]
    );
    await db.query(
      "INSERT INTO run_results(run_id, case_id, assignee_id) SELECT $1, * FROM unnest($2::int[], $3::int[])",
      [run.rows[0].id, picked.rows.map((r) => r.case_id), picked.rows.map((r) => r.assignee_id)]
    );
    return { n, count: picked.rows.length };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  broadcast("runs");
  events.emit(key, "run.created", { run: await events.snap.run(key, out.n) }, req.user);
  res.status(201).json({ num: out.n, cases: out.count });
}));

router.patch("/runs/:num", wrap(async (req, res) => {
  const n = num(req.params.num);
  const { rows } = await pool.query("SELECT title, build, environment AS env, state, fields FROM test_runs WHERE project_key=$1 AND num=$2", [req.params.key, n]);
  if (!rows[0]) return res.status(404).json({ error: "Прогон не найден" });
  const { r, error } = readRun({ ...rows[0], ...req.body });
  if (error) return res.status(400).json({ error });
  const cf = await casemodel.readFields(pool, req.params.key, "run", req.body.fields, rows[0].fields);
  if (cf.error) return res.status(400).json({ error: cf.error });
  const state = req.body.state === undefined ? rows[0].state : req.body.state;
  if (!["open", "closed"].includes(state)) return res.status(400).json({ error: "Неизвестное состояние прогона" });
  await pool.query(
    `UPDATE test_runs SET title=$1, build=$2, environment=$3, state=$4, fields=$7,
       closed_at = CASE WHEN $4='closed' THEN COALESCE(closed_at, now()) ELSE NULL END
     WHERE project_key=$5 AND num=$6`,
    [r.title, r.build, r.env, state, req.params.key, n, cf.fields]
  );
  broadcast("runs");
  if (state === "closed" && rows[0].state !== "closed") events.emit(req.params.key, "run.closed", { run: await events.snap.run(req.params.key, n) }, req.user);
  res.json({ ok: true });
}));

router.delete("/runs/:num", wrap(async (req, res) => {
  const run = await findRun(pool, req.params.key, num(req.params.num));
  if (run?.locked) return res.status(409).json({ error: "Прогон создан из заблокированного тест-плана — удалить его нельзя" });
  // в корзину: прогон с результатами и вложениями можно восстановить (server/trash.js)
  const r = await require("./trash").remove(req, "run", num(req.params.num));
  if (!r) return res.status(404).json({ error: "Прогон не найден" });
  broadcast("runs");
  res.json({ ok: true, trashId: r.trashId });
}));

// Добавить кейсы в открытый прогон (уже включённые пропускаются)
router.post("/runs/:num/cases", wrap(async (req, res) => {
  const run = await findRun(pool, req.params.key, num(req.params.num));
  if (!run) return res.status(404).json({ error: "Прогон не найден" });
  if (run.state !== "open") return res.status(409).json({ error: "Прогон закрыт. Откройте его, чтобы добавить кейсы" });
  if (run.locked) return res.status(409).json({ error: "Состав прогона из заблокированного тест-плана изменить нельзя" });
  const ids = await caseIds(pool, req.params.key, req.body.caseNums);
  if (!ids.length) return res.status(400).json({ error: "Выберите хотя бы один тест-кейс" });
  const notReady = await unapproved(pool, req.params.key, ids);
  if (notReady) return res.status(409).json({ error: notReady });
  const r = await pool.query(
    "INSERT INTO run_results(run_id, case_id) SELECT $1, unnest($2::int[]) ON CONFLICT (run_id, case_id) DO NOTHING",
    [run.id, ids]
  );
  broadcast("runs");
  res.json({ added: r.rowCount });
}));

router.patch("/runs/:num/results/:case", wrap(async (req, res) => {
  const run = await findRun(pool, req.params.key, num(req.params.num));
  if (!run) return res.status(404).json({ error: "Прогон не найден" });
  if (run.state !== "open") return res.status(409).json({ error: "Прогон закрыт. Откройте его, чтобы менять результаты" });
  const { rows } = await pool.query(
    `SELECT rr.id, rr.result, rr.comment, rr.items, rr.step_results, rr.assignee_id, rr.iterations, rr.iter_results, c.kind, c.steps,
       expand_steps(COALESCE(v.step_list, c.step_list)) AS step_list
     FROM run_results rr JOIN test_cases c ON c.id=rr.case_id
     LEFT JOIN test_case_versions v ON v.case_id=c.id AND v.version=rr.case_version
     WHERE rr.run_id=$1 AND c.num=$2`,
    [run.id, num(req.params.case)]
  );
  const cur = rows[0];
  if (!cur) return res.status(404).json({ error: "Кейс не входит в этот прогон" });
  // исполнитель: {"assignee": "login"} или {"assignee": null} — снять
  let assignee = cur.assignee_id;
  if (req.body.assignee !== undefined) assignee = req.body.assignee ? (await executors(pool, req.params.key, [req.body.assignee]))[0].id : null;
  let result = req.body.result === undefined ? cur.result : str(req.body.result, 20);
  const comment = req.body.comment === undefined ? cur.comment : str(req.body.comment);
  if (!RESULTS.includes(result)) return res.status(400).json({ error: "Неизвестный результат" });
  let items = cur.items;
  if (req.body.item !== undefined) {
    // отметка пункта чек-листа: {"item": "текст пункта", "result": "failed"}; "untested" снимает отметку
    if (cur.kind !== "checklist") return res.status(400).json({ error: "Пункты есть только у чек-листа" });
    const list = checklist.items(cur.steps);
    const item = str(req.body.item, checklist.MAX_ITEM);
    if (!list.includes(item)) return res.status(404).json({ error: "Такого пункта в чек-листе нет: возможно, его только что изменили" });
    items = { ...cur.items };
    if (result === "untested") delete items[item];
    else items[item] = result;
    result = checklist.verdict(list, items);
  } else if (cur.kind === "checklist" && req.body.result !== undefined) {
    return res.status(400).json({ error: "У чек-листа отмечаются пункты, итог считается сам" });
  }
  // кейс с параметрами: результат и шаги отмечаются по итерации {"iteration": 1, ...}, итог кейса считается по итерациям
  const iters = Array.isArray(cur.iterations) ? cur.iterations : null;
  let iterResults = cur.iter_results || {};
  let it = null;
  if (req.body.iteration !== undefined) {
    if (!iters) return res.status(400).json({ error: "У кейса в этом прогоне нет наборов данных" });
    it = Number(req.body.iteration);
    if (!Number.isInteger(it) || it < 0 || it >= iters.length) return res.status(404).json({ error: "Такого набора данных нет" });
  } else if (iters && (req.body.result !== undefined || req.body.step !== undefined)) {
    return res.status(400).json({ error: "Кейс проверяется по наборам данных: укажите iteration (с 0)" });
  }
  if (it !== null) {
    const cell = iterResults[it] || { result: "untested", steps: {} };
    let r = req.body.result === undefined ? cell.result : result;
    let steps = cell.steps || {};
    if (req.body.step !== undefined) {
      if (cur.kind !== "case") return res.status(400).json({ error: "Шаги есть только у тест-кейса" });
      const i = Number(req.body.step);
      if (!Number.isInteger(i) || i < 0 || i >= cur.step_list.length) return res.status(404).json({ error: "Такого шага нет: возможно, кейс изменили" });
      steps = { ...steps };
      const prev = steps[i] || {};
      const actual = req.body.actual === undefined ? prev.actual || "" : str(req.body.actual, 5000);
      if (r === "untested" && !actual) delete steps[i];
      else steps[i] = { result: r, actual };
      const marks = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.result]).filter(([, x]) => x !== "untested"));
      r = checklist.verdict(cur.step_list.map((_, k) => String(k)), marks);
    }
    iterResults = { ...iterResults };
    if (r === "untested" && !Object.keys(steps).length) delete iterResults[it];
    else iterResults[it] = { result: r, steps };
    const marks = Object.fromEntries(Object.entries(iterResults).map(([k, v]) => [k, v.result]).filter(([, x]) => x !== "untested"));
    result = checklist.verdict(iters.map((_, k) => String(k)), marks);
  }
  // результат шага тест-кейса: {"step": 2, "result": "failed", "actual": "что произошло"} (шаги с 0, по проверяемой версии).
  // Итог кейса считается по шагам, как у чек-листа; отметить итог целиком без шагов тоже можно
  let stepResults = cur.step_results;
  if (req.body.step !== undefined && it === null) {
    if (cur.kind !== "case") return res.status(400).json({ error: "Шаги есть только у тест-кейса" });
    const i = Number(req.body.step);
    if (!Number.isInteger(i) || i < 0 || i >= cur.step_list.length) return res.status(404).json({ error: "Такого шага нет: возможно, кейс изменили" });
    stepResults = { ...cur.step_results };
    const prev = stepResults[i] || {};
    const actual = req.body.actual === undefined ? prev.actual || "" : str(req.body.actual, 5000);
    if (result === "untested" && !actual) delete stepResults[i];
    else stepResults[i] = { result, actual };
    const marks = Object.fromEntries(Object.entries(stepResults).map(([k, v]) => [k, v.result]).filter(([, r]) => r !== "untested"));
    result = checklist.verdict(cur.step_list.map((_, k) => String(k)), marks);
  }
  const changed = result !== cur.result;
  // исполнитель и время фиксируются, когда меняется сам результат, а не комментарий
  await pool.query(
    `UPDATE run_results SET result=$1, comment=$2, items=$6, assignee_id=$7, step_results=$8, iter_results=$9,
       executed_by = CASE WHEN $3 THEN (CASE WHEN $1='untested' THEN NULL ELSE $4::int END) ELSE executed_by END,
       executed_at = CASE WHEN $3 THEN (CASE WHEN $1='untested' THEN NULL ELSE now() END) ELSE executed_at END
     WHERE id=$5`,
    [result, comment, changed, req.user.id, cur.id, JSON.stringify(items), assignee, JSON.stringify(stepResults), JSON.stringify(iterResults)]
  );
  broadcast("runs");
  if (changed) {
    events.emit(req.params.key, "run.result", {
      run: { id: `${req.params.key}-R${req.params.num}`, num: num(req.params.num) },
      result: { case: `${req.params.key}-${num(req.params.case)}`, caseNum: num(req.params.case), result, previous: cur.result, comment },
      case: await events.snap.testCase(req.params.key, num(req.params.case)),
    }, req.user);
  }
  res.json({ ok: true });
}));

// Распределить непроверенные кейсы: {"users": ["anna", "oleg"], "strategy": "balanced" | "round_robin" | "by_folder", "onlyUnassigned": true}
router.post("/runs/:num/distribute", wrap(async (req, res) => {
  const run = await findRun(pool, req.params.key, num(req.params.num));
  if (!run) return res.status(404).json({ error: "Прогон не найден" });
  if (run.state !== "open") return res.status(409).json({ error: "Прогон закрыт" });
  const out = await tx((db) => distribute(db, req.params.key, run.id, req.body.users, req.body.strategy || "balanced", req.body.onlyUnassigned !== false));
  broadcast("runs");
  res.json(out);
}));

module.exports = router;
