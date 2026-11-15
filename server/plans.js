// Тест-планы. Монтируется на /api/projects/:key.
// Статический план — кейсы выбраны вручную. Динамический — набор задан фильтром (папки, приоритеты, статусы, вид,
// текст, автоматизация, последний результат) и пересобирается в момент использования: новые кейсы попадают в него сами.
// Блокировка фиксирует план: состав и версии кейсов замораживаются (для динамического — снимок на момент блокировки),
// план нельзя менять и удалять, прогоны из него проверяют именно зафиксированные версии и не могут быть удалены.
// Из плана можно выгрузить набор кейсов (CSV/JSON) и создать прогон с автоматическим распределением по исполнителям.
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const caseio = require("./caseio");
const events = require("./events");
const { distribute } = require("./distribute");
const { isAdmin } = require("./access");
const { wrap, str, num, HttpError } = require("./util");

const PRIORITIES = ["critical", "high", "medium", "low"];
const STATUSES = ["draft", "review", "ready", "deprecated"];
const KINDS = ["case", "checklist"];
const RESULTS = ["untested", "passed", "failed", "blocked", "skipped"];

const router = express.Router({ mergeParams: true });

const pick = (v, allowed) => (Array.isArray(v) ? [...new Set(v.filter((x) => allowed.includes(x)))] : []);
function readFilter(f = {}) {
  return {
    folders: Array.isArray(f.folders) ? f.folders.map(num).filter(Boolean).slice(0, 200) : [],
    // корень проекта (кейсы без папки)
    root: f.root === true,
    priorities: pick(f.priorities, PRIORITIES),
    // по умолчанию в динамический план идут только готовые кейсы
    statuses: f.statuses === undefined ? ["ready"] : pick(f.statuses, STATUSES),
    kinds: pick(f.kinds, KINDS),
    text: str(f.text, 200),
    automated: ["yes", "no"].includes(f.automated) ? f.automated : "any",
    lastResults: pick(f.lastResults, RESULTS),
    // теги: кейс с любым из них
    tags: Array.isArray(f.tags) ? f.tags.map((t) => str(t, 50)).filter(Boolean).slice(0, 20) : [],
  };
}

