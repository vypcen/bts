// Лицензии (места). Полное место — роли, которые меняют данные: tester и admin.
// Просмотровое место — developer (просмотр и комментарии) и viewer (только просмотр).
// Число мест задаёт лицензионный ключ (server/license.js); без ключа — бесплатная редакция.
// LICENSE_FULL_SEATS / LICENSE_VIEW_SEATS могут только уменьшить лимит (например, распределить места между стендами).
// Заблокированные пользователи места не занимают.
const license = require("./license");
const FULL = ["tester", "admin"];
const VIEW = ["developer", "viewer"];

const limit = (v) => (/^\d+$/.test(String(v || "").trim()) ? Number(v) : null);
const lower = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));
async function config() {
  const l = await license.current();
  return { full: lower(l.full, limit(process.env.LICENSE_FULL_SEATS)), view: lower(l.view, limit(process.env.LICENSE_VIEW_SEATS)) };
}
const kindOf = (role) => (FULL.includes(role) ? "full" : "view");

async function usage(db) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE role = ANY($1::text[]))::int AS full, count(*) FILTER (WHERE role = ANY($2::text[]))::int AS view
     FROM users WHERE NOT blocked`,
    [FULL, VIEW]
  );
  const c = await config();
  return { full: { used: rows[0].full, limit: c.full }, view: { used: rows[0].view, limit: c.view } };
}

// Можно ли пользователю (новому — userId null) получить роль role. Возвращает текст ошибки или null
async function check(db, role, userId = null) {
  const kind = kindOf(role);
  const max = (await config())[kind];
  if (max === null) return null;
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM users WHERE NOT blocked AND role = ANY($1::text[]) AND id IS DISTINCT FROM $2",
    [kind === "full" ? FULL : VIEW, userId]
  );
  if (rows[0].n < max) return null;
  return kind === "full"
    ? `Все полные лицензии заняты (${max}). Освободите место, выдайте роль «Наблюдатель» или расширьте лицензию`
    : `Все просмотровые лицензии заняты (${max})`;
}

module.exports = { usage, check, kindOf, FULL, VIEW };
