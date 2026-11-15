// Управление пользователями — только для админа. Монтируется на /api/admin
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const access = require("./access");
const roles = require("./roles");
const crypto = require("crypto");
const auth = require("./auth");
const audit = require("./audit");
const security = require("./security");
const seats = require("./seats");
const { wrap, str } = require("./util");

const router = express.Router();
// кэш ролей свежий перед любой проверкой роли
router.use((_req, _res, next) => roles.load().then(() => next(), next));

const findUser = async (db, login) =>
  (await db.query("SELECT id, role, blocked, auth_provider FROM users WHERE login=$1", [str(login, 64)])).rows[0];

// Сам себе админ ничего не меняет: так нельзя случайно остаться без единого админа
const self = (req) => req.params.login === req.user.login;

router.get("/users", wrap(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.login, u.name, u.email, u.role, u.blocked, u.created_at, u.auth_provider, u.last_login_at, (u.totp_secret IS NOT NULL) AS totp,
       u.must_change_password,
       (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.expires_at > now()) AS sessions,
       COALESCE((SELECT json_agg(json_build_object('key', m.project_key, 'role', m.role) ORDER BY m.project_key)
                 FROM project_members m WHERE m.user_id=u.id), '[]') AS projects
     FROM users u ORDER BY u.created_at`
  );
  res.json({
    users: rows.map((u) => ({
      login: u.login, name: u.name, email: u.email, role: u.role, blocked: u.blocked, created: u.created_at.getTime(),
      provider: u.auth_provider, lastLogin: u.last_login_at ? u.last_login_at.getTime() : null,
      twoFactor: u.totp, mustChangePassword: u.must_change_password, sessions: u.sessions,
      projects: u.projects.map((p) => p.key), projectRoles: Object.fromEntries(u.projects.filter((p) => p.role).map((p) => [p.key, p.role])),
    })),
    seats: await seats.usage(pool),
  });
}));

// Новый пользователь — когда регистрация закрыта (REGISTRATION=closed) или чтобы сразу выдать роль
router.post("/users", wrap(async (req, res) => {
  const login = str(req.body.login, 64).toLowerCase();
  const name = str(req.body.name, 100);
  const role = req.body.role === undefined ? "tester" : req.body.role;
  const bad = auth.checkLogin(login) || (!name && "Укажите имя") || auth.checkPassword(req.body.password, { login, name }) || (!access.isRole(role) && "Неизвестная роль");
  if (bad) return res.status(400).json({ error: bad });
  const noSeat = await seats.check(pool, role);
  if (noSeat) return res.status(409).json({ error: noSeat });
  // пароль, выданный админом, пользователь меняет при первом входе (PASSWORD_CHANGE_ON_RESET)
  const { rows } = await pool.query(
    "INSERT INTO users(login, name, password_hash, role, must_change_password) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (login) DO NOTHING RETURNING id",
    [login, name, await auth.hashPassword(req.body.password), role, security.cfg.changeOnReset]
  );
  if (!rows[0]) return res.status(409).json({ error: "Логин уже занят" });
  broadcast("users");
  res.status(201).json({ login });
}));

// Роль, блокировка и новый пароль. Можно прислать одно из полей
router.patch("/users/:login", wrap(async (req, res) => {
  if (self(req)) return res.status(409).json({ error: "Свою роль, блокировку и пароль здесь поменять нельзя: попросите другого админа" });
  const u = await findUser(pool, req.params.login);
  if (!u) return res.status(404).json({ error: "Пользователь не найден" });
  const { role, blocked, password } = req.body;
  if (password !== undefined && u.auth_provider !== "local") {
    return res.status(409).json({ error: "Пароль этого пользователя хранится в каталоге (LDAP/SSO) и меняется там" });
  }
  // новая роль или разблокировка занимают лицензию
  const willBeActive = !(blocked ?? u.blocked);
  if (willBeActive && ((role !== undefined && role !== u.role) || u.blocked)) {
    const noSeat = await seats.check(pool, role ?? u.role, u.id);
    if (noSeat) return res.status(409).json({ error: noSeat });
  }
  if (role !== undefined && !access.isRole(role)) return res.status(400).json({ error: "Неизвестная роль" });
  if (blocked !== undefined && typeof blocked !== "boolean") return res.status(400).json({ error: "blocked должно быть true или false" });
  const badPass = password !== undefined && auth.checkPassword(password, { login: req.params.login });
  if (badPass) return res.status(400).json({ error: badPass });
  const hash = password !== undefined ? await auth.hashPassword(password) : null;
  await tx(async (db) => {
    await db.query("UPDATE users SET role=COALESCE($1, role), blocked=COALESCE($2, blocked) WHERE id=$3", [role ?? null, blocked ?? null, u.id]);
    if (hash) await security.setPassword(db, u.id, hash, { byAdmin: true });
    // заблокированного или со сброшенным паролем сразу выкидываем из всех открытых вкладок
    if (blocked || hash) await db.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
  });
  broadcast("users");
  res.json({ ok: true });
}));

// Потерян телефон: сбросить двухфакторную аутентификацию пользователя. При следующем входе — только пароль
// (если 2FA обязательна, сразу попросит настроить заново)
router.post("/users/:login/2fa/reset", wrap(async (req, res) => {
  if (self(req)) return res.status(409).json({ error: "Свою двухфакторную аутентификацию отключите в настройках безопасности" });
  const u = await findUser(pool, req.params.login);
  if (!u) return res.status(404).json({ error: "Пользователь не найден" });
  await pool.query("UPDATE users SET totp_secret=NULL, totp_pending=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE id=$1", [u.id]);
  await pool.query("DELETE FROM user_recovery_codes WHERE user_id=$1", [u.id]);
  await pool.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
  audit.log(req, "auth.2fa_reset", { project: null, target: req.params.login });
  broadcast("users");
  res.json({ ok: true });
}));

// Завершить все сессии пользователя (например, потерян ноутбук)
router.post("/users/:login/sessions/revoke", wrap(async (req, res) => {
  const u = await findUser(pool, req.params.login);
  if (!u) return res.status(404).json({ error: "Пользователь не найден" });
  const { rowCount } = await pool.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
  audit.log(req, "auth.sessions_revoked", { project: null, target: req.params.login, details: { count: rowCount, byAdmin: true } });
  broadcast("users");
  res.json({ ok: true, count: rowCount });
}));

// Доступ к проектам: присланный список заменяет прежний.
// projects: ["LK", "PAY"] или [{"key": "LK", "role": "viewer"}]; role null — действует глобальная роль пользователя
router.put("/users/:login/projects", wrap(async (req, res) => {
  const u = await findUser(pool, req.params.login);
  if (!u) return res.status(404).json({ error: "Пользователь не найден" });
  if (!Array.isArray(req.body.projects)) return res.status(400).json({ error: "Передайте список ключей проектов projects" });
  const items = req.body.projects.map((p) => (typeof p === "string" ? { key: p } : p || {}))
    .map((p) => ({ key: str(p.key, 10).toUpperCase(), role: access.isProjectRole(p.role) ? p.role : null }))
    .filter((p) => p.key);
  const keys = items.map((p) => p.key);
  // полная роль в проекте занимает полное место в лицензии
  const fullRole = items.find((p) => p.role && roles.seatOf(p.role) === "full");
  if (fullRole && !u.blocked) {
    const noSeat = await seats.check(pool, fullRole.role, u.id);
    if (noSeat) return res.status(409).json({ error: noSeat });
  }
  await tx(async (db) => {
    await db.query("DELETE FROM project_members WHERE user_id=$1 AND NOT (project_key = ANY($2::text[]))", [u.id, keys]);
    // несуществующие ключи молча пропускаются
    await db.query(
      `INSERT INTO project_members(project_key, user_id, role) SELECT key, $1, x.role FROM projects
       JOIN unnest($2::text[], $3::text[]) AS x(k, role) ON x.k = projects.key
       ON CONFLICT (project_key, user_id) DO UPDATE SET role=EXCLUDED.role`,
      [u.id, keys, items.map((p) => p.role)]
    );
  });
  broadcast("users");
  broadcast("projects");
  res.json({ ok: true });
}));

// ---------- роли ----------
// Список разрешений, встроенные и пользовательские роли (с числом пользователей)
router.get("/roles", wrap(async (_req, res) => {
  await roles.load(true);
  const { rows } = await pool.query("SELECT key FROM roles ORDER BY name");
  const used = Object.fromEntries((await pool.query(
    `SELECT role, count(DISTINCT id)::int AS n FROM (
       SELECT id, role FROM users UNION ALL SELECT user_id, role FROM project_members WHERE role IS NOT NULL) x GROUP BY role`
  )).rows.map((r) => [r.role, r.n]));
  const out = (key, d, builtin) => ({ key, name: d.name, description: d.description, permissions: d.permissions, seat: roles.seatOf(key), builtin, users: used[key] || 0 });
  res.json({
    permissions: roles.PERMS,
    viewPermissions: roles.VIEW_PERMS,
    roles: [
      ...Object.entries(roles.BUILTIN).map(([k, d]) => out(k, d, true)),
      ...rows.map((r) => out(r.key, roles.def(r.key), false)),
    ],
  });
}));

function readRole(body, prev = {}) {
  const name = str(body.name ?? prev.name, 60);
  const description = str(body.description ?? prev.description ?? "", 300);
  const permissions = body.permissions !== undefined
    ? [...new Set((Array.isArray(body.permissions) ? body.permissions : []).map(String))]
    : prev.permissions;
  if (!name || name.length < 2) return { error: "Название роли: от 2 до 60 символов" };
  if (Object.values(roles.BUILTIN).some((b) => b.name.toLowerCase() === name.toLowerCase())) return { error: "Так называется встроенная роль" };
  const bad = permissions.find((p) => !roles.ALL.includes(p));
  if (bad) return { error: `Неизвестное разрешение: ${bad}` };
  return { role: { name, description, permissions } };
}

// Сколько полных мест понадобится, если роли станут такими (для проверки лицензии при изменении роли)
async function fullSeatsIf(db, fullKeys) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM users u WHERE NOT blocked AND (u.role = ANY($1::text[])
       OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.role = ANY($1::text[])))`,
    [fullKeys]
  );
  return rows[0].n;
}
async function seatProblem(db, key, permissions) {
  const isFull = permissions.some((p) => !roles.VIEW_PERMS.includes(p));
  if (!isFull || roles.seatOf(key) === "full") return null;
  const limit = (await seats.usage(db)).full.limit;
  if (limit === null) return null;
  const need = await fullSeatsIf(db, [...roles.fullRoles(), key]);
  return need > limit ? `С такими разрешениями роль займёт полные места, а их не хватит: нужно ${need}, по лицензии ${limit}` : null;
}