// Кейсы по фильтру: [{id, num, version}]
async function byFilter(db, key, f) {
  const { rows } = await db.query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM case_folders WHERE project_key=$1 AND id = ANY($2::int[])
       UNION SELECT cf.id FROM case_folders cf JOIN sub ON cf.parent_id = sub.id
     )
     SELECT c.id, c.num, c.version FROM test_cases c
     WHERE c.project_key=$1
       AND (cardinality($2::int[]) = 0 AND NOT $3 OR c.folder_id IN (SELECT id FROM sub) OR ($3 AND c.folder_id IS NULL))
       AND (cardinality($4::text[]) = 0 OR c.priority = ANY($4::text[]))
       AND (cardinality($5::text[]) = 0 OR c.status = ANY($5::text[]))
       AND (cardinality($6::text[]) = 0 OR c.kind = ANY($6::text[]))
       AND ($7 = '' OR c.title ILIKE '%' || $7 || '%')
       AND ($8 = 'any' OR ($8 = 'yes') = EXISTS (SELECT 1 FROM auto_tests a WHERE a.case_id=c.id))
       AND (cardinality($9::text[]) = 0 OR c.last_result = ANY($9::text[]))
       AND (cardinality($10::text[]) = 0 OR c.tags && $10::text[])
     ORDER BY c.num`,
    [key, f.folders, f.root, f.priorities, f.statuses, f.kinds, f.text.replace(/[%_\\]/g, "\\$&"), f.automated, f.lastResults, f.tags || []]
  );
  return rows;
}

// Состав плана: [{id, num, version}]. version — зафиксированная (у заблокированного) или текущая
async function planCases(db, plan) {
  if (plan.mode === "dynamic" && !plan.locked) return byFilter(db, plan.project_key, readFilter(plan.filter));
  const { rows } = await db.query(
    `SELECT c.id, c.num, COALESCE(pc.case_version, c.version) AS version FROM plan_cases pc JOIN test_cases c ON c.id=pc.case_id
     WHERE pc.plan_id=$1 ORDER BY c.num`,
    [plan.id]
  );
  return rows;
}

const findPlan = async (db, key, n, lock = false) =>
  (await db.query(`SELECT * FROM test_plans WHERE project_key=$1 AND num=$2${lock ? " FOR UPDATE" : ""}`, [key, n])).rows[0];

async function mustPlan(db, req, { editable = false, lock = false } = {}) {
  const plan = await findPlan(db, req.params.key, num(req.params.num), lock);
  if (!plan) throw new HttpError(404, "Тест-план не найден");
  if (editable && plan.locked) throw new HttpError(409, "План заблокирован. Разблокируйте его, чтобы менять");
  return plan;
}

async function caseIds(db, key, nums) {
  const list = Array.isArray(nums) ? nums.map(num).filter(Boolean) : [];
  if (!list.length) return [];
  const { rows } = await db.query("SELECT id FROM test_cases WHERE project_key=$1 AND num = ANY($2::int[])", [key, list]);
  return rows.map((r) => r.id);
}

function readPlan(body) {
  const p = {
    title: str(body.title, 300),
    description: str(body.description, 5000),
    mode: body.mode === "dynamic" ? "dynamic" : "static",
    filter: readFilter(body.filter || {}),
  };
  if (!p.title) return { error: "Укажите название тест-плана" };
  return { p };
}

// Список с размером: для динамического — сколько кейсов подходит сейчас
router.get("/plans", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, cu.login AS created_by_login, lu.login AS locked_by_login,
       (SELECT count(*)::int FROM plan_cases pc WHERE pc.plan_id=p.id) AS static_count,
       (SELECT count(*)::int FROM test_runs r WHERE r.plan_id=p.id) AS runs
     FROM test_plans p LEFT JOIN users cu ON cu.id=p.created_by LEFT JOIN users lu ON lu.id=p.locked_by
     WHERE p.project_key=$1 ORDER BY p.num DESC`,
    [req.params.key]
  );
  const plans = [];
  for (const p of rows) {
    const count = p.mode === "dynamic" && !p.locked ? (await byFilter(pool, p.project_key, readFilter(p.filter))).length : p.static_count;
    plans.push({
      num: p.num, id: `${p.project_key}-P${p.num}`, title: p.title, description: p.description, mode: p.mode, filter: readFilter(p.filter),
      locked: p.locked, lockedBy: p.locked_by_login, lockedAt: p.locked_at?.getTime() || null, createdBy: p.created_by_login,
      created: p.created_at.getTime(), updated: p.updated_at.getTime(), caseCount: count, runs: p.runs,
    });
  }
  res.json({ plans });
}));

// Кейсы плана с версиями. Для заблокированного — текст зафиксированных версий
router.get("/plans/:num/cases", wrap(async (req, res) => {
  const plan = await mustPlan(pool, req);
  const list = await planCases(pool, plan);
  const { rows } = await pool.query(
    `SELECT c.num, c.version AS current, v.version, v.kind, v.title, v.priority, v.status FROM unnest($1::int[], $2::int[]) AS x(id, ver)
     JOIN test_cases c ON c.id=x.id JOIN test_case_versions v ON v.case_id=x.id AND v.version=x.ver ORDER BY c.num`,
    [list.map((c) => c.id), list.map((c) => c.version)]
  );
  res.json({
    cases: rows.map((r) => ({ num: r.num, version: r.version, currentVersion: r.current, kind: r.kind, title: r.title, priority: r.priority, status: r.status })),
  });
}));

// Предпросмотр фильтра динамического плана без сохранения
router.post("/plans/preview", wrap(async (req, res) => {
  const list = await byFilter(pool, req.params.key, readFilter(req.body.filter || {}));
  res.json({ caseNums: list.map((c) => c.num) });
}));

router.post("/plans", wrap(async (req, res) => {
  const { p, error } = readPlan(req.body);
  if (error) return res.status(400).json({ error });
  const key = req.params.key;
  const n = await tx(async (db) => {
    const seq = await db.query("UPDATE projects SET plan_seq=plan_seq+1 WHERE key=$1 RETURNING plan_seq", [key]);
    const next = seq.rows[0].plan_seq;
    const { rows } = await db.query(
      "INSERT INTO test_plans(project_key, num, title, description, mode, filter, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [key, next, p.title, p.description, p.mode, p.filter, req.user.id]
    );
    if (p.mode === "static") {
      const ids = await caseIds(db, key, req.body.caseNums);
      if (ids.length) await db.query("INSERT INTO plan_cases(plan_id, case_id) SELECT $1, unnest($2::int[])", [rows[0].id, ids]);
    }
    return next;
  });
  broadcast("plans");
  res.status(201).json({ num: n, id: `${key}-P${n}` });
}));

