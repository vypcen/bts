// Общие шаги: именованные блоки шагов проекта («Вход как администратор», «Оформить заказ»).
// В кейс вставляется ссылка {shared: id}; при чтении её раскрывает функция PostgreSQL expand_steps,
// поэтому правка блока сразу видна во всех кейсах. Монтируется на /api/projects/:key
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { normalizeSteps } = require("./casemodel");
const { wrap, str, num } = require("./util");

const router = express.Router({ mergeParams: true });

// кейсы, где используется блок (ссылка на него в step_list)
const usedSql = `SELECT c.num, c.title FROM test_cases c WHERE c.project_key=$1 AND c.step_list @> jsonb_build_array(jsonb_build_object('shared', $2::int)) ORDER BY c.num`;

const toShared = (r) => ({
  id: r.id, num: r.num, title: r.title, stepList: r.step_list, usedIn: r.used ?? undefined,
  updatedBy: r.updated_by_login || null, updated: r.updated_at.getTime(),
});

router.get("/shared-steps", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, u.login AS updated_by_login,
       (SELECT count(*)::int FROM test_cases c WHERE c.project_key=s.project_key AND c.step_list @> jsonb_build_array(jsonb_build_object('shared', s.id))) AS used
     FROM shared_steps s LEFT JOIN users u ON u.id=s.updated_by WHERE s.project_key=$1 ORDER BY lower(s.title)`,
    [req.params.key]
  );
  res.json({ items: rows.map(toShared) });
}));

router.get("/shared-steps/:num(\\d+)", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT s.*, u.login AS updated_by_login FROM shared_steps s LEFT JOIN users u ON u.id=s.updated_by WHERE s.project_key=$1 AND s.num=$2",
    [req.params.key, num(req.params.num)]);
  if (!rows[0]) return res.status(404).json({ error: "Общие шаги не найдены" });
  const used = await pool.query(usedSql, [req.params.key, rows[0].id]);
  res.json({ ...toShared(rows[0]), cases: used.rows });
}));

function readShared(body, prev = {}) {
  const title = str(body.title ?? prev.title, 300);
  // внутри блока — только обычные шаги: вложенные блоки запутали бы и людей, и отчёты
  const steps = body.stepList !== undefined ? (normalizeSteps(body.stepList) || []).filter((s) => !s.shared) : prev.step_list;
  if (!title) return { error: "Укажите название блока, например «Вход как администратор»" };
  if (!steps?.length) return { error: "Добавьте хотя бы один шаг" };
  return { title, steps };
}

router.post("/shared-steps", wrap(async (req, res) => {
  const { title, steps, error } = readShared(req.body);
  if (error) return res.status(400).json({ error });
  const r = await tx(async (db) => {
    const n = (await db.query("UPDATE projects SET shared_seq=shared_seq+1 WHERE key=$1 RETURNING shared_seq", [req.params.key])).rows[0].shared_seq;
    return (await db.query(
      "INSERT INTO shared_steps(project_key, num, title, step_list, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id, num",
      [req.params.key, n, title, JSON.stringify(steps), req.user.id]
    )).rows[0];
  });
  broadcast("cases");
  res.status(201).json(r);
}));

router.patch("/shared-steps/:num(\\d+)", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM shared_steps WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  if (!rows[0]) return res.status(404).json({ error: "Общие шаги не найдены" });
  const { title, steps, error } = readShared(req.body, rows[0]);
  if (error) return res.status(400).json({ error });
  await pool.query("UPDATE shared_steps SET title=$2, step_list=$3, updated_by=$4, updated_at=now() WHERE id=$1", [rows[0].id, title, JSON.stringify(steps), req.user.id]);
  broadcast("cases");
  res.json({ ok: true });
}));

// Удалить блок. Если он используется — только с {inline: true}: в кейсы вставляются копии его шагов
router.delete("/shared-steps/:num(\\d+)", wrap(async (req, res) => {
  const key = req.params.key;
  const out = await tx(async (db) => {
    const { rows } = await db.query("SELECT * FROM shared_steps WHERE project_key=$1 AND num=$2 FOR UPDATE", [key, num(req.params.num)]);
    const s = rows[0];
    if (!s) return { status: 404, error: "Общие шаги не найдены" };
    const used = await db.query(`SELECT c.id, c.step_list FROM test_cases c WHERE c.project_key=$1 AND c.step_list @> jsonb_build_array(jsonb_build_object('shared', $2::int))`, [key, s.id]);
    if (used.rows.length && req.body.inline !== true) return { status: 409, error: `Блок используется в кейсах (${used.rows.length}). Удалите с копированием шагов в кейсы`, inUse: used.rows.length };
    for (const c of used.rows) {
      const list = c.step_list.flatMap((x) => (x && x.shared === s.id ? s.step_list : [x]));
      await db.query("UPDATE test_cases SET step_list=$2, updated_at=now() WHERE id=$1", [c.id, JSON.stringify(list)]);
    }
    await db.query("DELETE FROM shared_steps WHERE id=$1", [s.id]);
    return { inlined: used.rows.length };
  });
  if (out.error) return res.status(out.status).json({ error: out.error, inUse: out.inUse });
  broadcast("cases");
  res.json({ ok: true, inlined: out.inlined });
}));

// Проверка при сохранении кейса: ссылки только на блоки этого проекта
async function checkRefs(key, stepList) {
  const ids = [...new Set((stepList || []).filter((s) => s.shared).map((s) => s.shared))];
  if (!ids.length) return null;
  const { rows } = await pool.query("SELECT id FROM shared_steps WHERE project_key=$1 AND id = ANY($2::int[])", [key, ids]);
  return rows.length === ids.length ? null : "Ссылка на общие шаги другого проекта или удалённый блок";
}

module.exports = { router, checkRefs };
