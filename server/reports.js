// Отчёты для руководителя и заказчика (H-01): прогон и тест-план — в PDF и Excel.
//   GET /api/projects/:key/runs/:num/report?format=pdf|xlsx
//   GET /api/projects/:key/plans/:num/report?format=pdf|xlsx   — все прогоны плана, последний результат каждого кейса
// PDF собирается pdfkit со шрифтом DejaVu (кириллица), Excel — exceljs. Название компании в шапке — REPORT_COMPANY.
const express = require("express");
const path = require("path");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { pool } = require("./db");
const { wrap, num, HttpError } = require("./util");

const FONT = path.join(__dirname, "assets", "fonts", "DejaVuSansCondensed.ttf");
const FONT_BOLD = path.join(__dirname, "assets", "fonts", "DejaVuSansCondensed-Bold.ttf");
const COMPANY = (process.env.REPORT_COMPANY || "").trim();

const RESULT = { passed: "Пройден", failed: "Упал", blocked: "Заблокирован", skipped: "Пропущен", untested: "Не проверен" };
const RESULT_COLOR = { passed: "#2e7d32", failed: "#c62828", blocked: "#b26a00", skipped: "#757575", untested: "#bdbdbd" };
const PRIORITY = { critical: "Критический", high: "Высокий", medium: "Средний", low: "Низкий" };
const SEVERITY = { blocker: "Блокер", critical: "Критический", major: "Значительный", minor: "Незначительный" };
const BUG_STATUS = { new: "Новый", in_progress: "В работе", fixed: "Исправлен", verified: "Проверен", closed: "Закрыт", rejected: "Отклонён", duplicate: "Дубликат" };
const ORDER = ["passed", "failed", "blocked", "skipped", "untested"];

