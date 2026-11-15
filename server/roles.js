// Роли и разрешения.
// Встроенные роли — готовые наборы разрешений: администратор и тестировщик — всё, разработчик — комментарии,
// статусы багов и помощник, наблюдатель — только просмотр. Администратор может завести свои роли
// («Тест-менеджер», «Автоматизатор», «Аналитик») с любым набором разрешений и выдавать их глобально или в проекте.
//
// Лицензия: роль занимает просмотровое место, если в ней только разрешения из VIEW_PERMS, иначе — полное.
// Просмотр проекта доступен любой роли участника; всё, что меняет данные, проверяется по разрешениям (ruleFor).
const { pool } = require("./db");

const PERMS = [
  { key: "cases.edit", group: "Тест-кейсы", label: "Создавать и изменять тест-кейсы, папки, импорт" },
  { key: "cases.delete", group: "Тест-кейсы", label: "Удалять тест-кейсы" },
  { key: "cases.review", group: "Тест-кейсы", label: "Проводить ревью и утверждать кейсы" },
  { key: "requirements.edit", group: "Тест-кейсы", label: "Вести требования и их связи с кейсами" },
  { key: "plans.edit", group: "Прогоны", label: "Вести тест-планы" },
  { key: "runs.manage", group: "Прогоны", label: "Создавать, закрывать, удалять прогоны и распределять кейсы" },
  { key: "runs.execute", group: "Прогоны", label: "Отмечать результаты в прогонах и чек-листах" },
  { key: "bugs.create", group: "Баги", label: "Заводить баги" },
  { key: "bugs.edit", group: "Баги", label: "Изменять баги и связывать с трекером" },
  { key: "bugs.status", group: "Баги", label: "Менять статус бага" },
  { key: "bugs.delete", group: "Баги", label: "Удалять баги" },
  { key: "comments", group: "Общее", label: "Писать комментарии" },
  { key: "ai", group: "Общее", label: "Пользоваться помощником (языковой моделью)" },
  { key: "autotests.manage", group: "Автотесты", label: "Отправлять результаты, управлять автотестами, запускать CI" },
  { key: "trash.restore", group: "Проект", label: "Восстанавливать из корзины" },
  { key: "settings", group: "Проект", label: "Настройки проекта: поля, трекер, вебхуки, CI" },
  { key: "projects.create", group: "Проект", label: "Создавать и импортировать проекты (для глобальной роли)" },
];
const ALL = PERMS.map((p) => p.key);
const LABEL = Object.fromEntries(PERMS.map((p) => [p.key, p.label]));
// что можно на просмотровой лицензии
const VIEW_PERMS = ["comments", "bugs.status", "ai"];

const BUILTIN = {
  admin: { name: "Администратор", permissions: ALL, description: "Все проекты, пользователи, роли и доступы" },
  tester: { name: "Тестировщик", permissions: ALL, description: "Создаёт, меняет и удаляет всё в своих проектах" },
  developer: { name: "Разработчик", permissions: ["comments", "bugs.status", "ai"], description: "Просмотр, комментарии, статусы багов" },
  viewer: { name: "Наблюдатель", permissions: [], description: "Только просмотр" },
};

// Пользовательские роли — кэш на 10 секунд (при нескольких репликах изменения доходят за это время)
let custom = new Map();
let loadedAt = 0;
async function load(force = false) {
  if (!force && Date.now() - loadedAt < 10000) return custom;
  const { rows } = await pool.query("SELECT key, name, description, permissions FROM roles ORDER BY name");
  custom = new Map(rows.map((r) => [r.key, { name: r.name, description: r.description, permissions: r.permissions.filter((p) => ALL.includes(p)) }]));
  loadedAt = Date.now();
  return custom;
}
load.cache = () => custom;
// Синхронно, по кэшу: вызывается на каждом запросе. Кэш обновляет middleware (refresh) перед проверкой
const def = (role) => BUILTIN[role] || custom.get(role) || null;
const exists = (role) => Boolean(def(role));
const permsOf = (role) => new Set(def(role)?.permissions || []);
const can = (role, perm) => role === "admin" || permsOf(role).has(perm);
const seatOf = (role) => (role === "admin" || [...permsOf(role)].some((p) => !VIEW_PERMS.includes(p)) ? "full" : "view");
// роли, занимающие полное место (для подсчёта лицензий)
const fullRoles = () => [...Object.keys(BUILTIN), ...custom.keys()].filter((r) => seatOf(r) === "full");
const nameOf = (role) => def(role)?.name || role;

