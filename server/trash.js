// Корзина (C-02). Удалённое можно вернуть TRASH_DAYS дней (по умолчанию 30), потом фоновая задача удаляет навсегда.
//
// Проект удаляется мягко: projects.deleted_at — он пропадает для всех (server/access.js), но данные и файлы на месте.
// Удалить проект может только админ, и только назвав его ключ (защита от случайного клика).
//
// Кейс, прогон и баг удаляются по-настоящему, но перед этим их строки и всё зависимое (результаты, версии, комментарии,
// вложения, история статусов, ссылки других записей на них) снимаются в trash.data. Восстановление вставляет строки
// обратно с теми же id и номерами и возвращает ссылки — ID вида LK-12 остаётся прежним.
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const audit = require("./audit");
const { wrap, num, ms, HttpError } = require("./util");

const TRASH_DAYS = Number(process.env.TRASH_DAYS || 30);

// Столбцы таблицы без вычисляемых (их нельзя вставлять) — кэш на процесс
const columnCache = new Map();
async function columns(db, table) {
  if (!columnCache.has(table)) {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`,
      [table]
    );
    columnCache.set(table, rows.map((r) => r.column_name));
  }
  return columnCache.get(table);
}

const rowsOf = async (db, table, where, params) => (await db.query(`SELECT to_jsonb(t) AS r FROM ${table} t WHERE ${where}`, params)).rows.map((x) => x.r);

async function insertRows(db, table, rows) {
  if (!rows?.length) return;
  const cols = await columns(db, table);
  const list = cols.map((c) => `"${c}"`).join(", ");
  await db.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1) ON CONFLICT DO NOTHING`, [JSON.stringify(rows)]);
}

// ---------- снимки ----------
async function snapCase(db, caseId) {
  const [kase] = await rowsOf(db, "test_cases", "id=$1", [caseId]);
  const results = await rowsOf(db, "run_results", "case_id=$1", [caseId]);
  const resultIds = results.map((r) => r.id);
  return {
    test_cases: [{ ...kase, last_result_id: null }],
    test_case_versions: await rowsOf(db, "test_case_versions", "case_id=$1", [caseId]),
    run_results: results,
    attachments: resultIds.length ? await rowsOf(db, "attachments", "run_result_id = ANY($1::int[])", [resultIds]) : [],
    comments: await rowsOf(db, "comments", "case_id=$1", [caseId]),
    plan_cases: await rowsOf(db, "plan_cases", "case_id=$1", [caseId]),
    refs: {
      bugCase: (await db.query("SELECT id FROM bugs WHERE case_id=$1", [caseId])).rows.map((r) => r.id),
      bugResult: (await db.query("SELECT id, run_result_id FROM bugs WHERE run_result_id = ANY($1::int[])", [resultIds])).rows,
      autoTests: (await db.query("SELECT id FROM auto_tests WHERE case_id=$1", [caseId])).rows.map((r) => r.id),
    },
  };
}

async function snapRun(db, runId) {
  const results = await rowsOf(db, "run_results", "run_id=$1", [runId]);
  const resultIds = results.map((r) => r.id);
  return {
    test_runs: await rowsOf(db, "test_runs", "id=$1", [runId]),
    run_results: results,
    attachments: resultIds.length ? await rowsOf(db, "attachments", "run_result_id = ANY($1::int[])", [resultIds]) : [],
    refs: { bugResult: (await db.query("SELECT id, run_result_id FROM bugs WHERE run_result_id = ANY($1::int[])", [resultIds])).rows },
  };
}

async function snapBug(db, bugId) {
  return {
    bugs: await rowsOf(db, "bugs", "id=$1", [bugId]),
    comments: await rowsOf(db, "comments", "bug_id=$1", [bugId]),
    attachments: await rowsOf(db, "attachments", "bug_id=$1", [bugId]),
    bug_status_log: await rowsOf(db, "bug_status_log", "bug_id=$1", [bugId]),
    refs: { duplicates: (await db.query("SELECT id FROM bugs WHERE duplicate_of=$1", [bugId])).rows.map((r) => r.id) },
  };
}

