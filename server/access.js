// Роли и доступ к проектам. Что разрешает каждая роль — server/roles.js (встроенные и пользовательские роли).
// tester — всё в своих проектах; developer — просмотр, комментарии, статусы багов; viewer — только чтение;
// admin — всё во всех проектах, плюс пользователи, роли и участники проектов.
// Роль можно задать отдельно для проекта (project_members.role): например, тестировщик в одном проекте и наблюдатель в другом.
// «Свои проекты» — те, где пользователь есть в project_members. Чужой проект выглядит как несуществующий.
const { pool } = require("./db");
const roles = require("./roles");

// встроенные роли (список для проверок); пользовательские — roles.exists()
const ROLES = ["tester", "developer", "viewer", "admin"];
const PROJECT_ROLES = ["tester", "developer", "viewer"];
const READ_ONLY = "У вашей роли в этом проекте доступ только на просмотр";
const isRole = (r) => roles.exists(r);
const isProjectRole = (r) => r !== "admin" && roles.exists(r);

const roleOf = (userOrRole) => (typeof userOrRole === "string" ? userOrRole : userOrRole?.role);
const isAdmin = (user) => roleOf(user) === "admin";
// «пишет»: занимает полное место — может что-то менять сверх комментариев и статусов
const canWrite = (userOrRole) => roles.seatOf(roleOf(userOrRole)) === "full";
const canComment = (userOrRole) => roles.can(roleOf(userOrRole), "comments");
const can = (userOrRole, perm) => roles.can(roleOf(userOrRole), perm);

// Ключи проектов, доступных пользователю; null — все (админ)
// Удалённые в корзину проекты (projects.deleted_at) не видны никому, в том числе админу: их список — в корзине
async function projectKeys(user) {
  if (isAdmin(user) && !user.tokenProject) {
    const { rows } = await pool.query("SELECT key FROM projects WHERE deleted_at IS NULL");
    return rows.map((r) => r.key);
  }
  const { rows } = await pool.query(
    "SELECT m.project_key FROM project_members m JOIN projects p ON p.key=m.project_key WHERE m.user_id=$1 AND p.deleted_at IS NULL",
    [user.id]
  );
  return rows.map((r) => r.project_key).filter((k) => !user.tokenProject || k === user.tokenProject);
}

// Действующая роль пользователя в проекте или null, если проект ему недоступен
async function projectRole(user, key) {
  if (!user) return null;
  if (user.tokenProject && user.tokenProject !== key) return null;
  const { rows } = await pool.query(
    `SELECT p.deleted_at, m.user_id AS member, m.role FROM projects p
     LEFT JOIN project_members m ON m.project_key=p.key AND m.user_id=$2 WHERE p.key=$1`,
    [key, user.id]
  );
  if (!rows[0] || rows[0].deleted_at) return null;
  if (isAdmin(user)) return "admin";
  if (!rows[0].member) return null;
  return rows[0].role || user.role;
}

const hasProject = async (user, key) => Boolean(await projectRole(user, key));

// Для всего под /api/projects/:key: проект должен быть доступен, а изменение — разрешено ролью (roles.ruleFor).
// Действующая роль кладётся в req.projectRole
function project(req, res, next) {
  Promise.all([projectRole(req.user, req.params.key), roles.load()]).then(([role]) => {
    if (!role) return res.status(404).json({ error: "Проект не найден" });
    req.projectRole = role;
    const perm = roles.ruleFor(req.method, req.path, req.body);
    if (!roles.allowed(role, perm)) return res.status(403).json({ error: roles.deniedText(perm), permission: perm });
    next();
  }, next);
}

// Создание и импорт проектов — по глобальной роли
function requireWriter(req, res, next) {
  roles.load().then(() => {
    if (!can(req.user, "projects.create")) return res.status(403).json({ error: roles.deniedText("projects.create") });
    next();
  }, next);
}

// Есть ли разрешение хотя бы в одном проекте (например, создать токен для отправки автотестов)
async function permittedSomewhere(user, perm) {
  await roles.load();
  if (can(user, perm)) return true;
  const { rows } = await pool.query("SELECT role FROM project_members WHERE user_id=$1 AND role IS NOT NULL", [user.id]);
  return rows.some((r) => roles.can(r.role, perm));
}
const writesSomewhere = (user) => permittedSomewhere(user, "autotests.manage");

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Нужны права администратора" });
  next();
}

module.exports = {
  ROLES, PROJECT_ROLES, READ_ONLY, isAdmin, isRole, isProjectRole, canWrite, canComment, can, projectKeys, projectRole, hasProject, project, requireWriter,
  writesSomewhere, permittedSomewhere, requireAdmin,
};
