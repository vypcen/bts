// Тест-прогоны и результаты кейсов в них. Монтируется на /api/projects/:key
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const checklist = require("./checklist");
const events = require("./events");
const { distribute, executors } = require("./distribute");
const { wrap, str, num } = require("./util");

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

function readRun(body) {
  const r = { title: str(body.title, 300), build: str(body.build, 200), env: str(body.env, 500) };
  if (!r.title) return { error: "Укажите название прогона" };
  return { r };
}

router.post("/runs", wrap(async (req, res) => {
  const { r, error } = readRun(req.body);
  if (error) return res.status(400).json({ error });
  const out = await tx(async (db) => {
    const seq = await db.query("UPDATE projects SET run_seq=run_seq+1 WHERE key=$1 RETURNING run_seq", [req.params.key]);
    if (!seq.rows[0]) return { status: 404, error: "Проект не найден" };
    const ids = await caseIds(db, req.params.key, req.body.caseNums);
    if (!ids.length) return { status: 400, error: "Выберите хотя бы один тест-кейс" };
    const n = seq.rows[0].run_seq;
    const run = await db.query(
      "INSERT INTO test_runs(project_key, num, title, build, environment, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [req.params.key, n, r.title, r.build, r.env, req.user.id]
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

router.patch("/runs/:num", wrap(async (req, res) => {
  const n = num(req.params.num);
  const { rows } = await pool.query("SELECT title, build, environment AS env, state FROM test_runs WHERE project_key=$1 AND num=$2", [req.params.key, n]);
  if (!rows[0]) return res.status(404).json({ error: "Прогон не найден" });
  const { r, error } = readRun({ ...rows[0], ...req.body });
  if (error) return res.status(400).json({ error });
  const state = req.body.state === undefined ? rows[0].state : req.body.state;
  if (!["open", "closed"].includes(state)) return res.status(400).json({ error: "Неизвестное состояние прогона" });
  await pool.query(
    `UPDATE test_runs SET title=$1, build=$2, environment=$3, state=$4,
       closed_at = CASE WHEN $4='closed' THEN COALESCE(closed_at, now()) ELSE NULL END
     WHERE project_key=$5 AND num=$6`,
    [r.title, r.build, r.env, state, req.params.key, n]
  );
  broadcast("runs");
  if (state === "closed" && rows[0].state !== "closed") events.emit(req.params.key, "run.closed", { run: await events.snap.run(req.params.key, n) }, req.user);
  res.json({ ok: true });
}));

router.delete("/runs/:num", wrap(async (req, res) => {
  const run = await findRun(pool, req.params.key, num(req.params.num));
  if (run?.locked) return res.status(409).json({ error: "Прогон создан из заблокированного тест-плана — удалить его нельзя" });
  const r = await pool.query("DELETE FROM test_runs WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  if (!r.rowCount) return res.status(404).json({ error: "Прогон не найден" });
  broadcast("runs");
  res.json({ ok: true });
}));

// Добавить кейсы в открытый прогон (уже включённые пропускаются)
router.post("/runs/:num/cases", wrap(async (req, res) => {
  const run = await findRun(pool, req.params.key, num(req.params.num));
  if (!run) return res.status(404).json({ error: "Прогон не найден" });
  if (run.state !== "open") return res.status(409).json({ error: "Прогон закрыт. Откройте его, чтобы добавить кейсы" });
  if (run.locked) return res.status(409).json({ error: "Состав прогона из заблокированного тест-плана изменить нельзя" });
  const ids = await caseIds(pool, req.params.key, req.body.caseNums);
  if (!ids.length) return res.status(400).json({ error: "Выберите хотя бы один тест-кейс" });
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
    `SELECT rr.id, rr.result, rr.comment, rr.items, rr.assignee_id, c.kind, c.steps FROM run_results rr JOIN test_cases c ON c.id=rr.case_id
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
  const changed = result !== cur.result;
  // исполнитель и время фиксируются, когда меняется сам результат, а не комментарий
  await pool.query(
    `UPDATE run_results SET result=$1, comment=$2, items=$6, assignee_id=$7,
       executed_by = CASE WHEN $3 THEN (CASE WHEN $1='untested' THEN NULL ELSE $4::int END) ELSE executed_by END,
       executed_at = CASE WHEN $3 THEN (CASE WHEN $1='untested' THEN NULL ELSE now() END) ELSE executed_at END
     WHERE id=$5`,
    [result, comment, changed, req.user.id, cur.id, JSON.stringify(items), assignee]
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
