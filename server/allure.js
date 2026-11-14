// Приём результатов в формате Allure (allure-results): *-result.json от allure-pytest, allure-junit5, allure-testng,
// allure-js (Playwright, Jest, Mocha, Cypress), allure-kotlin и других. Формат описан в документации Allure 2.
// Результаты переводятся в формат TestBall (см. POST /autoruns/:num/results), вложения CLI загружает по списку source.
const { str } = require("./util");

const STATUS = { passed: "passed", failed: "failed", broken: "broken", skipped: "skipped", unknown: "broken" };
const STEP_STATUS = { passed: "passed", failed: "failed", broken: "failed", skipped: "skipped", unknown: "failed" };

const label = (r, name) => (Array.isArray(r.labels) ? r.labels.find((l) => l && l.name === name)?.value : undefined);
const labels = (r, name) => (Array.isArray(r.labels) ? r.labels.filter((l) => l && l.name === name).map((l) => String(l.value)) : []);
const dur = (x) => (Number.isFinite(x?.start) && Number.isFinite(x?.stop) ? Math.max(0, x.stop - x.start) : 0);

function steps(list, out) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      for (const a of Array.isArray(s.attachments) ? s.attachments : []) if (a?.source) out.push(a);
      // параметры шага (allure.step с аргументами) — в название
      const params = Array.isArray(s.parameters) && s.parameters.length ? ` [${s.parameters.map((p) => `${p.name}=${p.value}`).join(", ")}]` : "";
      return {
        title: str(`${s.name || "Шаг"}${params}`, 500),
        status: STEP_STATUS[s.status] || "passed",
        durationMs: dur(s),
        error: s.status === "failed" || s.status === "broken" ? str(s.statusDetails?.message, 2000) : "",
        steps: steps(s.steps, out),
      };
    });
}

// Набор: suite > parentSuite > subSuite, иначе класс или пакет, иначе файл
function suiteOf(r) {
  const parts = [label(r, "parentSuite"), label(r, "suite"), label(r, "subSuite")].filter(Boolean);
  if (parts.length) return parts.join(" › ");
  return label(r, "testClass") || label(r, "package") || "";
}

// ID кейсов TestBall из меток и ссылок: label testball=LK-12 / tms=LK-12 / allure_id, ссылка type=tms с именем LK-12
function caseRefs(r) {
  const refs = [...labels(r, "testball"), ...labels(r, "tms"), ...labels(r, "case")];
  for (const l of Array.isArray(r.links) ? r.links : []) {
    if (l && (l.type === "tms" || l.type === "testball") && l.name) refs.push(String(l.name));
    if (l && l.type === "tms" && l.url) {
      const m = String(l.url).match(/([A-Z]{2,6}-\d+)\/?$/);
      if (m) refs.push(m[1]);
    }
  }
  return [...new Set(refs.map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z]{2,6}-\d+$/.test(x)))];
}

// results — разобранные *-result.json одного запуска. Повторы одного теста (тот же historyId) сводятся в один результат:
// итог — последняя попытка, retries — число повторов, flaky — прошёл после падения
function convert(results) {
  const valid = (Array.isArray(results) ? results : []).filter((r) => r && typeof r === "object" && r.name && r.status);
  const groups = new Map();
  for (const r of valid) {
    const params = Array.isArray(r.parameters) ? r.parameters.filter((p) => p && !p.excluded && p.mode !== "hidden") : [];
    const key = r.historyId || `${r.fullName || r.name}|${params.map((p) => `${p.name}=${p.value}`).join(",")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const attempts of groups.values()) {
    attempts.sort((a, b) => (a.stop || a.start || 0) - (b.stop || b.start || 0));
    const r = attempts[attempts.length - 1];
    const params = Array.isArray(r.parameters) ? r.parameters.filter((p) => p && !p.excluded && p.mode !== "hidden") : [];
    // параметризованные тесты различаются параметрами — иначе все вариации слились бы в один тест
    const name = params.length ? `${r.name} [${params.map((p) => `${p.name}=${p.value}`).join(", ")}]` : r.name;
    const files = [];
    for (const a of Array.isArray(r.attachments) ? r.attachments : []) if (a?.source) files.push(a);
    const stepList = steps(r.steps, files);
    const status = STATUS[r.status] || "broken";
    const retried = attempts.length - 1;
    out.push({
      suite: str(suiteOf(r), 500),
      name: str(name, 1000),
      file: str(label(r, "package") && label(r, "testMethod") ? `${label(r, "package")}.${label(r, "testMethod")}` : r.fullName || "", 500),
      status,
      durationMs: dur(r),
      message: str(r.statusDetails?.message, 5000),
      details: str(r.statusDetails?.trace, 50000),
      steps: stepList,
      retries: retried,
      flaky: r.statusDetails?.flaky === true || (status === "passed" && attempts.some((a) => a.status === "failed" || a.status === "broken")),
      attachments: files.map((a) => ({ source: str(a.source, 300), name: str(a.name || a.source, 200), type: str(a.type, 100) })),
      cases: caseRefs(r),
      tags: labels(r, "tag").slice(0, 20),
      severity: label(r, "severity") || "",
    });
  }
  return out;
}

module.exports = { convert, caseRefs };
