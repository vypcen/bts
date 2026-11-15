// Модель тест-кейса и бага: структурные шаги (D-01), теги (D-03) и пользовательские поля (D-04).
const express = require("express");
const { pool } = require("./db");
const { broadcast } = require("./live");
const access = require("./access");
const { wrap, str, num } = require("./util");

// ---------- шаги ----------
const MAX_STEPS = 200;

// [{action, expected, data}] из того, что прислал клиент; пустые шаги отбрасываются.
// {shared: id} — ссылка на общие шаги (server/shared.js), сохраняется как есть. Раскрытые шаги блока
// (с полем shared и без признака ссылки) приходить не должны — их отбрасываем, чтобы не задвоить блок
function normalizeSteps(list) {
  if (!Array.isArray(list)) return null;
  return list
    .map((s) => (typeof s === "string" ? { action: s } : s && typeof s === "object" ? s : {}))
    .filter((s) => !(s.shared && (s.action !== undefined || s.sharedTitle !== undefined) && !s.ref))
    .map((s) => (s.shared && Number.isInteger(Number(s.shared)) && Number(s.shared) > 0
      ? { shared: Number(s.shared) }
      : { action: str(s.action, 2000), expected: str(s.expected, 2000), data: str(s.data, 2000) }))
    .filter((s) => s.shared || s.action || s.expected)
    .slice(0, MAX_STEPS);
}

// Текст шагов (по строке на шаг) → структура. Если действия не изменились, ожидаемые результаты шагов сохраняются
function stepsFromText(text, prev = []) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, MAX_STEPS);
  if (prev.length === lines.length && prev.every((s, i) => s.action === lines[i])) return prev;
  return lines.map((action, i) => ({ action, expected: prev[i]?.action === action ? prev[i].expected : "", data: prev[i]?.action === action ? prev[i].data : "" }));
}

const stepsText = (list) => list.map((s) => (s.shared ? "[общие шаги]" : s.action.replace(/\s*\n\s*/g, " "))).join("\n");

// ---------- теги ----------
const MAX_TAGS = 20;
function normalizeTags(v) {
  if (v === undefined || v === null) return null;
  const list = (Array.isArray(v) ? v : String(v).split(","))
    .map((t) => String(t).trim().replace(/\s+/g, " ").slice(0, 50))
    .filter(Boolean);
  const seen = new Set();
  return list.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, MAX_TAGS);
}

// ---------- пользовательские поля ----------
const TYPES = ["text", "textarea", "number", "date", "select", "multiselect", "user", "url", "checkbox"];
const ENTITIES = ["case", "bug", "run"];

const toField = (f) => ({ id: f.id, entity: f.entity, name: f.name, type: f.type, options: f.options, required: f.required, position: f.position });

async function fieldsOf(db, key, entity) {
  const { rows } = await db.query("SELECT * FROM custom_fields WHERE project_key=$1 AND entity=$2 ORDER BY position, id", [key, entity]);
  return rows.map(toField);
}

// Проверить и привести значения. values — {id: значение}; prev — текущие значения (при правке приходят не все поля).
// Возвращает {fields} или {error}
async function readFields(db, key, entity, values, prev = {}, { members } = {}) {
  const defs = await fieldsOf(db, key, entity);
  if (!defs.length) return { fields: prev || {} };
  const out = { ...(prev || {}) };
  if (values !== undefined && (values === null || typeof values !== "object" || Array.isArray(values))) return { error: "fields: ожидается объект {id поля: значение}" };
  for (const d of defs) {
    if (!values || !(String(d.id) in values)) continue;
    let v = values[String(d.id)];
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) {
      delete out[d.id];
      continue;
    }
    switch (d.type) {
      case "text":
      case "url":
        v = str(v, d.type === "url" ? 2000 : 500);
        if (d.type === "url" && v && !/^https?:\/\//i.test(v)) return { error: `«${d.name}»: нужна ссылка http(s)://…` };
        break;
      case "textarea":
        v = str(v, 10000);
        break;
      case "number":
        v = Number(v);
        if (!Number.isFinite(v)) return { error: `«${d.name}»: нужно число` };
        break;
      case "date":
        v = String(v).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) return { error: `«${d.name}»: дата в формате ГГГГ-ММ-ДД` };
        break;
      case "checkbox":
        v = v === true || v === "true" || v === 1 || v === "1" || v === "да";
        break;
      case "select":
        v = String(v);
        if (!d.options.includes(v)) return { error: `«${d.name}»: нет варианта «${v}»` };
        break;
      case "multiselect":
        v = (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);
        for (const x of v) if (!d.options.includes(x)) return { error: `«${d.name}»: нет варианта «${x}»` };
        break;
      case "user":
        v = str(v, 64).toLowerCase();
        if (members && !members.has(v)) return { error: `«${d.name}»: пользователь ${v} не участник проекта` };
        break;
    }
    if (v === "" || (Array.isArray(v) && !v.length)) delete out[d.id];
    else out[d.id] = v;
  }
  for (const d of defs) {
    if (d.required && (out[d.id] === undefined || out[d.id] === "") && d.type !== "checkbox") return { error: `Заполните поле «${d.name}»` };
  }
  return { fields: out };
}

