// Лицензии (места). Полное место — роли, которые меняют данные: tester и admin.
// Просмотровое место — developer (просмотр и комментарии) и viewer (только просмотр).
// Число мест задаёт лицензионный ключ (server/license.js); без ключа — бесплатная редакция.
// LICENSE_FULL_SEATS / LICENSE_VIEW_SEATS могут только уменьшить лимит (например, распределить места между стендами).
// Заблокированные пользователи места не занимают.
const license = require("./license");
const roles = require("./roles");
// встроенные роли; пользовательская роль занимает полное место, если в ней есть разрешения сверх просмотровых (roles.seatOf)
const FULL = ["tester", "admin"];
const VIEW = ["developer", "viewer"];

const limit = (v) => (/^\d+$/.test(String(v || "").trim()) ? Number(v) : null);
const lower = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));
async function config() {
  const l = await license.current();
  return { full: lower(l.full, limit(process.env.LICENSE_FULL_SEATS)), view: lower(l.view, limit(process.env.LICENSE_VIEW_SEATS)) };
}
const kindOf = (role) => roles.seatOf(role);

// Пользователь занимает полное место, если полная у него глобальная роль или роль хотя бы в одном проекте
const IS_FULL = `(u.role = ANY($1::text[]) OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.role = ANY($1::text[])))`;

async function usage(db) {
  await roles.load();
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE ${IS_FULL})::int AS full, count(*) FILTER (WHERE NOT ${IS_FULL})::int AS view
     FROM users u WHERE NOT blocked`,
    [roles.fullRoles()]
  );
  const c = await config();
  return { full: { used: rows[0].full, limit: c.full }, view: { used: rows[0].view, limit: c.view } };
}

// Можно ли пользователю (новому — userId null) получить роль role. Возвращает текст ошибки или null
async function check(db, role, userId = null) {
  await roles.load();
  const kind = kindOf(role);
  const max = (await config())[kind];
  if (max === null) return null;
  // пользователь уже занимает полное место (например, полной ролью в проекте) — новое не нужно
  if (kind === "full" && userId) {
    const { rows } = await db.query(`SELECT ${IS_FULL} AS full FROM users u WHERE u.id=$2 AND NOT u.blocked`, [roles.fullRoles(), userId]);
    if (rows[0]?.full) return null;
  }
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM users u WHERE NOT blocked AND u.id IS DISTINCT FROM $2 AND ${kind === "full" ? IS_FULL : `NOT ${IS_FULL}`}`,
    [roles.fullRoles(), userId]
  );
  if (rows[0].n < max) return null;
  return kind === "full"
    ? `Все полные лицензии заняты (${max}). Освободите место, выдайте роль «Наблюдатель» или расширьте лицензию`
    : `Все просмотровые лицензии заняты (${max})`;
}

module.exports = { usage, check, kindOf, FULL, VIEW };
