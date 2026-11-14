// Управление пользователями — только для админа. Монтируется на /api/admin
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { ROLES, PROJECT_ROLES } = require("./access");
const auth = require("./auth");
const seats = require("./seats");
const { wrap, str } = require("./util");

const router = express.Router();

const findUser = async (db, login) =>
  (await db.query("SELECT id, role, blocked, auth_provider FROM users WHERE login=$1", [str(login, 64)])).rows[0];

// Сам себе админ ничего не меняет: так нельзя случайно остаться без единого админа
const self = (req) => req.params.login === req.user.login;

router.get("/users", wrap(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.login, u.name, u.email, u.role, u.blocked, u.created_at, u.auth_provider, u.last_login_at,
       COALESCE((SELECT json_agg(json_build_object('key', m.project_key, 'role', m.role) ORDER BY m.project_key)
                 FROM project_members m WHERE m.user_id=u.id), '[]') AS projects
     FROM users u ORDER BY u.created_at`
  );
  res.json({
    users: rows.map((u) => ({
      login: u.login, name: u.name, email: u.email, role: u.role, blocked: u.blocked, created: u.created_at.getTime(),
      provider: u.auth_provider, lastLogin: u.last_login_at ? u.last_login_at.getTime() : null,
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
  const bad = auth.checkLogin(login) || (!name && "Укажите имя") || auth.checkPassword(req.body.password) || (!ROLES.includes(role) && "Неизвестная роль");
  if (bad) return res.status(400).json({ error: bad });
  const noSeat = await seats.check(pool, role);
  if (noSeat) return res.status(409).json({ error: noSeat });
  const { rows } = await pool.query(
    "INSERT INTO users(login, name, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT (login) DO NOTHING RETURNING id",
    [login, name, await auth.hashPassword(req.body.password), role]
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
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: "Неизвестная роль" });
  if (blocked !== undefined && typeof blocked !== "boolean") return res.status(400).json({ error: "blocked должно быть true или false" });
  const badPass = password !== undefined && auth.checkPassword(password);
  if (badPass) return res.status(400).json({ error: badPass });
  const hash = password !== undefined ? await auth.hashPassword(password) : null;
  await tx(async (db) => {
    await db.query("UPDATE users SET role=COALESCE($1, role), blocked=COALESCE($2, blocked), password_hash=COALESCE($3, password_hash) WHERE id=$4", [
      role ?? null, blocked ?? null, hash, u.id,
    ]);
    // заблокированного или со сброшенным паролем сразу выкидываем из всех открытых вкладок
    if (blocked || hash) await db.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
  });
  broadcast("users");
  res.json({ ok: true });
}));

// Доступ к проектам: присланный список заменяет прежний.
// projects: ["LK", "PAY"] или [{"key": "LK", "role": "viewer"}]; role null — действует глобальная роль пользователя
router.put("/users/:login/projects", wrap(async (req, res) => {
  const u = await findUser(pool, req.params.login);
  if (!u) return res.status(404).json({ error: "Пользователь не найден" });
  if (!Array.isArray(req.body.projects)) return res.status(400).json({ error: "Передайте список ключей проектов projects" });
  const items = req.body.projects.map((p) => (typeof p === "string" ? { key: p } : p || {}))
    .map((p) => ({ key: str(p.key, 10).toUpperCase(), role: PROJECT_ROLES.includes(p.role) ? p.role : null }))
    .filter((p) => p.key);
  const keys = items.map((p) => p.key);
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

// Кейсы, баги и прогоны пользователя остаются, в авторах у них будет пусто
router.delete("/users/:login", wrap(async (req, res) => {
  if (self(req)) return res.status(409).json({ error: "Себя удалить нельзя" });
  const r = await pool.query("DELETE FROM users WHERE login=$1", [str(req.params.login, 64)]);
  if (!r.rowCount) return res.status(404).json({ error: "Пользователь не найден" });
  broadcast("users");
  res.json({ ok: true });
}));

module.exports = router;