// Баг восстанавливают раньше кейса или прогона, на который он ссылался: дописываем ссылку в их снимок в корзине
async function deferRef(db, key, col, bugId, target) {
  const plan = {
    case_id: ["case", "test_cases", "bugCase", () => bugId],
    run_result_id: ["%", "run_results", "bugResult", () => ({ id: bugId, run_result_id: target })],
    duplicate_of: ["bug", "bugs", "duplicates", () => bugId],
  }[col];
  if (!plan) return;
  const [kind, table, ref, value] = plan;
  await db.query(
    `UPDATE trash SET data = jsonb_set(data, '{refs,${ref}}', COALESCE(data->'refs'->'${ref}', '[]'::jsonb) || jsonb_build_array($3::jsonb))
     WHERE project_key=$1 AND kind LIKE $4 AND data->'${table}' @> jsonb_build_array(jsonb_build_object('id', $2::int))`,
    [key, target, JSON.stringify(value()), kind]
  );
}

// Удалить в корзину. kind: case | run | bug; возвращает {id корзины} или null, если записи нет
async function remove(req, kind, n) {
  const key = req.params.key;
  const out = await tx(async (db) => {
    const table = { case: "test_cases", run: "test_runs", bug: "bugs" }[kind];
    const { rows } = await db.query(`SELECT id, title FROM ${table} WHERE project_key=$1 AND num=$2 FOR UPDATE`, [key, n]);
    if (!rows[0]) return null;
    const { id, title } = rows[0];
    const data = kind === "case" ? await snapCase(db, id) : kind === "run" ? await snapRun(db, id) : await snapBug(db, id);
    const files = (data.attachments || []).map((a) => a.id);
    const t = await db.query(
      "INSERT INTO trash(project_key, kind, num, title, data, files, deleted_by) VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7) RETURNING id",
      [key, kind, n, title, data, files, req.user.id]
    );
    await db.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
    return { trashId: t.rows[0].id, title };
  });
  if (out) {
    audit.log(req, `${kind}.delete`, { target: `${key}-${{ case: "", run: "R", bug: "B" }[kind]}${n}`, details: { title: out.title, trashId: out.trashId } });
    broadcast("trash");
  }
  return out;
}