// Какое разрешение нужно для изменяющего запроса к проекту. path — без /api/projects/:key
// null — разрешено любому участнику; "*" — нужны все права проекта (неизвестный маршрут: безопаснее запретить)
const RULES = [
  [/^\/cases\/\d+\/check$/, "runs.execute"],
  [/^\/cases\/bulk-delete$/, "cases.delete"],
  [/^\/cases\/bulk$/, "cases.edit"],
  [/^\/cases\/\d+$/, (m) => (m === "DELETE" ? "cases.delete" : "cases.edit")],
  [/^\/(cases|cases\/import|cases\/move|cases\/\d+\/versions\/\d+\/restore|folders(\/\d+)?)$/, "cases.edit"],
  [/^\/(bugs|cases)\/\d+\/comments$|^\/comments\/\d+$/, "comments"],
  [/^\/requirements(\/.*)?$/, "requirements.edit"],
  [/^\/templates(\/\d+)?$/, ["cases.edit", "settings"]],
  [/^\/shared-steps(\/\d+)?$/, "cases.edit"],
  [/^\/cases\/\d+\/review$/, "cases.edit"],
  [/^\/cases\/\d+\/review\/decision$/, "cases.review"],
  [/^\/review-settings$/, "settings"],
  [/^\/plans\/preview$/, ["plans.edit", "runs.manage"]],
  [/^\/plans\/\d+\/runs$/, "runs.manage"],
  [/^\/plans(\/.*)?$/, "plans.edit"],
  [/^\/runs\/\d+\/results\/\d+(\/attachments)?$/, "runs.execute"],
  [/^\/runs(\/.*)?$/, "runs.manage"],
  [/^\/bugs$/, "bugs.create"],
  [/^\/bugs\/\d+\/attachments$/, ["bugs.create", "bugs.edit"]],
  [/^\/bugs\/\d+\/external(\/sync)?$/, "bugs.edit"],
  [/^\/bugs\/\d+$/, (m, body) => {
    if (m === "DELETE") return "bugs.delete";
    // переход по жизненному циклу (статус, «дубликат какого») — отдельное разрешение
    const keys = Object.keys(body || {});
    return keys.length && keys.every((k) => k === "status" || k === "duplicateOf") ? "bugs.status" : "bugs.edit";
  }],
  [/^\/ci-jobs\/\d+\/trigger$/, "autotests.manage"],
  [/^\/(autoruns|autotests)(\/.*)?$/, "autotests.manage"],
  [/^\/ai(\/.*)?$/, "ai"],
  [/^\/trash\/\d+\/restore$/, "trash.restore"],
  [/^\/(fields|tracker|webhooks|ci-jobs)(\/.*)?$/, "settings"],
  [/^\/?$/, "settings"], // PATCH самого проекта (название, описание)
];

function ruleFor(method, path, body) {
  if (method === "GET" || method === "HEAD") return null;
  for (const [re, perm] of RULES) {
    if (re.test(path)) return typeof perm === "function" ? perm(method, body) : perm;
  }
  return "*";
}
// Разрешено ли: perm — строка, список (хватит любого) или "*" (все)
function allowed(role, perm) {
  if (!perm) return true;
  if (role === "admin") return true;
  if (perm === "*") return ALL.every((p) => can(role, p));
  return (Array.isArray(perm) ? perm : [perm]).some((p) => can(role, p));
}
const deniedText = (perm) =>
  `Ваша роль в этом проекте не позволяет: ${perm === "*" ? "это действие" : (Array.isArray(perm) ? perm : [perm]).map((p) => LABEL[p].toLowerCase()).join(" или ")}`;

module.exports = { PERMS, ALL, VIEW_PERMS, BUILTIN, LABEL, load, def, exists, permsOf, can, seatOf, fullRoles, nameOf, ruleFor, allowed, deniedText };