// имя файла латиницей для старых клиентов; полное — в filename*
const ascii = (name) => name.replace(/отчёт/g, "report").replace(/[^\x20-\x7e]/g, "_");
const fmtDate = (d) => (d ? new Date(d).toLocaleString("ru-RU", { timeZone: process.env.TZ || "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

// ---------- данные ----------
async function runData(key, n) {
  const { rows: runs } = await pool.query(
    `SELECT r.*, u.name AS author, p.name AS project_name FROM test_runs r JOIN projects p ON p.key=r.project_key
     LEFT JOIN users u ON u.id=r.created_by WHERE r.project_key=$1 AND r.num=$2`, [key, n]);
  const run = runs[0];
  if (!run) throw new HttpError(404, "Прогон не найден");
  const { rows: results } = await pool.query(
    `SELECT c.num, c.title, c.priority, c.kind, rr.result, rr.comment, rr.step_results, rr.iterations, rr.iter_results, rr.executed_at, eu.name AS executor, au.name AS assignee,
       expand_steps(COALESCE(v.step_list, c.step_list)) AS step_list
     FROM run_results rr JOIN test_cases c ON c.id=rr.case_id
     LEFT JOIN test_case_versions v ON v.case_id=c.id AND v.version=rr.case_version
     LEFT JOIN users eu ON eu.id=rr.executed_by LEFT JOIN users au ON au.id=rr.assignee_id
     WHERE rr.run_id=$1 ORDER BY c.num`, [run.id]);
  const { rows: bugs } = await pool.query(
    `SELECT b.num, b.title, b.severity, b.status, au.name AS assignee FROM bugs b
     JOIN run_results rr ON rr.id=b.run_result_id LEFT JOIN users au ON au.id=b.assignee_id
     WHERE rr.run_id=$1 ORDER BY b.num`, [run.id]);
  return {
    key, projectName: run.project_name,
    title: `Отчёт по прогону ${key}-R${run.num}: ${run.title}`,
    meta: [
      ["Сборка", run.build || "—"], ["Окружение", run.environment || "—"], ["Создал", run.author || "—"],
      ["Начат", fmtDate(run.created_at)], ["Закрыт", run.state === "closed" ? fmtDate(run.closed_at) : "идёт"],
    ],
    results: withIterations(results), bugs,
  };
}

async function planData(key, n) {
  const { rows: plans } = await pool.query(
    `SELECT tp.*, p.name AS project_name FROM test_plans tp JOIN projects p ON p.key=tp.project_key WHERE tp.project_key=$1 AND tp.num=$2`, [key, n]);
  const plan = plans[0];
  if (!plan) throw new HttpError(404, "Тест-план не найден");
  // последний выполненный результат каждого кейса в прогонах этого плана
  const { rows: results } = await pool.query(
    `SELECT DISTINCT ON (c.id) c.num, c.title, c.priority, c.kind, COALESCE(rr.result, 'untested') AS result, rr.comment, rr.step_results, rr.iterations, rr.iter_results,
       rr.executed_at, eu.name AS executor, au.name AS assignee, expand_steps(c.step_list) AS step_list, t.num AS run_num
     FROM run_results rr JOIN test_runs t ON t.id=rr.run_id JOIN test_cases c ON c.id=rr.case_id
     LEFT JOIN users eu ON eu.id=rr.executed_by LEFT JOIN users au ON au.id=rr.assignee_id
     WHERE t.plan_id=$1
     ORDER BY c.id, (rr.result <> 'untested') DESC, rr.executed_at DESC NULLS LAST`, [plan.id]);
  results.sort((a, b) => a.num - b.num);
  const { rows: runs } = await pool.query("SELECT num, title, build, state FROM test_runs WHERE plan_id=$1 ORDER BY num", [plan.id]);
  const { rows: bugs } = await pool.query(
    `SELECT DISTINCT b.num, b.title, b.severity, b.status, au.name AS assignee FROM bugs b
     JOIN run_results rr ON rr.id=b.run_result_id JOIN test_runs t ON t.id=rr.run_id LEFT JOIN users au ON au.id=b.assignee_id
     WHERE t.plan_id=$1 ORDER BY b.num`, [plan.id]);
  return {
    key, projectName: plan.project_name,
    title: `Отчёт по тест-плану ${key}-P${plan.num}: ${plan.title}`,
    meta: [
      ["Прогоны", runs.map((r) => `${key}-R${r.num}${r.build ? ` (${r.build})` : ""}`).join(", ") || "—"],
      ["Режим", plan.mode === "dynamic" ? "динамический" : "статический"], ["Зафиксирован", plan.locked ? "да" : "нет"],
    ],
    results: withIterations(results), bugs,
  };
}

// Кейс с наборами данных: итоги итераций — в комментарий отчёта («Админ» — упал на шаге 2; «Гость» — пройден)
const RES_RU = { untested: "не проверен", passed: "пройден", failed: "упал", blocked: "заблокирован", skipped: "пропущен" };
function withIterations(rows) {
  for (const r of rows) {
    if (!Array.isArray(r.iterations) || !r.iterations.length) continue;
    const lines = r.iterations.map((it, i) => {
      const x = r.iter_results?.[i] || { result: "untested", steps: {} };
      const bad = Object.entries(x.steps || {}).filter(([, m]) => m.result === "failed" || m.result === "blocked").map(([k, m]) => `шаге ${Number(k) + 1}${m.actual ? ` (${m.actual})` : ""}`);
      return `«${it.name}» — ${RES_RU[x.result] || x.result}${bad.length ? ` на ${bad.join(", ")}` : ""}`;
    });
    r.comment = [r.comment, `Наборы данных: ${lines.join("; ")}`].filter(Boolean).join("\n");
  }
  return rows;
}

function summarize(d) {
  const counts = Object.fromEntries(ORDER.map((k) => [k, 0]));
  for (const r of d.results) counts[r.result]++;
  const total = d.results.length;
  const done = total - counts.untested;
  const failedSteps = (r) => (r.step_list || []).map((s, i) => ({ s, i, m: r.step_results?.[i] })).filter((x) => x.m && (x.m.result === "failed" || x.m.result === "blocked"));
  const people = new Map();
  for (const r of d.results) if (r.executor) people.set(r.executor, (people.get(r.executor) || 0) + 1);
  return {
    counts, total, done,
    passRate: done ? Math.round((counts.passed / done) * 100) : 0,
    progress: total ? Math.round((done / total) * 100) : 0,
    problems: d.results.filter((r) => r.result === "failed" || r.result === "blocked").map((r) => ({ ...r, failedSteps: failedSteps(r) })),
    people: [...people.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// ---------- PDF ----------
function pdf(d, res, file) {
  const s = summarize(d);
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: d.title, Author: COMPANY || "TestBall" } });
  doc.registerFont("r", FONT);
  doc.registerFont("b", FONT_BOLD);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${ascii(file)}.pdf"; filename*=UTF-8''${encodeURIComponent(file)}.pdf` });
  doc.pipe(res);
  const W = doc.page.width - 80;

  doc.font("r").fontSize(9).fillColor("#666").text([COMPANY, d.projectName, `сформирован ${fmtDate(new Date())}`].filter(Boolean).join(" · "));
  doc.moveDown(0.4).font("b").fontSize(16).fillColor("#111").text(d.title);
  doc.moveDown(0.5).font("r").fontSize(10);
  for (const [k, v] of d.meta) doc.fillColor("#666").text(`${k}: `, { continued: true }).fillColor("#111").text(v);

  // сводка: крупные цифры и полоса результатов
  doc.moveDown(0.8);
  const y0 = doc.y;
  const tiles = [["Кейсов", s.total], ["Проверено", `${s.progress}%`], ["Успешность", `${s.passRate}%`], ["Багов", d.bugs.length]];
  tiles.forEach(([label, value], i) => {
    const x = 40 + i * (W / 4);
    doc.font("b").fontSize(20).fillColor("#111").text(String(value), x, y0, { width: W / 4 - 10 });
    doc.font("r").fontSize(9).fillColor("#666").text(label, x, y0 + 26, { width: W / 4 - 10 });
  });
  let x = 40;
  const barY = y0 + 48;
  for (const k of ORDER) {
    const w = s.total ? (s.counts[k] / s.total) * W : 0;
    if (w > 0) doc.rect(x, barY, w, 10).fill(RESULT_COLOR[k]);
    x += w;
  }
  doc.y = barY + 16;
  doc.x = 40;
  doc.font("r").fontSize(9).fillColor("#333").text(ORDER.map((k) => `${RESULT[k]}: ${s.counts[k]}`).join("   "));

  const section = (t) => {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.moveDown(1).font("b").fontSize(12).fillColor("#111").text(t, 40);
    doc.moveDown(0.3);
  };
  // таблица с переносом строк и новой страницей при нехватке места
  const table = (cols, rows) => {
    const widths = cols.map((c) => c[1] * W);
    const drawRow = (cells, bold, color) => {
      doc.font(bold ? "b" : "r").fontSize(8.5);
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(String(c ?? ""), { width: widths[i] - 6 }))) + 6;
      if (doc.y + h > doc.page.height - 50) {
        doc.addPage();
        if (!bold) drawRow(cols.map((c) => c[0]), true);
      }
      const y = doc.y;
      let cx = 40;
      cells.forEach((c, i) => {
        doc.fillColor(i === color?.[0] ? color[1] : bold ? "#444" : "#111").text(String(c ?? ""), cx + 3, y + 3, { width: widths[i] - 6 });
        cx += widths[i];
      });
      doc.moveTo(40, y + h).lineTo(40 + W, y + h).lineWidth(0.5).strokeColor("#ddd").stroke();
      doc.y = y + h;
    };
    drawRow(cols.map((c) => c[0]), true);
    for (const r of rows) drawRow(r.cells, false, r.color);
    doc.x = 40;
  };

  if (s.problems.length) {
    section(`Упавшие и заблокированные: ${s.problems.length}`);
    for (const p of s.problems) {
      if (doc.y > doc.page.height - 90) doc.addPage();
      doc.font("b").fontSize(10).fillColor(RESULT_COLOR[p.result]).text(`${d.key}-${p.num} · ${RESULT[p.result]}`, 40, doc.y, { continued: true })
        .fillColor("#111").font("r").text(`  ${p.title}`);
      for (const f of p.failedSteps) doc.fontSize(9).fillColor("#333").text(`Шаг ${f.i + 1}: ${f.s.action}${f.m.actual ? ` — ${f.m.actual}` : ""}`, 52);
      if (p.comment) doc.fontSize(9).fillColor("#555").text(p.comment, 52);
      doc.moveDown(0.3);
    }
  }
  if (d.bugs.length) {
    section(`Баги: ${d.bugs.length}`);
    table([["ID", 0.12], ["Заголовок", 0.48], ["Серьёзность", 0.15], ["Статус", 0.12], ["Исполнитель", 0.13]],
      d.bugs.map((b) => ({ cells: [`${d.key}-B${b.num}`, b.title, SEVERITY[b.severity], BUG_STATUS[b.status], b.assignee || "—"] })));
  }
  if (s.people.length) {
    section("Исполнители");
    table([["Исполнитель", 0.7], ["Проверено кейсов", 0.3]], s.people.map(([n, c]) => ({ cells: [n, c] })));
  }
  section("Все результаты");
  table([["ID", 0.1], ["Кейс", 0.42], ["Приоритет", 0.13], ["Результат", 0.13], ["Проверил", 0.12], ["Когда", 0.1]],
    d.results.map((r) => ({
      cells: [`${d.key}-${r.num}`, r.title, PRIORITY[r.priority], RESULT[r.result], r.executor || "—", r.executed_at ? fmtDate(r.executed_at).slice(0, 10) : "—"],
      color: [3, RESULT_COLOR[r.result]],
    })));
  doc.end();
}

// ---------- Excel ----------
async function xlsx(d, res, file) {
  const s = summarize(d);
  const wb = new ExcelJS.Workbook();
  wb.creator = COMPANY || "TestBall";
  const head = (ws) => {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };
  const sum = wb.addWorksheet("Сводка");
  sum.columns = [{ width: 28 }, { width: 60 }];
  sum.addRow([d.title]).font = { bold: true, size: 14 };
  if (COMPANY) sum.addRow(["Компания", COMPANY]);
  sum.addRow(["Проект", d.projectName]);
  for (const [k, v] of d.meta) sum.addRow([k, v]);
  sum.addRow(["Сформирован", fmtDate(new Date())]);
  sum.addRow([]);
  sum.addRow(["Кейсов", s.total]);
  sum.addRow(["Проверено, %", s.progress]);
  sum.addRow(["Успешность, %", s.passRate]);
  for (const k of ORDER) sum.addRow([RESULT[k], s.counts[k]]);
  sum.addRow(["Багов", d.bugs.length]);

  const res1 = wb.addWorksheet("Результаты");
  res1.columns = [
    { header: "ID", key: "id", width: 10 }, { header: "Кейс", key: "title", width: 60 }, { header: "Приоритет", key: "prio", width: 14 },
    { header: "Результат", key: "result", width: 14 }, { header: "Упавшие шаги", key: "steps", width: 50 }, { header: "Комментарий", key: "comment", width: 40 },
    { header: "Проверил", key: "who", width: 20 }, { header: "Когда", key: "when", width: 18 },
  ];
  for (const r of d.results) {
    const fails = (r.step_list || []).map((st, i) => ({ st, i, m: r.step_results?.[i] })).filter((x) => x.m && x.m.result !== "passed" && x.m.result !== "untested");
    const row = res1.addRow({
      id: `${d.key}-${r.num}`, title: r.title, prio: PRIORITY[r.priority], result: RESULT[r.result],
      steps: fails.map((x) => `${x.i + 1}. ${x.st.action}${x.m.actual ? ` — ${x.m.actual}` : ""}`).join("\n"),
      comment: r.comment || "", who: r.executor || "", when: r.executed_at ? new Date(r.executed_at) : null,
    });
    row.getCell("result").font = { color: { argb: "FF" + RESULT_COLOR[r.result].slice(1) }, bold: r.result === "failed" };
    row.alignment = { vertical: "top", wrapText: true };
  }
  res1.getColumn("when").numFmt = "dd.mm.yyyy hh:mm";
  res1.autoFilter = { from: "A1", to: "H1" };
  head(res1);

  const bugs = wb.addWorksheet("Баги");
  bugs.columns = [
    { header: "ID", key: "id", width: 10 }, { header: "Заголовок", key: "title", width: 60 }, { header: "Серьёзность", key: "sev", width: 16 },
    { header: "Статус", key: "status", width: 14 }, { header: "Исполнитель", key: "who", width: 20 },
  ];
  for (const b of d.bugs) bugs.addRow({ id: `${d.key}-B${b.num}`, title: b.title, sev: SEVERITY[b.severity], status: BUG_STATUS[b.status], who: b.assignee || "" });
  head(bugs);

  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${ascii(file)}.xlsx"; filename*=UTF-8''${encodeURIComponent(file)}.xlsx`,
  });
  await wb.xlsx.write(res);
  res.end();
}

const router = express.Router({ mergeParams: true });
async function send(req, res, d, file) {
  const format = req.query.format === "xlsx" ? "xlsx" : "pdf";
  if (format === "xlsx") return xlsx(d, res, file);
  return pdf(d, res, file);
}
router.get("/runs/:num/report", wrap(async (req, res) => {
  const d = await runData(req.params.key, num(req.params.num));
  await send(req, res, d, `${req.params.key}-R${num(req.params.num)}-отчёт`);
}));
router.get("/plans/:num/report", wrap(async (req, res) => {
  const d = await planData(req.params.key, num(req.params.num));
  await send(req, res, d, `${req.params.key}-P${num(req.params.num)}-отчёт`);
}));

module.exports = { router, runData, planData, summarize, FONT, FONT_BOLD, COMPANY, RESULT, RESULT_COLOR, ascii, fmtDate };