async function restore(db, item) {
  const d = item.data;
  if (item.kind === "case") {
    if ((await db.query("SELECT 1 FROM test_cases WHERE project_key=$1 AND num=$2", [item.project_key, item.num])).rows[0]) {
      throw new HttpError(409, "Номер кейса уже занят");
    }
    // папку могли удалить — кейс вернётся в корень
    for (const c of d.test_cases) {
      if (c.folder_id && !(await db.query("SELECT 1 FROM case_folders WHERE id=$1", [c.folder_id])).rows[0]) c.folder_id = null;
    }
    await insertRows(db, "test_cases", d.test_cases);
    await insertRows(db, "test_case_versions", d.test_case_versions);
    // результаты возвращаются только в прогоны, которые ещё существуют
    const runs = new Set((await db.query("SELECT id FROM test_runs WHERE id = ANY($1::int[])", [d.run_results.map((r) => r.run_id)])).rows.map((r) => r.id));
    const results = d.run_results.filter((r) => runs.has(r.run_id));
    const kept = new Set(results.map((r) => r.id));
    await insertRows(db, "run_results", results);
    await insertRows(db, "attachments", d.attachments.filter((a) => kept.has(a.run_result_id)));
    await insertRows(db, "comments", d.comments);
    const plans = new Set((await db.query("SELECT id FROM test_plans WHERE id = ANY($1::int[])", [d.plan_cases.map((p) => p.plan_id)])).rows.map((r) => r.id));
    await insertRows(db, "plan_cases", d.plan_cases.filter((p) => plans.has(p.plan_id)));
    const caseId = d.test_cases[0].id;
    await db.query("UPDATE bugs SET case_id=$1 WHERE id = ANY($2::int[]) AND case_id IS NULL", [caseId, d.refs.bugCase]);
    for (const b of d.refs.bugResult) if (kept.has(b.run_result_id)) await db.query("UPDATE bugs SET run_result_id=$1 WHERE id=$2 AND run_result_id IS NULL", [b.run_result_id, b.id]);
    await db.query("UPDATE auto_tests SET case_id=$1 WHERE id = ANY($2::int[]) AND case_id IS NULL", [caseId, d.refs.autoTests]);
    await db.query("SELECT test_case_refresh_last($1)", [caseId]);
  } else if (item.kind === "run") {
    if ((await db.query("SELECT 1 FROM test_runs WHERE project_key=$1 AND num=$2", [item.project_key, item.num])).rows[0]) {
      throw new HttpError(409, "Номер прогона уже занят");
    }
    for (const r of d.test_runs) {
      if (r.plan_id && !(await db.query("SELECT 1 FROM test_plans WHERE id=$1", [r.plan_id])).rows[0]) r.plan_id = null;
    }
    await insertRows(db, "test_runs", d.test_runs);
    // кейсы, которые за это время удалили, в прогон не вернутся
    const cases = new Set((await db.query("SELECT id FROM test_cases WHERE id = ANY($1::int[])", [d.run_results.map((r) => r.case_id)])).rows.map((r) => r.id));
    const results = d.run_results.filter((r) => cases.has(r.case_id));
    const kept = new Set(results.map((r) => r.id));
    await insertRows(db, "run_results", results);
    await insertRows(db, "attachments", d.attachments.filter((a) => kept.has(a.run_result_id)));
    for (const b of d.refs.bugResult) if (kept.has(b.run_result_id)) await db.query("UPDATE bugs SET run_result_id=$1 WHERE id=$2 AND run_result_id IS NULL", [b.run_result_id, b.id]);
    for (const c of cases) await db.query("SELECT test_case_refresh_last($1)", [c]);
  } else {
    if ((await db.query("SELECT 1 FROM bugs WHERE project_key=$1 AND num=$2", [item.project_key, item.num])).rows[0]) {
      throw new HttpError(409, "Номер бага уже занят");
    }
    for (const b of d.bugs) {
      for (const [col, table] of [["case_id", "test_cases"], ["run_result_id", "run_results"], ["duplicate_of", "bugs"], ["assignee_id", "users"]]) {
        if (!b[col] || (await db.query(`SELECT 1 FROM ${table} WHERE id=$1`, [b[col]])).rows[0]) continue;
        // то, на что ссылался баг, само лежит в корзине: ссылка вернётся, когда восстановят и его
        await deferRef(db, item.project_key, col, b.id, b[col]);
        b[col] = null;
      }
    }
    await insertRows(db, "bugs", d.bugs);
    await insertRows(db, "comments", d.comments);
    await insertRows(db, "attachments", d.attachments);
    await insertRows(db, "bug_status_log", d.bug_status_log);
    await db.query("UPDATE bugs SET duplicate_of=$1 WHERE id = ANY($2::int[]) AND duplicate_of IS NULL", [d.bugs[0].id, d.refs.duplicates]);
  }
  await db.query("DELETE FROM trash WHERE id=$1", [item.id]);
}

const toItem = (r) => ({
  id: r.id, kind: r.kind, num: r.num, title: r.title, deletedBy: r.deleted_by_login, deleted: ms(r.deleted_at),
  purgeAt: ms(new Date(r.deleted_at.getTime() + TRASH_DAYS * 86400000)),
  ref: `${r.project_key}-${{ case: "", run: "R", bug: "B" }[r.kind]}${r.num}`,
});

// ---------- корзина проекта: /api/projects/:key/trash ----------
const router = express.Router({ mergeParams: true });

