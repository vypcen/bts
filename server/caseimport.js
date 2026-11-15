// Импорт тест-кейсов из Excel (xlsx) и CSV с сопоставлением колонок (M-06): выгрузки Zephyr Scale, Xray, TestRail,
// самодельные таблицы. Шаг 1 — разбор файла: листы, заголовки, первые строки и предложенное сопоставление.
// Шаг 2 — тот же файл и сопоставление: dryRun показывает сводку и ошибки, без него — импорт одной транзакцией.
// Строки-продолжения (пустое название, но есть шаг) приклеиваются к кейсу выше — так шаги лежат в Xray и Zephyr.
// Монтируется на /api/projects/:key
const express = require("express");
const ExcelJS = require("exceljs");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const caseio = require("./caseio");
const { wrap, num } = require("./util");

const router = express.Router({ mergeParams: true });
const MAX_BYTES = 15 * 1024 * 1024;
const SAMPLE = 8;
// куда можно сопоставить колонку (порядок — как в мастере)
const TARGETS = caseio.COLUMNS.map((c) => ({ key: c.key, label: c.header }));

// текст ячейки Excel: формула → результат, дата → ДД.ММ.ГГГГ, форматированный текст → текст
function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toLocaleDateString("ru-RU", { timeZone: "UTC" });
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if ("result" in v) return cellText(v.result);
    if ("text" in v) return String(v.text);
    if ("error" in v) return "";
    if ("hyperlink" in v) return String(v.text || v.hyperlink);
    return "";
  }
  return String(v);
}

// файл → листы [{name, rows: string[][]}]
async function readTable(body) {
  if (typeof body.file !== "string" || !body.file) throw Object.assign(new Error("Передайте файл в поле file (base64)"), { status: 400 });
  const buf = Buffer.from(body.file, "base64");
  if (buf.length > MAX_BYTES) throw Object.assign(new Error("Файл больше 15 МБ — разбейте его"), { status: 413 });
  const name = String(body.name || "").toLowerCase();
  const isXlsx = name.endsWith(".xlsx") || name.endsWith(".xlsm") || (buf[0] === 0x50 && buf[1] === 0x4b);
  if (!isXlsx) {
    const text = buf.toString("utf8").replace(/^\uFEFF/, "");
    return [{ name: "CSV", rows: caseio.parseCsv(text).map((r) => r.cells) }];
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch {
    throw Object.assign(new Error("Не удалось прочитать файл Excel. Сохраните его как .xlsx (старый .xls не поддерживается) или CSV"), { status: 400 });
  }
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (n > caseio.MAX_ROWS * 4 + 1) return;
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows[n - 1] = vals.map(cellText);
    });
    const width = Math.max(0, ...rows.filter(Boolean).map((r) => r.length));
    return { name: ws.name, rows: Array.from(rows, (r) => { const x = r || []; while (x.length < width) x.push(""); return x; }) };
  });
}

// предложить сопоставление по заголовкам: колонки TestBall (и их синонимы) и пользовательские поля по названию
function suggest(header, fields) {
  const h = header.map((x) => String(x).trim().toLowerCase().replace(/\s*\*$/, ""));
  const map = {};
  for (const c of caseio.COLUMNS) {
    const i = h.findIndex((x, k) => c.aliases.includes(x) && !Object.values(map).includes(k));
    if (i >= 0) map[c.key] = i;
  }
  const fieldMap = {};
  for (const f of fields) {
    const i = h.findIndex((x, k) => x === f.name.toLowerCase() && !Object.values(map).includes(k));
    if (i >= 0) fieldMap[f.id] = i;
  }
  return { map, fields: fieldMap };
}

