import type { AutoStatus, BugStatus, CaseStatus, Priority, ResultValue, Role, Severity } from "./types";

export type Tone = "neutral" | "info" | "ok" | "crit" | "warn" | "accent";
type Def<K extends string> = { key: K; label: string; tone: Tone }[];

export const CASE_STATUSES: Def<CaseStatus> = [
  { key: "draft", label: "Черновик", tone: "neutral" },
  { key: "ready", label: "Готов", tone: "info" },
  { key: "deprecated", label: "Устарел", tone: "warn" },
];

export const PRIORITIES: Def<Priority> = [
  { key: "critical", label: "Критический", tone: "crit" },
  { key: "high", label: "Высокий", tone: "warn" },
  { key: "medium", label: "Средний", tone: "info" },
  { key: "low", label: "Низкий", tone: "neutral" },
];

export const RESULTS: Def<ResultValue> = [
  { key: "untested", label: "Не проверен", tone: "neutral" },
  { key: "passed", label: "Пройден", tone: "ok" },
  { key: "failed", label: "Упал", tone: "crit" },
  { key: "blocked", label: "Заблокирован", tone: "warn" },
  { key: "skipped", label: "Пропущен", tone: "neutral" },
];

// «Сломан» — тест упал не на проверке, а с ошибкой в самом тесте или окружении (error в JUnit)
export const AUTO_STATUSES: Def<AutoStatus> = [
  { key: "passed", label: "Пройден", tone: "ok" },
  { key: "failed", label: "Упал", tone: "crit" },
  { key: "broken", label: "Сломан", tone: "warn" },
  { key: "skipped", label: "Пропущен", tone: "neutral" },
];

export const BUG_STATUSES: Def<BugStatus> = [
  { key: "new", label: "Новый", tone: "info" },
  { key: "in_progress", label: "В работе", tone: "warn" },
  { key: "fixed", label: "Исправлен", tone: "accent" },
  { key: "verified", label: "Проверен", tone: "ok" },
  { key: "closed", label: "Закрыт", tone: "neutral" },
  { key: "rejected", label: "Отклонён", tone: "neutral" },
  { key: "duplicate", label: "Дубликат", tone: "neutral" },
];

export const SEVERITIES: Def<Severity> = [
  { key: "blocker", label: "Блокирующий", tone: "crit" },
  { key: "critical", label: "Критический", tone: "crit" },
  { key: "major", label: "Значительный", tone: "warn" },
  { key: "minor", label: "Незначительный", tone: "neutral" },
];

// Допустимые переходы жизненного цикла бага. Тот же список проверяет сервер (server/bugs.js)
export const BUG_FLOW: Record<BugStatus, BugStatus[]> = {
  new: ["in_progress", "rejected", "duplicate"],
  in_progress: ["fixed", "new", "rejected"],
  fixed: ["verified", "in_progress"],
  verified: ["closed", "in_progress"],
  closed: ["in_progress"],
  rejected: ["new"],
  duplicate: ["new"],
};

// Подпись кнопки перехода зависит от того, откуда переходим
export function transitionLabel(from: BugStatus, to: BugStatus): string {
  if (to === "in_progress") return from === "new" ? "Взять в работу" : "Переоткрыть";
  if (to === "new") return "Вернуть в новые";
  return { fixed: "Исправлен", verified: "Проверен", closed: "Закрыть", rejected: "Отклонить", duplicate: "Дубликат…" }[to] || to;
}

// Баг «открыт», пока его не закрыли, не отклонили и не признали дубликатом
export const RESOLVED: BugStatus[] = ["closed", "rejected", "duplicate"];
export const isOpenBug = (s: BugStatus) => !RESOLVED.includes(s);

export function find<K extends string>(list: Def<K>, key: K) {
  return list.find((d) => d.key === key) || { key, label: key, tone: "neutral" as Tone };
}

export const ROLES: (Def<Role>[number] & { hint: string })[] = [
  { key: "tester", label: "Тестировщик", tone: "info", hint: "Создаёт, меняет и удаляет всё в своих проектах" },
  { key: "developer", label: "Разработчик", tone: "neutral", hint: "Только просмотр своих проектов" },
  { key: "admin", label: "Администратор", tone: "accent", hint: "Все проекты, пользователи, роли и доступы" },
];
export const roleOf = (r: Role) => ROLES.find((x) => x.key === r) || ROLES[1];
