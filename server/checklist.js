// Чек-листы: пункты и итог по ним. Тот же расчёт итога есть в web/src/checklist.ts
const MAX_ITEMS = 200;
const MAX_ITEM = 500;
const KINDS = ["case", "checklist"];

// Пункты из текста: по одному в строке, без пустых строк, нумерации и маркеров списка, без повторов —
// отметка пункта в прогоне хранится по его тексту
function items(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.replace(/^(?:\s*(?:\d+\s*[.):-]|[-*•☐☑✓✔]|\[[ xх]?\])\s*)+/i, "").trim().slice(0, MAX_ITEM);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// Проверка пунктов при сохранении: ошибка или нормализованный текст
function check(text) {
  const list = items(text);
  if (!list.length) return { error: "Добавьте хотя бы один пункт чек-листа" };
  if (list.length > MAX_ITEMS) return { error: `В чек-листе больше ${MAX_ITEMS} пунктов — разбейте его на несколько` };
  return { steps: list.join("\n") };
}

// Итог чек-листа: упал хоть один пункт — упал; затем заблокирован; все отмечены — пройден (или пропущен, если ничего не проверяли);
// пока есть неотмеченные — не проверен
function verdict(list, marks) {
  const m = list.map((t) => marks[t] || "untested");
  if (m.includes("failed")) return "failed";
  if (m.includes("blocked")) return "blocked";
  if (m.includes("untested")) return "untested";
  return m.includes("passed") ? "passed" : "skipped";
}

module.exports = { KINDS, MAX_ITEM, items, check, verdict };