// Шаг 1: {file, name} → листы с заголовками, примерами и предложенным сопоставлением
router.post("/cases/import/table", wrap(async (req, res) => {
  let sheets;
  try { sheets = await readTable(req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const fields = (await pool.query("SELECT id, name, type, options FROM custom_fields WHERE project_key=$1 AND entity='case' ORDER BY position, id", [req.params.key])).rows;
  res.json({
    targets: TARGETS,
    fields: fields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
    sheets: sheets.map((s) => {
      // строка заголовков — первая непустая
      const headerRow = Math.max(0, s.rows.findIndex((r) => r.some((x) => String(x).trim())));
      const header = s.rows[headerRow] || [];
      return { name: s.name, headerRow, header, sample: s.rows.slice(headerRow + 1, headerRow + 1 + SAMPLE), total: Math.max(0, s.rows.length - headerRow - 1), suggest: suggest(header, fields) };
    }),
  });
}));

// строки листа → записи {cells, line}; продолжения (без названия, но с шагом) дописываются к предыдущей записи
function records(rows, headerRow, map) {
  const out = [];
  const multi = ["steps", "stepExpected", "stepData"].map((k) => map[k]).filter((i) => i !== undefined);
  for (let r = headerRow + 1; r < rows.length; r++) {
    const cells = (rows[r] || []).map((x) => String(x ?? ""));
    if (!cells.some((x) => x.trim())) continue;
    const title = map.title !== undefined ? cells[map.title].trim() : "";
    const prev = out[out.length - 1];
    if (!title && prev && multi.some((i) => cells[i]?.trim())) {
      // каждая колонка шагов дописывается своей строкой, чтобы действия, данные и ожидаемое остались напротив друг друга
      for (const i of multi) prev.cells[i] = `${prev.cells[i] ?? ""}\n${(cells[i] || "").replace(/\n/g, " ")}`;
      continue;
    }
    out.push({ cells, line: r + 1 });
  }
  return out;
}

// Шаг 2: {file, name, sheet, headerRow, map: {title: 0, steps: 3, ...}, fields: {id поля: колонка}, dryRun}
router.post("/cases/import/mapped", wrap(async (req, res) => {
  const key = req.params.key;
  let sheets;
  try { sheets = await readTable(req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const sheet = sheets[num(req.body.sheet) || 0] || sheets[0];
  if (!sheet) return res.status(400).json({ error: "В файле нет листов" });
  const width = Math.max(0, ...sheet.rows.map((r) => (r || []).length));
  const col = {};
  for (const [k, v] of Object.entries(req.body.map || {})) {
    if (!TARGETS.some((t) => t.key === k) || v === null || v === undefined || v === "") continue;
    const i = Number(v);
    if (!Number.isInteger(i) || i < 0 || i >= width) return res.status(400).json({ error: `Колонка для «${k}» вне таблицы` });
    col[k] = i;
  }
  if (col.title === undefined) return res.status(400).json({ error: "Сопоставьте колонку с названием кейса" });
  const fieldCols = {};
  for (const [id, v] of Object.entries(req.body.fields || {})) if (Number.isInteger(Number(v)) && v !== null && v !== "") fieldCols[id] = Number(v);
  const headerRow = Math.max(0, num(req.body.headerRow) || 0);
  const data = records(sheet.rows, headerRow, col);
  if (!data.length) return res.status(400).json({ error: "Под заголовком нет строк с кейсами" });
  if (req.body.dryRun) {
    const p = await caseio.planData(pool, key, data, col, fieldCols);
    return res.json({ summary: p.summary || null, errors: p.errors.slice(0, 100), errorCount: p.errors.length, preview: (p.items || []).slice(0, 5).map((i) => ({ title: i.title, folder: i.folder, steps: (i.stepList || []).length, update: i.num !== undefined })) });
  }
  const out = await tx(async (db) => {
    await db.query("SELECT 1 FROM projects WHERE key=$1 FOR UPDATE", [key]);
    const p = await caseio.planData(db, key, data, col, fieldCols);
    if (p.errors.length) return p;
    await caseio.apply(db, key, req.user.id, p);
    return p;
  });
  if (out.errors.length) return res.status(400).json({ error: "В файле есть ошибки, ничего не импортировано", errors: out.errors.slice(0, 100), errorCount: out.errors.length });
  broadcast("cases");
  broadcast("folders");
  res.json({ summary: out.summary });
}));

module.exports = { router, readTable, records, suggest };
