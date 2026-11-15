// Релизы и майлстоуны (E-01). Релиз (или спринт внутри него) собирает планы, прогоны и баги; страница релиза
// показывает готовность: сколько кейсов проверено и пройдено по последним результатам в прогонах релиза, открытые баги,
// сроки. Прогон по плану и перезапуск наследуют релиз, баг из прогона — релиз прогона (триггеры в миграции 031).
// Монтируется на /api/projects/:key
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { wrap, str, num, tooLong } = require("./util");

const router = express.Router({ mergeParams: true });
const STATUSES = ["planned", "active", "released", "cancelled"];
const OPEN = "('new','in_progress','fixed','verified')";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const day = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
const toRelease = (r) => ({
  id: r.id, num: r.num, ref: `${r.project_key}-V${r.num}`, name: r.name, description: r.description, status: r.status, parent: r.parent_num ?? null,
  starts: day(r.starts_on), due: day(r.due_on), released: r.released_at ? r.released_at.getTime() : null,
  createdBy: r.created_login || null, created: r.created_at.getTime(),
});
const baseSql = `SELECT r.*, p.num AS parent_num, u.login AS created_login FROM releases r
  LEFT JOIN releases p ON p.id=r.parent_id LEFT JOIN users u ON u.id=r.created_by`;

// id релиза и его спринтов (страница релиза показывает всё вместе)
const scopeSql = "SELECT id FROM releases WHERE id=$1 OR parent_id=$1";

// Готовность: последний результат каждого кейса по прогонам релиза, баги релиза, прогоны и планы
async function readiness(db, ids) {
  const [last, bugs, runs, plans] = await Promise.all([
    db.query(
      `SELECT result, count(*)::int AS n FROM (
         SELECT DISTINCT ON (rr.case_id) rr.result FROM run_results rr JOIN test_runs t ON t.id=rr.run_id
         WHERE t.release_id = ANY($1::int[]) ORDER BY rr.case_id, (rr.result <> 'untested') DESC, rr.executed_at DESC NULLS LAST) x
       GROUP BY result`, [ids]),
    db.query(`SELECT b.num, b.title, b.severity, b.status, u.login AS assignee FROM bugs b LEFT JOIN users u ON u.id=b.assignee_id
       WHERE b.release_id = ANY($1::int[]) ORDER BY (b.status IN ${OPEN}) DESC, array_position(ARRAY['blocker','critical','major','minor'], b.severity), b.num`, [ids]),
    db.query(`SELECT t.num, t.title, t.build, t.state, t.created_at,
         (SELECT json_object_agg(result, n) FROM (SELECT result, count(*)::int AS n FROM run_results WHERE run_id=t.id GROUP BY result) c) AS counts
       FROM test_runs t WHERE t.release_id = ANY($1::int[]) ORDER BY t.num DESC`, [ids]),
    db.query("SELECT num, title, mode, locked FROM test_plans WHERE release_id = ANY($1::int[]) ORDER BY num", [ids]),
  ]);
  const counts = { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const r of last.rows) counts[r.result] = r.n;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const done = total - counts.untested;
  const open = bugs.rows.filter((b) => ["new", "in_progress", "fixed", "verified"].includes(b.status));
  const severe = open.filter((b) => b.severity === "blocker" || b.severity === "critical");
  // что мешает выпуску — по этим причинам релиз «не готов»
  const blockers = [];
  if (!total) blockers.push("В релизе нет прогонов с кейсами");
  else {
    if (counts.untested) blockers.push(`Не проверено кейсов: ${counts.untested}`);
    if (counts.failed) blockers.push(`Упало кейсов: ${counts.failed}`);
    if (counts.blocked) blockers.push(`Заблокировано кейсов: ${counts.blocked}`);
  }
  if (severe.length) blockers.push(`Открытых блокирующих и критичных багов: ${severe.length}`);
  return {
    cases: { total, done, counts, progress: total ? Math.round((done / total) * 100) : 0, passRate: done ? Math.round((counts.passed / done) * 100) : 0 },
    bugs: { open: open.length, severe: severe.length, list: bugs.rows.slice(0, 200) },
    runs: runs.rows.map((r) => ({ num: r.num, title: r.title, build: r.build, state: r.state, created: r.created_at.getTime(), counts: r.counts || {} })),
    plans: plans.rows,
    ready: blockers.length === 0, blockers,
  };
}

