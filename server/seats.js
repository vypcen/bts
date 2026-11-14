// Лицензии (места). Полное место — роли, которые меняют данные: tester и admin.
// Просмотровое место — developer (просмотр и комментарии) и viewer (только просмотр).
// LICENSE_FULL_SEATS / LICENSE_VIEW_SEATS — лимиты; пусто — без ограничений. Заблокированные места не занимают.
const FULL = ["tester", "admin"];
const VIEW = ["developer", "viewer"];

const limit = (v) => (/^\d+$/.test(String(v || "").trim()) ? Number(v) : null);
const config = () => ({ full: limit(process.env.LICENSE_FULL_SEATS), view: limit(process.env.LICENSE_VIEW_SEATS) });
const kindOf = (role) => (FULL.includes(role) ? "full" : "view");

async function usage(db) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE role = ANY($1::text[]))::int AS full, count(*) FILTER (WHERE role = ANY($2::text[]))::int AS view
     FROM users WHERE NOT blocked`,
    [FULL, VIEW]
  );
  const c = config();
  return { full: { used: rows[0].full, limit: c.full }, view: { used: rows[0].view, limit: c.view } };
}

// Можно ли пользователю (новому — userId null) получить роль role. Возвращает текст ошибки или null
async function check(db, role, userId = null) {
  const kind = kindOf(role);
  const max = config()[kind];
  if (max === null) return null;
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM users WHERE NOT blocked AND role = ANY($1::text[]) AND id IS DISTINCT FROM $2",
    [kind === "full" ? FULL : VIEW, userId]
  );
  if (rows[0].n < max) return null;
  return kind === "full"
    ? `Все полные лицензии заняты (${max}). Освободите место или выдайте роль «Наблюдатель»`
    : `Все просмотровые лицензии заняты (${max})`;
}

module.exports = { usage, check, kindOf, FULL, VIEW };