router.post("/roles", wrap(async (req, res) => {
  const { role, error } = readRole(req.body, { permissions: [] });
  if (error) return res.status(400).json({ error });
  const key = "r_" + crypto.randomBytes(5).toString("hex");
  try {
    await pool.query("INSERT INTO roles(key, name, description, permissions, created_by) VALUES ($1,$2,$3,$4,$5)",
      [key, role.name, role.description, role.permissions, req.user.id]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Роль с таким названием уже есть" });
    throw e;
  }
  await roles.load(true);
  audit.log(req, "role.create", { project: null, target: role.name, details: { permissions: role.permissions } });
  broadcast("users");
  res.status(201).json({ key, seat: roles.seatOf(key) });
}));

router.patch("/roles/:key", wrap(async (req, res) => {
  const cur = roles.def(req.params.key);
  if (!cur || roles.BUILTIN[req.params.key]) return res.status(404).json({ error: "Роль не найдена (встроенные роли не меняются)" });
  const { role, error } = readRole(req.body, cur);
  if (error) return res.status(400).json({ error });
  const problem = await seatProblem(pool, req.params.key, role.permissions);
  if (problem) return res.status(409).json({ error: problem });
  try {
    await pool.query("UPDATE roles SET name=$2, description=$3, permissions=$4 WHERE key=$1", [req.params.key, role.name, role.description, role.permissions]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Роль с таким названием уже есть" });
    throw e;
  }
  await roles.load(true);
  audit.log(req, "role.update", { project: null, target: role.name, details: { permissions: role.permissions } });
  broadcast("users");
  res.json({ ok: true, seat: roles.seatOf(req.params.key) });
}));

// Удалить роль можно, только если она никому не выдана — иначе {replaceWith: "viewer"}: всем, у кого она была, выдать другую
router.delete("/roles/:key", wrap(async (req, res) => {
  const key = req.params.key;
  const cur = roles.def(key);
  if (!cur || roles.BUILTIN[key]) return res.status(404).json({ error: "Роль не найдена (встроенные роли не удаляются)" });
  const replace = req.body.replaceWith;
  const { rows } = await pool.query("SELECT (SELECT count(*) FROM users WHERE role=$1)::int + (SELECT count(*) FROM project_members WHERE role=$1)::int AS n", [key]);
  if (rows[0].n && !replace) return res.status(409).json({ error: `Роль выдана (${rows[0].n}). Укажите, какую роль выдать вместо неё`, inUse: rows[0].n });
  if (replace && (!access.isProjectRole(replace) || replace === key)) return res.status(400).json({ error: "replaceWith: другая роль, кроме администратора" });
  await tx(async (db) => {
    if (replace) {
      await db.query("UPDATE users SET role=$2 WHERE role=$1", [key, replace]);
      await db.query("UPDATE project_members SET role=$2 WHERE role=$1", [key, replace]);
    }
    await db.query("DELETE FROM roles WHERE key=$1", [key]);
  });
  await roles.load(true);
  audit.log(req, "role.delete", { project: null, target: cur.name, details: { replaceWith: replace || null } });
  broadcast("users");
  res.json({ ok: true });
}));

// Кейсы, баги и прогоны пользователя остаются, в авторах у них будет пусто
router.delete("/users/:login", wrap(async (req, res) => {
  if (self(req)) return res.status(409).json({ error: "Себя удалить нельзя" });
  const r = await pool.query("DELETE FROM users WHERE login=$1", [str(req.params.login, 64)]);
  if (!r.rowCount) return res.status(404).json({ error: "Пользователь не найден" });
  broadcast("users");
  res.json({ ok: true });
}));

module.exports = router;