router.get("/releases", wrap(async (req, res) => {
  const { rows } = await pool.query(`${baseSql} WHERE r.project_key=$1 ORDER BY COALESCE(r.due_on, '9999-12-31'), r.num`, [req.params.key]);
  // краткая сводка для списка: прогоны, открытые баги, прогресс
  const stats = await pool.query(
    `SELECT rl.id,
       (SELECT count(*)::int FROM test_runs t WHERE t.release_id IN (SELECT id FROM releases WHERE id=rl.id OR parent_id=rl.id)) AS runs,
       (SELECT count(*)::int FROM bugs b WHERE b.status IN ${OPEN} AND b.release_id IN (SELECT id FROM releases WHERE id=rl.id OR parent_id=rl.id)) AS open_bugs,
       (SELECT json_build_object('total', count(*), 'done', count(*) FILTER (WHERE result <> 'untested'), 'passed', count(*) FILTER (WHERE result='passed'))
          FROM (SELECT DISTINCT ON (rr.case_id) rr.result FROM run_results rr JOIN test_runs t ON t.id=rr.run_id
                WHERE t.release_id IN (SELECT id FROM releases WHERE id=rl.id OR parent_id=rl.id)
                ORDER BY rr.case_id, (rr.result <> 'untested') DESC, rr.executed_at DESC NULLS LAST) x) AS cases
     FROM releases rl WHERE rl.project_key=$1`, [req.params.key]);
  const by = new Map(stats.rows.map((s) => [s.id, s]));
  res.json({ items: rows.map((r) => ({ ...toRelease(r), runs: by.get(r.id)?.runs || 0, openBugs: by.get(r.id)?.open_bugs || 0, cases: by.get(r.id)?.cases })) });
}));

router.get("/releases/:num(\\d+)", wrap(async (req, res) => {
  const { rows } = await pool.query(`${baseSql} WHERE r.project_key=$1 AND r.num=$2`, [req.params.key, num(req.params.num)]);
  if (!rows[0]) return res.status(404).json({ error: "Релиз не найден" });
  const ids = (await pool.query(scopeSql, [rows[0].id])).rows.map((x) => x.id);
  const sprints = await pool.query(`${baseSql} WHERE r.parent_id=$1 ORDER BY COALESCE(r.starts_on, r.due_on), r.num`, [rows[0].id]);
  res.json({ ...toRelease(rows[0]), sprints: sprints.rows.map(toRelease), ...(await readiness(pool, ids)) });
}));

async function readRelease(key, body, prev = {}) {
  const r = {
    name: body.name === undefined ? prev.name : str(body.name, 200),
    description: body.description === undefined ? prev.description ?? "" : str(body.description, 5000),
    status: body.status === undefined ? prev.status ?? "planned" : str(body.status, 20),
    starts: body.starts === undefined ? day(prev.starts_on) : body.starts || null,
    due: body.due === undefined ? day(prev.due_on) : body.due || null,
    parentId: prev.parent_id ?? null,
  };
  if (!r.name) return { error: "Укажите название релиза" };
  const long = tooLong(body.name, 200);
  if (long) return { error: long };
  if (!STATUSES.includes(r.status)) return { error: `Статус: ${STATUSES.join(", ")}` };
  for (const d of [r.starts, r.due]) if (d !== null && (!DATE.test(d) || Number.isNaN(Date.parse(d)))) return { error: "Даты — в формате ГГГГ-ММ-ДД" };
  if (r.starts && r.due && r.starts > r.due) return { error: "Начало позже срока" };
  if (body.parent !== undefined) {
    if (body.parent === null) r.parentId = null;
    else {
      const p = (await pool.query("SELECT id, parent_id FROM releases WHERE project_key=$1 AND num=$2", [key, num(body.parent)])).rows[0];
      if (!p) return { error: "Родительский релиз не найден" };
      if (p.parent_id) return { error: "Спринт можно создать только внутри релиза, не внутри другого спринта" };
      if (prev.id && p.id === prev.id) return { error: "Релиз не может быть своим спринтом" };
      r.parentId = p.id;
    }
  }
  return { r };
}

const dup = (e) => e.code === "23505" && /releases_name/.test(e.constraint || "");

