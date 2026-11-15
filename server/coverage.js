// H-04: матрица покрытия «требования × тест-кейсы × результаты» для аудита и приёмки у заказчика.
//   GET /api/projects/:key/requirements/matrix?release=N|run=N[&obsolete=1]          — данные для экрана
//   GET /api/projects/:key/requirements/matrix/export?format=xlsx|pdf|csv&…           — выгрузка
// Срез результатов:
//   по умолчанию — последний результат каждого кейса в проекте;
//   release=N   — последний результат кейса среди прогонов релиза (и его спринтов): «что проверено в релизе 2.3»;
//   run=N       — результат кейса в этом прогоне.
// Кейс, не попавший в выбранный релиз или прогон, отмечается «вне среза» и для покрытия считается непроверенным.
const express = require("express");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { pool } = require("./db");
const { coverage, COVERAGE_LABELS } = require("./requirements");
const { csvRow } = require("./csvutil");
const rep = require("./reports");
const { wrap, num, HttpError } = require("./util");

const STATUS_LABELS = { draft: "Черновик", approved: "Согласовано", implemented: "Реализовано", obsolete: "Устарело" };
const COVERAGE_ORDER = ["passed", "partial", "failed", "untested", "none"];
const COVERAGE_COLOR = { passed: "#2e7d32", partial: "#1565c0", failed: "#c62828", untested: "#757575", none: "#b26a00" };
const SHORT = { passed: "✓", failed: "✗", blocked: "Б", skipped: "П", untested: "·" };
const OPEN_BUGS = "b.status NOT IN ('closed','rejected','duplicate','verified')";

async function scopeOf(key, q) {
  if (q.run) {
    const { rows: [r] } = await pool.query("SELECT id, num, title, build FROM test_runs WHERE project_key=$1 AND num=$2", [key, num(q.run)]);
    if (!r) throw new HttpError(404, "Прогон не найден");
    return { kind: "run", num: r.num, label: `Прогон ${key}-R${r.num}: ${r.title}${r.build ? ` (сборка ${r.build})` : ""}`, runIds: [r.id] };
  }
  if (q.release) {
    const { rows: [r] } = await pool.query("SELECT id, num, name FROM releases WHERE project_key=$1 AND num=$2", [key, num(q.release)]);
    if (!r) throw new HttpError(404, "Релиз не найден");
    const { rows } = await pool.query(
      "SELECT t.id FROM test_runs t JOIN releases rl ON rl.id=t.release_id WHERE t.project_key=$1 AND (rl.id=$2 OR rl.parent_id=$2)",
      [key, r.id]
    );
    return { kind: "release", num: r.num, label: `Релиз ${r.name}`, runIds: rows.map((x) => x.id) };
  }
  return { kind: "latest", label: "Последние результаты кейсов", runIds: null };
}

