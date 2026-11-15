// Шаблоны тест-кейсов и багов. Монтируется на /api/projects/:key.
// Шаблон — заготовка формы: при создании кейса или бага выбранный шаблон заполняет пустые поля,
// шаблон «по умолчанию» подставляется в новую форму сам. Создают и меняют шаблоны роли с правом
// менять кейсы или настройки проекта (server/roles.js)
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { normalizeSteps, normalizeTags } = require("./casemodel");
const { wrap, str, num } = require("./util");

const KINDS = ["case", "bug"];
const PRIORITIES = ["critical", "high", "medium", "low"];
const STATUSES = ["draft", "ready", "deprecated"];
const SEVERITIES = ["blocker", "critical", "major", "minor"];

// Что сохраняется в шаблоне: только известные поля, с теми же ограничениями, что у кейса или бага
function readData(kind, d = {}) {
  const out = {};
  const s = (k, max) => {
    if (d[k] !== undefined && d[k] !== null && String(d[k]).trim()) out[k] = str(String(d[k]), max);
  };
  if (kind === "case") {
    if (PRIORITIES.includes(d.priority)) out.priority = d.priority;
    if (STATUSES.includes(d.status)) out.status = d.status;
    s("pre", 10000);
    s("expected", 10000);
    s("steps", 20000); // пункты чек-листа
    const steps = normalizeSteps(d.stepList || []);
    if (steps.length) out.stepList = steps;
  } else {
    if (SEVERITIES.includes(d.severity)) out.severity = d.severity;
    for (const k of ["env", "steps", "actual", "expected"]) s(k, 10000);
  }
  const tags = normalizeTags(d.tags || []) || [];
  if (tags.length) out.tags = tags;
  if (d.fields && typeof d.fields === "object" && !Array.isArray(d.fields)) {
    const f = Object.fromEntries(Object.entries(d.fields).filter(([k, v]) => /^\d+$/.test(k) && v !== null && v !== "").slice(0, 50));
    if (Object.keys(f).length) out.fields = f;
  }
  return out;
}

const toTemplate = (t) => ({ id: t.id, kind: t.kind, name: t.name, data: t.data, isDefault: t.is_default, createdBy: t.login || null, updated: t.updated_at.getTime() });

const router = express.Router({ mergeParams: true });

router.get("/templates", wrap(async (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const { rows } = await pool.query(
    `SELECT t.*, u.login FROM templates t LEFT JOIN users u ON u.id=t.created_by
     WHERE t.project_key=$1 AND ($2::text IS NULL OR t.kind=$2) ORDER BY t.kind, t.is_default DESC, lower(t.name)`,
    [req.params.key, kind]
  );
  res.json({ templates: rows.map(toTemplate) });
}));

async function save(req, res, id) {
  const key = req.params.key;
  const cur = id ? (await pool.query("SELECT * FROM templates WHERE project_key=$1 AND id=$2", [key, id])).rows[0] : null;
  if (id && !cur) return res.status(404).json({ error: "Шаблон не найден" });
  const kind = cur ? cur.kind : req.body.kind;
  if (!KINDS.includes(kind)) return res.status(400).json({ error: "kind: case или bug" });
  const name = req.body.name !== undefined ? str(req.body.name, 100) : cur?.name;
  if (!name) return res.status(400).json({ error: "Укажите название шаблона" });
  const data = req.body.data !== undefined ? readData(kind, req.body.data) : cur.data;
  const isDefault = req.body.isDefault !== undefined ? req.body.isDefault === true : cur ? cur.is_default : false;
  try {
    const out = await tx(async (db) => {
      if (isDefault) await db.query("UPDATE templates SET is_default=false WHERE project_key=$1 AND kind=$2 AND is_default AND id IS DISTINCT FROM $3", [key, kind, id || null]);
      if (cur) {
        await db.query("UPDATE templates SET name=$2, data=$3, is_default=$4, updated_at=now() WHERE id=$1", [id, name, data, isDefault]);
        return id;
      }
      const r = await db.query("INSERT INTO templates(project_key, kind, name, data, is_default, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [key, kind, name, data, isDefault, req.user.id]);
      return r.rows[0].id;
    });
    broadcast("templates");
    res.status(cur ? 200 : 201).json({ id: out });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Шаблон с таким названием уже есть" });
    throw e;
  }
}

router.post("/templates", wrap((req, res) => save(req, res, null)));
router.patch("/templates/:id(\\d+)", wrap((req, res) => save(req, res, num(req.params.id))));
router.delete("/templates/:id(\\d+)", wrap(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM templates WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: "Шаблон не найден" });
  broadcast("templates");
  res.json({ ok: true });
}));

module.exports = { router, readData };
