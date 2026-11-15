// Конфигурации (E-02): справочник групп (браузер, ОС, устройство, стенд) с вариантами, конфигурация у прогона,
// прогон по плану сразу на несколько конфигураций (пачка), сводная матрица «кейс × конфигурация».
// Монтируется на /api/projects/:key
const express = require("express");
const { pool } = require("./db");
const { broadcast } = require("./live");
const { wrap, str, num } = require("./util");

const router = express.Router({ mergeParams: true });
const MAX_COMBOS = 50;

const toGroup = (g) => ({ id: g.id, name: g.name, options: g.options, position: g.position });

router.get("/configs", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM config_groups WHERE project_key=$1 ORDER BY position, id", [req.params.key]);
  res.json({ groups: rows.map(toGroup) });
}));

function readGroup(body, prev = {}) {
  const name = body.name === undefined ? prev.name : str(body.name, 100);
  if (!name) return { error: "Укажите название группы, например «Браузер»" };
  const src = body.options === undefined ? prev.options || [] : body.options;
  const options = [...new Set((Array.isArray(src) ? src : []).map((o) => str(String(o), 100)).filter(Boolean))];
  if (!options.length) return { error: "Добавьте хотя бы один вариант" };
  if (options.length > 50) return { error: "Не больше 50 вариантов в группе" };
  return { g: { name, options, position: body.position === undefined ? prev.position ?? 0 : Number(body.position) || 0 } };
}
const dup = (e) => e.code === "23505";

router.post("/configs", wrap(async (req, res) => {
  const { g, error } = readGroup(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO config_groups(project_key, name, options, position)
       VALUES ($1,$2,$3, COALESCE((SELECT max(position)+1 FROM config_groups WHERE project_key=$1), 0)) RETURNING id`,
      [req.params.key, g.name, JSON.stringify(g.options)]);
    broadcast("runs");
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (dup(e)) return res.status(409).json({ error: "Группа с таким названием уже есть" });
    throw e;
  }
}));

router.patch("/configs/:id(\\d+)", wrap(async (req, res) => {
  const prev = (await pool.query("SELECT * FROM config_groups WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)])).rows[0];
  if (!prev) return res.status(404).json({ error: "Группа не найдена" });
  const { g, error } = readGroup(req.body, prev);
  if (error) return res.status(400).json({ error });
  try {
    await pool.query("UPDATE config_groups SET name=$2, options=$3, position=$4 WHERE id=$1", [prev.id, g.name, JSON.stringify(g.options), g.position]);
  } catch (e) {
    if (dup(e)) return res.status(409).json({ error: "Группа с таким названием уже есть" });
    throw e;
  }
  broadcast("runs");
  res.json({ ok: true });
}));

// удаление группы не трогает прогоны: их конфигурация хранится как текст
router.delete("/configs/:id(\\d+)", wrap(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM config_groups WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: "Группа не найдена" });
  broadcast("runs");
  res.json({ ok: true });
}));

// Конфигурация прогона {"Браузер": "Chrome"}: группы и варианты — из справочника проекта. null — без конфигурации
async function readConfig(db, key, cfg) {
  if (cfg == null || (typeof cfg === "object" && !Object.keys(cfg).length)) return { config: null };
  if (typeof cfg !== "object" || Array.isArray(cfg)) return { error: "config: объект {группа: вариант}" };
  const { rows } = await db.query("SELECT name, options, position, id FROM config_groups WHERE project_key=$1 ORDER BY position, id", [key]);
  const out = {};
  for (const [g, v] of Object.entries(cfg)) {
    const group = rows.find((r) => r.name.toLowerCase() === String(g).toLowerCase());
    if (!group) return { error: `Нет группы конфигураций «${g}»` };
    const opt = group.options.find((o) => o.toLowerCase() === String(v).toLowerCase());
    if (!opt) return { error: `В группе «${group.name}» нет варианта «${v}»` };
    out[group.name] = opt;
  }
  // порядок групп — как в справочнике, чтобы подпись была одинаковой
  const ordered = Object.fromEntries(rows.filter((r) => r.name in out).map((r) => [r.name, out[r.name]]));
  return { config: ordered };
}
// подпись «Chrome, Windows»: группы — в порядке справочника (jsonb сам порядок ключей не хранит)
const label = (cfg, groups) => {
  if (!cfg) return "";
  const order = groups ? groups.map((g) => g.name) : Object.keys(cfg);
  return [...order.filter((g) => g in cfg), ...Object.keys(cfg).filter((g) => !order.includes(g))].map((g) => cfg[g]).join(", ");
};

// Сводная матрица пачки: кейсы × конфигурации, ячейка — результат кейса в прогоне этой конфигурации
router.get("/runs/matrix/:batch([0-9a-f-]{36})", wrap(async (req, res) => {
  const runs = (await pool.query(
    "SELECT id, num, title, config, state FROM test_runs WHERE project_key=$1 AND config_batch=$2 ORDER BY num", [req.params.key, req.params.batch])).rows;
  if (!runs.length) return res.status(404).json({ error: "Пачка прогонов не найдена" });
  const { rows } = await pool.query(
    `SELECT t.num AS run, c.num, c.title, c.priority, rr.result FROM run_results rr JOIN test_runs t ON t.id=rr.run_id JOIN test_cases c ON c.id=rr.case_id
     WHERE t.config_batch=$1 ORDER BY c.num`, [req.params.batch]);
  const cases = new Map();
  for (const r of rows) {
    if (!cases.has(r.num)) cases.set(r.num, { num: r.num, title: r.title, priority: r.priority, results: {} });
    cases.get(r.num).results[r.run] = r.result;
  }
  const groups = (await pool.query("SELECT name FROM config_groups WHERE project_key=$1 ORDER BY position, id", [req.params.key])).rows;
  const totals = Object.fromEntries(runs.map((r) => [r.num, rows.filter((x) => x.run === r.num).reduce((a, x) => ({ ...a, [x.result]: (a[x.result] || 0) + 1 }), {})]));
  res.json({
    batch: req.params.batch,
    runs: runs.map((r) => ({ num: r.num, title: r.title, state: r.state, config: r.config, label: label(r.config, groups), counts: totals[r.num] })),
    cases: [...cases.values()],
  });
}));

module.exports = { router, readConfig, label, MAX_COMBOS };