router.patch("/plans/:num", wrap(async (req, res) => {
  const plan = await mustPlan(pool, req, { editable: true });
  const { p, error } = readPlan({ ...plan, ...req.body });
  if (error) return res.status(400).json({ error });
  await pool.query("UPDATE test_plans SET title=$1, description=$2, mode=$3, filter=$4, updated_at=now() WHERE id=$5", [p.title, p.description, p.mode, p.filter, plan.id]);
  // из статического в динамический: ручной список больше не нужен
  if (p.mode === "dynamic" && plan.mode === "static") await pool.query("DELETE FROM plan_cases WHERE plan_id=$1", [plan.id]);
  broadcast("plans");
  res.json({ ok: true });
}));

router.delete("/plans/:num", wrap(async (req, res) => {
  const plan = await mustPlan(pool, req, { editable: true });
  await pool.query("DELETE FROM test_plans WHERE id=$1", [plan.id]);
  broadcast("plans");
  res.json({ ok: true });
}));

// Состав статического плана: {"add": [номера], "remove": [номера]}
router.post("/plans/:num/cases", wrap(async (req, res) => {
  const out = await tx(async (db) => {
    const plan = await mustPlan(db, req, { editable: true, lock: true });
    if (plan.mode !== "static") throw new HttpError(400, "Состав динамического плана задаётся фильтром");
    const add = await caseIds(db, plan.project_key, req.body.add);
    const remove = await caseIds(db, plan.project_key, req.body.remove);
    const a = add.length ? await db.query("INSERT INTO plan_cases(plan_id, case_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING", [plan.id, add]) : { rowCount: 0 };
    const r = remove.length ? await db.query("DELETE FROM plan_cases WHERE plan_id=$1 AND case_id = ANY($2::int[])", [plan.id, remove]) : { rowCount: 0 };
    await db.query("UPDATE test_plans SET updated_at=now() WHERE id=$1", [plan.id]);
    return { added: a.rowCount, removed: r.rowCount };
  });
  broadcast("plans");
  res.json(out);
}));

router.post("/plans/:num/lock", wrap(async (req, res) => {
  const count = await tx(async (db) => {
    const plan = await mustPlan(db, req, { lock: true });
    if (plan.locked) throw new HttpError(409, "План уже заблокирован");
    const list = await planCases(db, plan);
    if (!list.length) throw new HttpError(400, "В плане нет кейсов — блокировать нечего");
    // снимок состава и версий: дальнейшие правки кейсов на план не влияют
    await db.query("DELETE FROM plan_cases WHERE plan_id=$1", [plan.id]);
    await db.query("INSERT INTO plan_cases(plan_id, case_id, case_version) SELECT $1, * FROM unnest($2::int[], $3::int[])", [plan.id, list.map((c) => c.id), list.map((c) => c.version)]);
    await db.query("UPDATE test_plans SET locked=true, locked_by=$1, locked_at=now() WHERE id=$2", [req.user.id, plan.id]);
    return list.length;
  });
  broadcast("plans");
  events.emit(req.params.key, "plan.locked", { plan: { id: `${req.params.key}-P${req.params.num}`, num: Number(req.params.num), cases: count } }, req.user);
  res.json({ ok: true, cases: count });
}));

// Разблокировать может тот, кто заблокировал, или администратор
router.post("/plans/:num/unlock", wrap(async (req, res) => {
  await tx(async (db) => {
    const plan = await mustPlan(db, req, { lock: true });
    if (!plan.locked) throw new HttpError(409, "План не заблокирован");
    if (plan.locked_by !== req.user.id && !isAdmin(req.user)) throw new HttpError(403, "Разблокировать план может тот, кто его заблокировал, или администратор");
    if (plan.mode === "dynamic") await db.query("DELETE FROM plan_cases WHERE plan_id=$1", [plan.id]);
    else await db.query("UPDATE plan_cases SET case_version=NULL WHERE plan_id=$1", [plan.id]);
    await db.query("UPDATE test_plans SET locked=false, locked_by=NULL, locked_at=NULL, updated_at=now() WHERE id=$1", [plan.id]);
  });
  broadcast("plans");
  events.emit(req.params.key, "plan.unlocked", { plan: { id: `${req.params.key}-P${req.params.num}`, num: Number(req.params.num) } }, req.user);
  res.json({ ok: true });
}));

