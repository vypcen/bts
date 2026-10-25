import type { Result, ResultValue, TestCase } from "./types";

// Пункты чек-листа — строки поля steps (сервер хранит их уже очищенными: без пустых, нумерации и повторов)
export const checklistItems = (c: TestCase) => (c.kind === "checklist" ? c.steps.split("\n").filter(Boolean) : []);

// Сколько пунктов отмечено выполненными в самом чек-листе (отметки удалённых пунктов не считаются)
export const doneCount = (c: TestCase) => checklistItems(c).filter((i) => c.checked?.[i]).length;

// Отметка пункта в результате прогона; пункт, который не отмечали, — «не проверен»
export const itemMark = (r: Result | undefined, item: string): ResultValue => r?.items?.[item] || "untested";

// Сколько пунктов уже отмечено — для «7 из 12» в прогоне
export const checkedCount = (items: string[], r: Result) => items.filter((i) => itemMark(r, i) !== "untested").length;

export const itemsWord = (n: number) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? "пункт" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "пункта" : "пунктов";
};
