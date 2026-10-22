// Папки тест-кейсов. Монтируется на /api/projects/:key
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { wrap, str, num } = require("./util");

const router = express.Router({ mergeParams: true });
const TAKEN = "В этой папке уже есть папка с таким названием";
const isTaken = (e) => e.code === "23505" && e.constraint === "case_folders_name_key";

// Папка-родитель из тела запроса: null — корень проекта, undefined — такой папки в проекте нет
async function folderId(db, key, raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const { rows } = await db.query("SELECT id FROM case_folders WHERE project_key=$1 AND id=$2", [key, num(raw)]);
  return rows[0] ? rows[0].id : undefined;
}

router.post("/folders", wrap(async (req, res) => {
  const name = str(req.body.name, 200);
  if (!name) return res.status(400).json({ error: "Укажите название папки" });
  const parent = await folderId(pool, req.params.key, req.body.parent);
  if (parent === undefined) return res.status(400).json({ error: "Родительская папка не найдена" });
  try {
    const { rows } = await pool.query(
      "INSERT INTO case_folders(project_key, parent_id, name, created_by) VALUES ($1,$2,$3,$4) RETURNING id",
      [req.params.key, parent, name, req.user.id]
    );
    broadcast("folders");
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (isTaken(e)) return res.status(409).json({ error: TAKEN });
    throw e;
  }
}));

// Переименовать и/или перенести в другую папку
router.patch("/folders/:id", wrap(async (req, res) => {
  const key = req.params.key;
  const { rows } = await pool.query("SELECT id, name, parent_id FROM case_folders WHERE project_key=$1 AND id=$2", [key, num(req.params.id)]);
  const cur = rows[0];
  if (!cur) return res.status(404).json({ error: "Папка не найдена" });
  const name = req.body.name === undefined ? cur.name : str(req.body.name, 200);
  if (!name) return res.status(400).json({ error: "Укажите название папки" });
  let parent = cur.parent_id;
  if (req.body.parent !== undefined) {
    parent = await folderId(pool, key, req.body.parent);
    if (parent === undefined) return res.status(400).json({ error: "Родительская папка не найдена" });
    // нельзя положить папку в саму себя или в собственную подпапку
    if (parent !== null) {
      const loop = await pool.query(
        `WITH RECURSIVE up AS (SELECT id, parent_id FROM case_folders WHERE id=$1
           UNION ALL SELECT f.id, f.parent_id FROM case_folders f JOIN up ON f.id=up.parent_id)
         SELECT 1 FROM up WHERE id=$2`,
        [parent, cur.id]
      );
      if (loop.rows.length) return res.status(400).json({ error: "Нельзя перенести папку внутрь неё самой" });
    }
  }
  try {
    await pool.query("UPDATE case_folders SET name=$1, parent_id=$2 WHERE id=$3", [name, parent, cur.id]);
  } catch (e) {
    if (isTaken(e)) return res.status(409).json({ error: TAKEN });
    throw e;
  }
  broadcast("folders");
  res.json({ ok: true });
}));

// Удаляется только сама папка: её кейсы и подпапки поднимаются на уровень выше
router.delete("/folders/:id", wrap(async (req, res) => {
  const out = await tx(async (db) => {
    const { rows } = await db.query("SELECT id, parent_id FROM case_folders WHERE project_key=$1 AND id=$2 FOR UPDATE", [req.params.key, num(req.params.id)]);
    const f = rows[0];
    if (!f) return { status: 404, error: "Папка не найдена" };
    try {
      await db.query("UPDATE case_folders SET parent_id=$1 WHERE parent_id=$2", [f.parent_id, f.id]);
    } catch (e) {
      if (isTaken(e)) return { status: 409, error: "Уровнем выше уже есть папка с тем же названием, что и подпапка удаляемой. Переименуйте одну из них" };
      throw e;
    }
    await db.query("UPDATE test_cases SET folder_id=$1 WHERE folder_id=$2", [f.parent_id, f.id]);
    await db.query("DELETE FROM case_folders WHERE id=$1", [f.id]);
    return {};
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  broadcast("folders");
  res.json({ ok: true });
}));

// Переместить несколько кейсов в папку (null — в корень проекта)
router.post("/cases/move", wrap(async (req, res) => {
  const nums = Array.isArray(req.body.nums) ? req.body.nums.map(num).filter(Boolean) : [];
  if (!nums.length) return res.status(400).json({ error: "Выберите хотя бы один тест-кейс" });
  const folder = await folderId(pool, req.params.key, req.body.folder);
  if (folder === undefined) return res.status(400).json({ error: "Папка не найдена" });
  const r = await pool.query(
    "UPDATE test_cases SET folder_id=$1, updated_by=$2, updated_at=now() WHERE project_key=$3 AND num = ANY($4::int[]) AND folder_id IS DISTINCT FROM $1",
    [folder, req.user.id, req.params.key, nums]
  );
  broadcast("cases");
  res.json({ moved: r.rowCount });
}));

module.exports = { router, folderId };