// ---------- настройка полей: /api/projects/:key/fields ----------
const router = express.Router({ mergeParams: true });

router.get("/fields", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM custom_fields WHERE project_key=$1 ORDER BY entity, position, id", [req.params.key]);
  res.json({ fields: rows.map(toField), types: TYPES });
}));

function readDef(body, partial) {
  const d = {};
  if (!partial || body.name !== undefined) d.name = str(body.name, 100);
  if (!partial || body.type !== undefined) d.type = str(body.type, 20);
  if (!partial || body.entity !== undefined) d.entity = str(body.entity, 10);
  if (body.options !== undefined) d.options = (Array.isArray(body.options) ? body.options : []).map((o) => str(o, 100)).filter(Boolean).slice(0, 100);
  if (body.required !== undefined) d.required = body.required === true;
  if (body.position !== undefined) d.position = num(body.position) || 0;
  if (d.name !== undefined && !d.name) return { error: "Укажите название поля" };
  if (d.type !== undefined && !TYPES.includes(d.type)) return { error: `Тип поля: ${TYPES.join(", ")}` };
  if (d.entity !== undefined && !ENTITIES.includes(d.entity)) return { error: "Поле для: case, bug или run" };
  if (d.options) d.options = [...new Set(d.options)];
  return { d };
}

router.post("/fields", wrap(async (req, res) => {
  if (!access.can(req.projectRole, "settings")) return res.status(403).json({ error: access.READ_ONLY });
  const { d, error } = readDef(req.body, false);
  if (error) return res.status(400).json({ error });
  if ((d.type === "select" || d.type === "multiselect") && !d.options?.length) return res.status(400).json({ error: "Добавьте варианты для списка" });
  const { rows } = await pool.query(
    `INSERT INTO custom_fields(project_key, entity, name, type, options, required, position)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, (SELECT COALESCE(max(position), 0) + 1 FROM custom_fields WHERE project_key=$1 AND entity=$2)))
     ON CONFLICT (project_key, entity, name) DO NOTHING RETURNING id`,
    [req.params.key, d.entity, d.name, d.type, JSON.stringify(d.options || []), d.required || false, req.body.position === undefined ? null : d.position]
  );
  if (!rows[0]) return res.status(409).json({ error: "Поле с таким названием уже есть" });
  broadcast("fields");
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/fields/:id", wrap(async (req, res) => {
  if (!access.can(req.projectRole, "settings")) return res.status(403).json({ error: access.READ_ONLY });
  const { d, error } = readDef(req.body, true);
  if (error) return res.status(400).json({ error });
  delete d.entity; // поле не переносится между кейсами и багами
  delete d.type; // тип не меняется: старые значения стали бы неверными
  const sets = Object.keys(d).map((k, i) => `${k}=$${i + 3}`);
  if (!sets.length) return res.json({ ok: true });
  const r = await pool.query(`UPDATE custom_fields SET ${sets.join(", ")} WHERE project_key=$1 AND id=$2`,
    [req.params.key, num(req.params.id), ...Object.values(d).map((v) => (Array.isArray(v) ? JSON.stringify(v) : v))]);
  if (!r.rowCount) return res.status(404).json({ error: "Поле не найдено" });
  broadcast("fields");
  res.json({ ok: true });
}));

router.delete("/fields/:id", wrap(async (req, res) => {
  if (!access.can(req.projectRole, "settings")) return res.status(403).json({ error: access.READ_ONLY });
  const r = await pool.query("DELETE FROM custom_fields WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Поле не найдено" });
  broadcast("fields");
  res.json({ ok: true });
}));

module.exports = { normalizeSteps, stepsFromText, stepsText, normalizeTags, readFields, fieldsOf, router, TYPES, MAX_STEPS };