async function matrixData(key, q = {}) {
  const scope = await scopeOf(key, q);
  const { rows: [project] } = await pool.query("SELECT name FROM projects WHERE key=$1", [key]);
  const { rows: reqs } = await pool.query(
    `SELECT id, num, title, ext_ref, status, priority FROM requirements WHERE project_key=$1 ${q.obsolete ? "" : "AND status <> 'obsolete'"} ORDER BY num`,
    [key]
  );
  const { rows: links } = await pool.query(
    `SELECT rc.requirement_id, c.id, c.num, c.title, c.priority FROM requirement_cases rc
     JOIN requirements r ON r.id=rc.requirement_id JOIN test_cases c ON c.id=rc.case_id
     WHERE r.project_key=$1 ORDER BY c.num`,
    [key]
  );
  const caseIds = [...new Set(links.map((l) => l.id))];
  // результат каждого кейса в срезе: {result, run, at, by}; нет записи — кейс вне среза
  const results = new Map();
  if (caseIds.length) {
    let rows;
    if (scope.runIds === null) {
      ({ rows } = await pool.query(
        `SELECT c.id AS case_id, c.last_result AS result, t.num AS run_num, rr.executed_at, u.name AS executor
         FROM test_cases c LEFT JOIN run_results rr ON rr.id=c.last_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
         LEFT JOIN users u ON u.id=rr.executed_by WHERE c.id = ANY($1::int[])`,
        [caseIds]
      ));
    } else {
      // в срезе: выполненный результат новее невыполненного; кейс в прогоне без результата — «не проверен»
      ({ rows } = await pool.query(
        `SELECT DISTINCT ON (rr.case_id) rr.case_id, rr.result, t.num AS run_num, rr.executed_at, u.name AS executor
         FROM run_results rr JOIN test_runs t ON t.id=rr.run_id LEFT JOIN users u ON u.id=rr.executed_by
         WHERE rr.case_id = ANY($1::int[]) AND rr.run_id = ANY($2::int[])
         ORDER BY rr.case_id, (rr.result <> 'untested' AND rr.executed_at IS NOT NULL) DESC, rr.executed_at DESC NULLS LAST, rr.id DESC`,
        [caseIds, scope.runIds]
      ));
    }
    for (const r of rows) results.set(r.case_id, { result: r.result || "untested", run: r.run_num, at: r.executed_at, by: r.executor });
  }
  const { rows: bugRows } = caseIds.length
    ? await pool.query(`SELECT b.case_id, b.num, b.title, b.severity FROM bugs b WHERE b.case_id = ANY($1::int[]) AND ${OPEN_BUGS} ORDER BY b.num`, [caseIds])
    : { rows: [] };
  const bugsOf = new Map();
  for (const b of bugRows) bugsOf.set(b.case_id, [...(bugsOf.get(b.case_id) || []), { num: b.num, title: b.title, severity: b.severity }]);

  const cases = new Map();
  for (const l of links) {
    if (!cases.has(l.id)) {
      const r = results.get(l.id);
      cases.set(l.id, {
        num: l.num, title: l.title, priority: l.priority,
        inScope: !!r, result: r ? r.result : "untested", run: r?.run ?? null, executed: r?.at ? +new Date(r.at) : null, executor: r?.by || null,
        bugs: bugsOf.get(l.id) || [],
      });
    }
  }
  const byReq = new Map();
  for (const l of links) byReq.set(l.requirement_id, [...(byReq.get(l.requirement_id) || []), l.id]);
  const requirements = reqs.map((r) => {
    const ids = byReq.get(r.id) || [];
    const list = ids.map((id) => cases.get(id));
    return {
      num: r.num, title: r.title, extRef: r.ext_ref, status: r.status, priority: r.priority,
      cases: list.map((c) => c.num),
      coverage: coverage(list.map((c) => c.result)),
      openBugs: list.reduce((n, c) => n + c.bugs.length, 0),
    };
  });
  const summary = Object.fromEntries(COVERAGE_ORDER.map((k) => [k, 0]));
  for (const r of requirements) summary[r.coverage]++;
  const total = requirements.length;
  // кейсы проекта без единого требования — «непрослеживаемые» тесты
  const { rows: [orphans] } = await pool.query(
    `SELECT count(*)::int AS n FROM test_cases c WHERE c.project_key=$1 AND c.status <> 'deprecated'
       AND NOT EXISTS (SELECT 1 FROM requirement_cases rc WHERE rc.case_id=c.id)`,
    [key]
  ).catch(() => ({ rows: [{ n: null }] }));
  return {
    key, projectName: project?.name || key,
    scope: { kind: scope.kind, num: scope.num ?? null, label: scope.label },
    requirements,
    cases: [...cases.values()].sort((a, b) => a.num - b.num),
    summary: {
      ...summary, total,
      coveredPct: total ? Math.round(((total - summary.none) / total) * 100) : 0,
      passedPct: total ? Math.round((summary.passed / total) * 100) : 0,
      casesLinked: cases.size, casesUnlinked: orphans.n,
    },
  };
}

// ---------- выгрузки ----------
const reqId = (d, r) => `${d.key}-REQ${r.num}`;
const caseOf = (d) => new Map(d.cases.map((c) => [c.num, c]));
const resultText = (c) => (c.inScope ? rep.RESULT[c.result] || c.result : "вне среза");
// имя файла латиницей: кириллицу в filename* понимают не все браузеры и почтовые клиенты
const fileName = (d) => `${d.key}-coverage-matrix${d.scope.kind === "release" ? `-release-${d.scope.num}` : d.scope.kind === "run" ? `-R${d.scope.num}` : ""}`;
const disposition = (d, ext) => `attachment; filename="${fileName(d)}.${ext}"`;

function detailRows(d) {
  const cm = caseOf(d);
  const out = [];
  for (const r of d.requirements) {
    const base = [reqId(d, r), r.title, r.extRef, STATUS_LABELS[r.status], COVERAGE_LABELS[r.coverage]];
    if (!r.cases.length) out.push({ r, cells: [...base, "", "", "", "", "", "", ""] });
    for (const n of r.cases) {
      const c = cm.get(n);
      out.push({
        r, c,
        cells: [...base, `${d.key}-${c.num}`, c.title, resultText(c), c.run ? `${d.key}-R${c.run}` : "", c.executed ? rep.fmtDate(c.executed) : "", c.executor || "", c.bugs.map((b) => `${d.key}-B${b.num}`).join(", ")],
      });
    }
  }
  return out;
}
const DETAIL_HEAD = ["Требование", "Название", "Внешний ключ", "Статус", "Покрытие", "Тест-кейс", "Название кейса", "Результат", "Прогон", "Когда", "Проверил", "Открытые баги"];

