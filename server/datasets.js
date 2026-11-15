// Параметры тест-кейсов и наборы данных проекта (D-06).
// Кейс с параметрами проверяется в прогоне несколько раз — по итерации на каждый набор значений. В шагах значения
// подставляются вместо {{имя}}. Наборы задаются в самом кейсе (params) или берутся из общего набора данных проекта (dataset_id).
// Снимок наборов делается при добавлении кейса в прогон (триггер run_results_iterations), поэтому правка набора
// не меняет уже идущие прогоны. Монтируется на /api/projects/:key
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { wrap, str, num } = require("./util");

const router = express.Router({ mergeParams: true });

const MAX_COLUMNS = 20;
const MAX_ROWS = 100;
const COLUMN = /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,63}$/u;

// Таблица наборов: {columns: ["email"], rows: [{name: "Админ", values: {email: "…"}}]} → нормализованная или {error}
function readTable(body) {
  if (!body || typeof body !== "object") return { error: "Ожидается {columns, rows}" };
  const columns = [...new Set((Array.isArray(body.columns) ? body.columns : []).map((c) => str(String(c), 64)).filter(Boolean))];
  if (!columns.length) return { error: "Добавьте хотя бы один параметр" };
  if (columns.length > MAX_COLUMNS) return { error: `Не больше ${MAX_COLUMNS} параметров` };
  const bad = columns.find((c) => !COLUMN.test(c));
  if (bad) return { error: `Имя параметра «${bad}»: буквы, цифры, пробел, точка, дефис, подчёркивание` };
  const src = Array.isArray(body.rows) ? body.rows : [];
  if (!src.length) return { error: "Добавьте хотя бы один набор значений" };
  if (src.length > MAX_ROWS) return { error: `Не больше ${MAX_ROWS} наборов` };
  const rows = src.map((r, i) => {
    const values = {};
    for (const c of columns) values[c] = str(r?.values?.[c] == null ? "" : String(r.values[c]), 1000);
    return { name: str(r?.name, 100) || `Набор ${i + 1}`, values };
  });
  return { table: { columns, rows } };
}

// Параметры кейса из тела запроса: {params} и/или {dataset}. Возвращает {params, datasetId} или {error}; undefined — не меняются
async function readCaseParams(key, body, kind) {
  if (body.params === undefined && body.dataset === undefined) return {};
  const hasParams = body.params != null && !(Array.isArray(body.params?.rows) && !body.params.rows.length && !(body.params.columns || []).length);
  if (kind === "checklist" && (hasParams || body.dataset)) return { error: "У чек-листа нет параметров" };
  if (body.dataset) {
    const { rows } = await pool.query("SELECT id FROM datasets WHERE project_key=$1 AND id=$2", [key, num(body.dataset)]);
    if (!rows[0]) return { error: "Набор данных не найден в этом проекте" };
    return { params: null, datasetId: rows[0].id };
  }
  if (!hasParams) return { params: null, datasetId: null };
  const t = readTable(body.params);
  if (t.error) return { error: `Параметры: ${t.error}` };
  return { params: t.table, datasetId: null };
}

const toDataset = (r) => ({
  id: r.id, num: r.num, name: r.name, columns: r.columns, rows: r.rows, usedIn: r.used ?? undefined,
  updatedBy: r.updated_login || null, updated: r.updated_at.getTime(),
});

router.get("/datasets", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.*, u.login AS updated_login, (SELECT count(*)::int FROM test_cases c WHERE c.dataset_id=d.id) AS used
     FROM datasets d LEFT JOIN users u ON u.id=d.updated_by WHERE d.project_key=$1 ORDER BY lower(d.name)`, [req.params.key]);
  res.json({ items: rows.map(toDataset) });
}));

router.get("/datasets/:num(\\d+)", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.*, u.login AS updated_login FROM datasets d LEFT JOIN users u ON u.id=d.updated_by WHERE d.project_key=$1 AND d.num=$2`,
    [req.params.key, num(req.params.num)]);
  if (!rows[0]) return res.status(404).json({ error: "Набор данных не найден" });
  const used = await pool.query("SELECT num, title FROM test_cases WHERE dataset_id=$1 ORDER BY num", [rows[0].id]);
  res.json({ ...toDataset(rows[0]), cases: used.rows });
}));

const dup = (e) => e.code === "23505" && /datasets_name/.test(e.constraint || "");

router.post("/datasets", wrap(async (req, res) => {
  const name = str(req.body.name, 200);
  if (!name) return res.status(400).json({ error: "Укажите название набора" });
  const t = readTable(req.body);
  if (t.error) return res.status(400).json({ error: t.error });
  try {
    const out = await tx(async (db) => {
      const seq = await db.query("UPDATE projects SET dataset_seq=dataset_seq+1 WHERE key=$1 RETURNING dataset_seq", [req.params.key]);
      if (!seq.rows[0]) return null;
      const n = seq.rows[0].dataset_seq;
      const { rows } = await db.query(
        "INSERT INTO datasets(project_key, num, name, columns, rows, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id",
        [req.params.key, n, name, JSON.stringify(t.table.columns), JSON.stringify(t.table.rows), req.user.id]);
      return { id: rows[0].id, num: n };
    });
    if (!out) return res.status(404).json({ error: "Проект не найден" });
    broadcast("cases");
    res.status(201).json(out);
  } catch (e) {
    if (dup(e)) return res.status(409).json({ error: "Набор с таким названием уже есть" });
    throw e;
  }
}));

router.patch("/datasets/:num(\\d+)", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM datasets WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  const d = rows[0];
  if (!d) return res.status(404).json({ error: "Набор данных не найден" });
  const name = req.body.name === undefined ? d.name : str(req.body.name, 200);
  if (!name) return res.status(400).json({ error: "Укажите название набора" });
  const t = req.body.columns === undefined && req.body.rows === undefined ? { table: { columns: d.columns, rows: d.rows } }
    : readTable({ columns: req.body.columns ?? d.columns, rows: req.body.rows ?? d.rows });
  if (t.error) return res.status(400).json({ error: t.error });
  try {
    await pool.query("UPDATE datasets SET name=$2, columns=$3, rows=$4, updated_by=$5, updated_at=now() WHERE id=$1",
      [d.id, name, JSON.stringify(t.table.columns), JSON.stringify(t.table.rows), req.user.id]);
  } catch (e) {
    if (dup(e)) return res.status(409).json({ error: "Набор с таким названием уже есть" });
    throw e;
  }
  broadcast("cases");
  res.json({ ok: true });
}));

// Удалить набор: кейсы, которые его используют, получают копию таблицы в свои параметры (проверки не теряются)
router.delete("/datasets/:num(\\d+)", wrap(async (req, res) => {
  const out = await tx(async (db) => {
    const { rows } = await db.query("SELECT * FROM datasets WHERE project_key=$1 AND num=$2 FOR UPDATE", [req.params.key, num(req.params.num)]);
    const d = rows[0];
    if (!d) return null;
    const copied = await db.query("UPDATE test_cases SET params=$2, dataset_id=NULL WHERE dataset_id=$1",
      [d.id, JSON.stringify({ columns: d.columns, rows: d.rows })]);
    await db.query("DELETE FROM datasets WHERE id=$1", [d.id]);
    return { copiedTo: copied.rowCount };
  });
  if (!out) return res.status(404).json({ error: "Набор данных не найден" });
  broadcast("cases");
  res.json({ ok: true, ...out });
}));

// Итог по итерациям: упала хоть одна — failed, затем blocked; есть непроверенные — untested; все пропущены — skipped
module.exports = { router, readTable, readCaseParams, MAX_ROWS };