// Экспорт тестового набора из плана: ?format=csv (по умолчанию, тот же формат, что импорт кейсов) | json
router.get("/plans/:num/export", wrap(async (req, res) => {
  const plan = await mustPlan(pool, req);
  const key = plan.project_key;
  const list = await planCases(pool, plan);
  const { rows } = await pool.query(
    `SELECT c.num, c.folder_id, v.version, v.kind, v.title, v.priority, v.status, v.preconditions, v.steps, v.expected, expand_steps(v.step_list) AS step_list, v.tags
     FROM unnest($1::int[], $2::int[]) AS x(id, ver) JOIN test_cases c ON c.id=x.id
     JOIN test_case_versions v ON v.case_id=x.id AND v.version=x.ver ORDER BY c.num`,
    [list.map((c) => c.id), list.map((c) => c.version)]
  );
  const { pathOf } = await caseio.folderPaths(pool, key);
  const base = `${key}-P${plan.num}`;
  if (req.query.format === "json") {
    res.set("Content-Disposition", `attachment; filename="${base}.json"`);
    return res.json({
      format: "testball-suite", version: 1, project: key,
      plan: { id: base, title: plan.title, description: plan.description, mode: plan.mode, filter: plan.filter, locked: plan.locked, exported: new Date().toISOString() },
      cases: rows.map((c) => ({
        id: `${key}-${c.num}`, version: c.version, folder: c.folder_id ? pathOf(c.folder_id) : "", kind: c.kind, title: c.title,
        priority: c.priority, status: c.status, preconditions: c.preconditions, steps: c.steps, expected: c.expected, stepList: c.step_list, tags: c.tags,
      })),
    });
  }
  caseio.sendCsv(res, rows.map((c) => caseio.csvRow(key, c, pathOf)), `${base} ${plan.title}.csv`.replace(/[\\/:*?"<>|]/g, "_"), `${base}.csv`);
}));

// Прогон из плана: {"title", "build", "env", "assign": {"users": ["anna"], "strategy": "balanced"}}
router.post("/plans/:num/runs", wrap(async (req, res) => {
  const title = str(req.body.title, 300);
  if (!title) return res.status(400).json({ error: "Укажите название прогона" });
  const cf = await require("./casemodel").readFields(pool, req.params.key, "run", req.body.fields, {});
  if (cf.error) return res.status(400).json({ error: cf.error });
  const fields = cf.fields;
  const out = await tx(async (db) => {
    const plan = await mustPlan(db, req);
    const key = plan.project_key;
    const list = await planCases(db, plan);
    if (!list.length) throw new HttpError(400, "В плане нет кейсов");
    const seq = await db.query("UPDATE projects SET run_seq=run_seq+1 WHERE key=$1 RETURNING run_seq", [key]);
    const n = seq.rows[0].run_seq;
    const run = await db.query(
      "INSERT INTO test_runs(project_key, num, title, build, environment, plan_id, created_by, fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [key, n, title, str(req.body.build, 200), str(req.body.env, 500), plan.id, req.user.id, fields]
    );
    // у заблокированного плана в прогон идут зафиксированные версии, иначе триггер возьмёт текущие
    await db.query(
      "INSERT INTO run_results(run_id, case_id, case_version) SELECT $1, * FROM unnest($2::int[], $3::int[])",
      [run.rows[0].id, list.map((c) => c.id), list.map((c) => (plan.locked ? c.version : null))]
    );
    const assign = req.body.assign;
    const dist = assign?.users?.length ? await distribute(db, key, run.rows[0].id, assign.users, assign.strategy || "balanced") : null;
    return { n, dist };
  });
  broadcast("runs");
  events.emit(req.params.key, "run.created", { run: await events.snap.run(req.params.key, out.n) }, req.user);
  res.status(201).json({ num: out.n, distribution: out.dist });
}));

module.exports = { router, byFilter, readFilter, planCases };