function csv(d, res) {
  let out = "﻿" + csvRow(DETAIL_HEAD);
  for (const row of detailRows(d)) out += csvRow(row.cells);
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": disposition(d, "csv") });
  res.send(out);
}

async function xlsx(d, res) {
  const argb = (hex) => "FF" + hex.slice(1);
  const wb = new ExcelJS.Workbook();
  wb.creator = rep.COMPANY || "TestBall";
  const sum = wb.addWorksheet("Сводка");
  sum.columns = [{ width: 34 }, { width: 60 }];
  sum.addRow([`Матрица покрытия требований: ${d.projectName}`]).font = { bold: true, size: 14 };
  if (rep.COMPANY) sum.addRow(["Компания", rep.COMPANY]);
  sum.addRow(["Срез", d.scope.label]);
  sum.addRow(["Сформирована", rep.fmtDate(new Date())]);
  sum.addRow([]);
  sum.addRow(["Требований", d.summary.total]);
  sum.addRow(["Покрыто тестами, %", d.summary.coveredPct]);
  sum.addRow(["Пройдено полностью, %", d.summary.passedPct]);
  for (const k of COVERAGE_ORDER) sum.addRow([COVERAGE_LABELS[k], d.summary[k]]).getCell(1).font = { color: { argb: argb(COVERAGE_COLOR[k]) } };
  sum.addRow(["Кейсов связано с требованиями", d.summary.casesLinked]);
  if (d.summary.casesUnlinked !== null) sum.addRow(["Кейсов без требований", d.summary.casesUnlinked]);

  // сетка: строки — требования, столбцы — кейсы; ячейка — результат кейса в срезе
  const grid = wb.addWorksheet("Матрица", { views: [{ state: "frozen", xSplit: 3, ySplit: 1 }] });
  const head = ["Требование", "Название", "Покрытие", ...d.cases.map((c) => `${d.key}-${c.num}`)];
  const h = grid.addRow(head);
  h.font = { bold: true };
  h.alignment = { textRotation: 90, vertical: "bottom", horizontal: "center" };
  for (let i = 1; i <= 3; i++) h.getCell(i).alignment = { vertical: "bottom" };
  grid.getColumn(1).width = 14;
  grid.getColumn(2).width = 50;
  grid.getColumn(3).width = 16;
  d.cases.forEach((c, i) => {
    grid.getColumn(4 + i).width = 4.5;
    h.getCell(4 + i).note = c.title;
  });
  const cm = caseOf(d);
  for (const r of d.requirements) {
    const row = grid.addRow([reqId(d, r), r.title, COVERAGE_LABELS[r.coverage], ...d.cases.map((c) => (r.cases.includes(c.num) ? (c.inScope ? SHORT[c.result] : "—") : ""))]);
    row.getCell(3).font = { color: { argb: argb(COVERAGE_COLOR[r.coverage]) }, bold: r.coverage === "failed" };
    for (const n of r.cases) {
      const c = cm.get(n);
      const cell = row.getCell(4 + d.cases.indexOf(c));
      cell.alignment = { horizontal: "center" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.inScope ? argb(rep.RESULT_COLOR[c.result]) : "FFEEEEEE" } };
      cell.font = { color: { argb: c.inScope && c.result !== "untested" ? "FFFFFFFF" : "FF555555" }, bold: true };
    }
  }
  grid.addRow([]);
  grid.addRow(["", "Обозначения: ✓ пройден, ✗ упал, Б заблокирован, П пропущен, · не проверен, — вне среза, пусто — кейс не связан с требованием"]).font = { italic: true, color: { argb: "FF666666" } };

  const det = wb.addWorksheet("Детально", { views: [{ state: "frozen", ySplit: 1 }] });
  det.columns = DETAIL_HEAD.map((header, i) => ({ header, width: [14, 46, 14, 14, 16, 12, 46, 14, 10, 18, 18, 22][i] }));
  det.getRow(1).font = { bold: true };
  det.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
  for (const row of detailRows(d)) {
    const x = det.addRow(row.cells);
    x.alignment = { vertical: "top", wrapText: true };
    if (row.c?.inScope) x.getCell(8).font = { color: { argb: argb(rep.RESULT_COLOR[row.c.result]) }, bold: row.c.result === "failed" };
    x.getCell(5).font = { color: { argb: argb(COVERAGE_COLOR[row.r.coverage]) } };
  }
  det.autoFilter = { from: "A1", to: "L1" };

  res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": disposition(d, "xlsx") });
  await wb.xlsx.write(res);
  res.end();
}

