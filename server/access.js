// Роли и доступ к проектам.
// tester — создаёт, меняет и удаляет всё в своих проектах; developer — только читает свои проекты;
// admin — всё во всех проектах, плюс пользователи, роли и участники проектов.
// «Свои проекты» — те, где пользователь есть в project_members. Чужой проект выглядит как несуществующий.
const { pool } = require("./db");

const ROLES = ["tester", "developer", "admin"];
const READ_ONLY = "У роли «Разработчик» доступ только на просмотр";

const isAdmin = (user) => user?.role === "admin";
const canWrite = (user) => user?.role === "tester" || user?.role === "admin";

// Ключи проектов, доступных пользователю; null — все (админ)
async function projectKeys(user) {
  if (isAdmin(user)) return null;
  const { rows } = await pool.query("SELECT project_key FROM project_members WHERE user_id=$1", [user.id]);
  return rows.map((r) => r.project_key);
}

async function hasProject(user, key) {
  if (isAdmin(user)) return true;
  const { rows } = await pool.query("SELECT 1 FROM project_members WHERE project_key=$1 AND user_id=$2", [key, user.id]);
  return rows.length > 0;
}

// Для всего под /api/projects/:key: проект должен быть доступен, а изменения — разрешены ролью
function project(req, res, next) {
  hasProject(req.user, req.params.key).then((ok) => {
    if (!ok) return res.status(404).json({ error: "Проект не найден" });
    if (req.method !== "GET" && !canWrite(req.user)) return res.status(403).json({ error: READ_ONLY });
    next();
  }, next);
}

function requireWriter(req, res, next) {
  if (!canWrite(req.user)) return res.status(403).json({ error: READ_ONLY });
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Нужны права администратора" });
  next();
}

module.exports = { ROLES, READ_ONLY, isAdmin, canWrite, projectKeys, hasProject, project, requireWriter, requireAdmin };