router.post("/releases", wrap(async (req, res) => {
  const { r, error } = await readRelease(req.params.key, req.body);
  if (error) return res.status(400).json({ error });
  try {
    const out = await tx(async (db) => {
      const seq = await db.query("UPDATE projects SET release_seq=release_seq+1 WHERE key=$1 RETURNING release_seq", [req.params.key]);
      if (!seq.rows[0]) return null;
      const n = seq.rows[0].release_seq;
      await db.query(
        `INSERT INTO releases(project_key, num, parent_id, name, description, status, starts_on, due_on, created_by, released_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $6='released' THEN now() END)`,
        [req.params.key, n, r.parentId, r.name, r.description, r.status, r.starts, r.due, req.user.id]);
      return { num: n, ref: `${req.params.key}-V${n}` };
    });
    if (!out) return res.status(404).json({ error: "Проект не найден" });
    broadcast("runs");
    res.status(201).json(out);
  } catch (e) {
    if (dup(e)) return res.status(409).json({ error: "Релиз с таким названием уже есть" });
    throw e;
  }
}));

router.patch("/releases/:num(\\d+)", wrap(async (req, res) => {
  const prev = (await pool.query("SELECT * FROM releases WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)])).rows[0];
  if (!prev) return res.status(404).json({ error: "Релиз не найден" });
  const { r, error } = await readRelease(req.params.key, req.body, prev);
  if (error) return res.status(400).json({ error });
  if (r.parentId && (await pool.query("SELECT 1 FROM releases WHERE parent_id=$1 LIMIT 1", [prev.id])).rows[0]) {
    return res.status(400).json({ error: "У релиза есть спринты — сделать его спринтом нельзя" });
  }
  try {
    await pool.query(
      `UPDATE releases SET name=$2, description=$3, status=$4, starts_on=$5, due_on=$6, parent_id=$7,
         released_at = CASE WHEN $4='released' THEN COALESCE(released_at, now()) ELSE NULL END WHERE id=$1`,
      [prev.id, r.name, r.description, r.status, r.starts, r.due, r.parentId]);
  } catch (e) {
    if (dup(e)) return res.status(409).json({ error: "Релиз с таким названием уже есть" });
    throw e;
  }
  broadcast("runs");
  res.json({ ok: true });
}));

// Удалить релиз (и его спринты): планы, прогоны и баги остаются, только отвязываются
router.delete("/releases/:num(\\d+)", wrap(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM releases WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  if (!rowCount) return res.status(404).json({ error: "Релиз не найден" });
  broadcast("runs");
  res.json({ ok: true });
}));

// Привязать к релизу: {"runs": [3, 4], "plans": [1], "bugs": [7], "linked": true}; linked:false — отвязать
const TABLES = { runs: "test_runs", plans: "test_plans", bugs: "bugs" };
router.post("/releases/:num(\\d+)/link", wrap(async (req, res) => {
  const rel = (await pool.query("SELECT id FROM releases WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)])).rows[0];
  if (!rel) return res.status(404).json({ error: "Релиз не найден" });
  const linked = req.body.linked !== false;
  const out = {};
  await tx(async (db) => {
    for (const [k, table] of Object.entries(TABLES)) {
      const nums = (Array.isArray(req.body[k]) ? req.body[k] : []).map(num).filter(Boolean).slice(0, 1000);
      if (!nums.length) continue;
      const r = await db.query(
        linked ? `UPDATE ${table} SET release_id=$3 WHERE project_key=$1 AND num = ANY($2::int[])`
          : `UPDATE ${table} SET release_id=NULL WHERE project_key=$1 AND num = ANY($2::int[]) AND release_id=$3`,
        [req.params.key, nums, rel.id]);
      out[k] = r.rowCount;
    }
  });
  broadcast("runs");
  broadcast("bugs");
  res.json({ ok: true, ...out });
}));

// Релиз при создании прогона, плана или бага: {"release": номер} → id или {error}
async function releaseId(db, key, ref) {
  if (ref === undefined || ref === null || ref === "") return { id: null };
  const r = (await db.query("SELECT id FROM releases WHERE project_key=$1 AND num=$2", [key, num(ref)])).rows[0];
  return r ? { id: r.id } : { error: "Релиз не найден" };
}

module.exports = { router, releaseId, readiness, STATUSES };
