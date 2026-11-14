// Роли и доступ к проектам.
// tester — создаёт, меняет и удаляет всё в своих проектах; developer — читает свои проекты и пишет комментарии;
// viewer — просмотровая лицензия: только чтение; admin — всё во всех проектах, плюс пользователи, роли и участники проектов.
// Роль можно задать отдельно для проекта (project_members.role): например, тестировщик в одном проекте и наблюдатель в другом.
// «Свои проекты» — те, где пользователь есть в project_members. Чужой проект выглядит как несуществующий.
const { pool } = require("./db");

const ROLES = ["tester", "developer", "viewer", "admin"];
const PROJECT_ROLES = ["tester", "developer", "viewer"];
const READ_ONLY = "У вашей роли в этом проекте доступ только на просмотр";

const roleOf = (userOrRole) => (typeof userOrRole === "string" ? userOrRole : userOrRole?.role);
const isAdmin = (user) => roleOf(user) === "admin";
const canWrite = (userOrRole) => ["tester", "admin"].includes(roleOf(userOrRole));
const canComment = (userOrRole) => ["tester", "admin", "developer"].includes(roleOf(userOrRole));

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

// Что разработчик может отправлять при доступе «только просмотр»: комментарии (кто может менять конкретный, решает
// server/comments.js) и разбор падения автотеста моделью — он ничего не меняет
const DEV_WRITES_RE = /^\/((bugs|cases)\/[^/]+\/comments|comments\/[^/]+|ai\/autoresults\/[^/]+\/explain)$/;

// Для всего под /api/projects/:key: проект должен быть доступен, а изменения — разрешены ролью.
// Действующая роль кладётся в req.projectRole
function project(req, res, next) {
  projectRole(req.user, req.params.key).then((role) => {
    if (!role) return res.status(404).json({ error: "Проект не найден" });
    req.projectRole = role;
    if (req.method !== "GET" && !canWrite(role) && !(canComment(role) && DEV_WRITES_RE.test(req.path))) {
      return res.status(403).json({ error: READ_ONLY });
    }
    next();
  }, next);
}

function requireWriter(req, res, next) {
  if (!canWrite(req.user)) return res.status(403).json({ error: READ_ONLY });
  next();
}

// Пишет хотя бы в одном проекте (например, может создать токен для отправки автотестов)
async function writesSomewhere(user) {
  if (canWrite(user)) return true;
  const { rows } = await pool.query("SELECT 1 FROM project_members WHERE user_id=$1 AND role='tester' LIMIT 1", [user.id]);
  return rows.length > 0;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Нужны права администратора" });
  next();
}

module.exports = {
  ROLES, PROJECT_ROLES, READ_ONLY, isAdmin, canWrite, canComment, projectKeys, projectRole, hasProject, project, requireWriter,
  writesSomewhere, requireAdmin,
};