function pdf(d, res) {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, info: { Title: `Матрица покрытия ${d.key}`, Author: rep.COMPANY || "TestBall" } });
  doc.registerFont("r", rep.FONT);
  doc.registerFont("b", rep.FONT_BOLD);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": disposition(d, "pdf") });
  doc.pipe(res);
  const L = 36;
  const W = doc.page.width - 2 * L;
  doc.font("r").fontSize(9).fillColor("#666").text([rep.COMPANY, d.projectName, `сформирована ${rep.fmtDate(new Date())}`].filter(Boolean).join(" · "));
  doc.moveDown(0.4).font("b").fontSize(16).fillColor("#111").text("Матрица покрытия требований тестами");
  doc.font("r").fontSize(10).fillColor("#333").text(`Срез: ${d.scope.label}`);

  doc.moveDown(0.6);
  const y0 = doc.y;
  const tiles = [["Требований", d.summary.total], ["Покрыто тестами", `${d.summary.coveredPct}%`], ["Пройдено полностью", `${d.summary.passedPct}%`], ["Провалено", d.summary.failed], ["Не покрыто", d.summary.none]];
  tiles.forEach(([label, value], i) => {
    const x = L + i * (W / tiles.length);
    doc.font("b").fontSize(20).fillColor("#111").text(String(value), x, y0, { width: W / tiles.length - 10 });
    doc.font("r").fontSize(9).fillColor("#666").text(label, x, y0 + 26, { width: W / tiles.length - 10 });
  });
  let x = L;
  const barY = y0 + 46;
  for (const k of COVERAGE_ORDER) {
    const w = d.summary.total ? (d.summary[k] / d.summary.total) * W : 0;
    if (w > 0) doc.rect(x, barY, w, 9).fill(COVERAGE_COLOR[k]);
    x += w;
  }
  doc.y = barY + 14;
  doc.x = L;
  doc.font("r").fontSize(9).fillColor("#333").text(COVERAGE_ORDER.map((k) => `${COVERAGE_LABELS[k]}: ${d.summary[k]}`).join("   "));
  if (d.summary.casesUnlinked) doc.fillColor("#666").text(`Тест-кейсов без требований: ${d.summary.casesUnlinked}`);

  // таблица: требование, покрытие, кейсы с результатами, открытые баги
  const cols = [["Требование", 0.09], ["Название", 0.3], ["Покрытие", 0.1], ["Тест-кейсы и результаты", 0.39], ["Открытые баги", 0.12]];
  const widths = cols.map((c) => c[1] * W);
  const cm = caseOf(d);
  const drawRow = (cells, bold, colors = {}) => {
    doc.font(bold ? "b" : "r").fontSize(8.5);
    const hgt = Math.max(...cells.map((c, i) => doc.heightOfString(String(c ?? ""), { width: widths[i] - 6 }))) + 6;
    if (doc.y + hgt > doc.page.height - 40) {
      doc.addPage();
      if (!bold) drawRow(cols.map((c) => c[0]), true);
    }
    const y = doc.y;
    let cx = L;
    cells.forEach((c, i) => {
      doc.fillColor(colors[i] || (bold ? "#444" : "#111")).text(String(c ?? ""), cx + 3, y + 3, { width: widths[i] - 6 });
      cx += widths[i];
    });
    doc.moveTo(L, y + hgt).lineTo(L + W, y + hgt).lineWidth(0.5).strokeColor("#ddd").stroke();
    doc.y = y + hgt;
  };
  doc.moveDown(1);
  drawRow(cols.map((c) => c[0]), true);
  for (const r of d.requirements) {
    const list = r.cases.map((n) => cm.get(n));
    drawRow(
      [
        reqId(d, r),
        r.title + (r.extRef ? ` (${r.extRef})` : ""),
        COVERAGE_LABELS[r.coverage],
        list.length ? list.map((c) => `${d.key}-${c.num} ${c.title} — ${resultText(c)}`).join("\n") : "нет связанных кейсов",
        list.flatMap((c) => c.bugs.map((b) => `${d.key}-B${b.num}`)).join(", ") || "—",
      ],
      false,
      { 2: COVERAGE_COLOR[r.coverage] }
    );
  }
  doc.end();
}

const router = express.Router({ mergeParams: true });
const query = (req) => ({ release: req.query.release || null, run: req.query.run || null, obsolete: req.query.obsolete === "1" });

router.get("/requirements/matrix", wrap(async (req, res) => {
  res.json(await matrixData(req.params.key, query(req)));
}));

router.get("/requirements/matrix/export", wrap(async (req, res) => {
  const d = await matrixData(req.params.key, query(req));
  const f = req.query.format;
  if (f === "pdf") return pdf(d, res);
  if (f === "csv") return csv(d, res);
  return xlsx(d, res);
}));

module.exports = { router, matrixData };