router.get("/trash", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.project_key, t.kind, t.num, t.title, t.deleted_at, u.login AS deleted_by_login FROM trash t
     LEFT JOIN users u ON u.id=t.deleted_by WHERE t.project_key=$1 ORDER BY t.deleted_at DESC`,
    [req.params.key]
  );
  res.json({ items: rows.map(toItem), days: TRASH_DAYS });
}));

router.post("/trash/:id/restore", wrap(async (req, res) => {
  const ref = await tx(async (db) => {
    const { rows } = await db.query("SELECT * FROM trash WHERE id=$1 AND project_key=$2 FOR UPDATE", [num(req.params.id), req.params.key]);
    if (!rows[0]) throw new HttpError(404, "В корзине такого нет");
    await restore(db, rows[0]);
    return toItem({ ...rows[0], deleted_by_login: null }).ref;
  });
  audit.log(req, "trash.restore", { target: ref });
  broadcast("cases");
  broadcast("runs");
  broadcast("bugs");
  broadcast("trash");
  res.json({ ok: true, ref });
}));

// Удалить из корзины навсегда — только админ
router.delete("/trash/:id", wrap(async (req, res) => {
  if (req.projectRole !== "admin") return res.status(403).json({ error: "Удалить навсегда может только администратор" });
  const r = await pool.query("DELETE FROM trash WHERE id=$1 AND project_key=$2 RETURNING kind, num", [num(req.params.id), req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: "В корзине такого нет" });
  audit.log(req, "trash.purge", { target: `${req.params.key}-${{ case: "", run: "R", bug: "B" }[r.rows[0].kind]}${r.rows[0].num}` });
  broadcast("trash");
  res.json({ ok: true });
}));

// ---------- удалённые проекты: /api/admin ----------
const adminRouter = express.Router();

adminRouter.get("/trash/projects", wrap(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT p.key, p.name, p.deleted_at, u.login AS deleted_by FROM projects p LEFT JOIN users u ON u.id=p.deleted_by
     WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`
  );
  res.json({
    items: rows.map((p) => ({ key: p.key, name: p.name, deletedBy: p.deleted_by, deleted: ms(p.deleted_at), purgeAt: ms(new Date(p.deleted_at.getTime() + TRASH_DAYS * 86400000)) })),
    days: TRASH_DAYS,
  });
}));

adminRouter.post("/projects/:key/restore", wrap(async (req, res) => {
  const r = await pool.query("UPDATE projects SET deleted_at=NULL, deleted_by=NULL WHERE key=$1 AND deleted_at IS NOT NULL", [req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: "Удалённого проекта с таким ключом нет" });
  audit.log(req, "project.restore", { project: req.params.key, target: req.params.key });
  broadcast("projects", null);
  res.json({ ok: true });
}));

adminRouter.delete("/projects/:key", wrap(async (req, res) => {
  if (req.body?.confirm !== req.params.key) return res.status(400).json({ error: `Для удаления навсегда передайте {"confirm": "${req.params.key}"}` });
  const r = await pool.query("DELETE FROM projects WHERE key=$1 AND deleted_at IS NOT NULL", [req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: "Сначала удалите проект в корзину" });
  audit.log(req, "project.purge", { project: req.params.key, target: req.params.key });
  res.json({ ok: true });
}));

// Мягкое удаление проекта (DELETE /api/projects/:key): только админ и с подтверждением ключом
async function deleteProject(req, res) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Удалить проект может только администратор" });
  if (req.body?.confirm !== req.params.key) return res.status(400).json({ error: `Подтвердите удаление: передайте {"confirm": "${req.params.key}"}` });
  const r = await pool.query("UPDATE projects SET deleted_at=now(), deleted_by=$2 WHERE key=$1 AND deleted_at IS NULL", [req.params.key, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Проект не найден" });
  audit.log(req, "project.delete", { project: req.params.key, target: req.params.key });
  broadcast("projects", null);
  res.json({ ok: true, restoreDays: TRASH_DAYS });
}

// Фоновая очистка: всё, что лежит в корзине дольше TRASH_DAYS
async function purgeExpired() {
  const a = await pool.query("DELETE FROM trash WHERE deleted_at < now() - make_interval(days => $1)", [TRASH_DAYS]);
  const b = await pool.query("DELETE FROM projects WHERE deleted_at < now() - make_interval(days => $1) RETURNING key", [TRASH_DAYS]);
  for (const p of b.rows) audit.write({ actor: null, action: "project.purge", project: p.key, target: p.key, details: { auto: true } });
  if (a.rowCount || b.rowCount) console.log(`[trash] удалено навсегда: записей ${a.rowCount}, проектов ${b.rowCount}`);
}

module.exports = { router, adminRouter, remove, deleteProject, purgeExpired, TRASH_DAYS };
