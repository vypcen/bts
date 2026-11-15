// Журнал аудита (C-01): входы и неудачные попытки, пользователи и роли, доступы к проектам, удаления и восстановления,
// интеграции, токены, экспорт и импорт данных. Записи только добавляются; смотреть и выгружать их может админ.
//
// Две части:
//  - log(req, action, {...}) — явная запись из кода (вход, смена пароля, удаление в корзину…);
//  - middleware() — пишет изменяющие запросы к «чувствительным» маршрутам после успешного ответа (таблица RULES),
//    чтобы новый маршрут в этих разделах не остался без следа.
// Срок хранения — AUDIT_RETENTION_DAYS (по умолчанию 365), старые записи удаляет фоновая задача.
const express = require("express");
const { pool } = require("./db");
const { wrap, str, num, ms } = require("./util");
const { csvRow } = require("./csvutil");

const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 365);

const ACTIONS = {
  "auth.login": "Вход",
  "auth.login_failed": "Неудачная попытка входа",
  "auth.logout": "Выход",
  "auth.password": "Смена своего пароля",
  "auth.register": "Регистрация",
  "auth.2fa_enabled": "Двухфакторная аутентификация включена",
  "auth.2fa_disabled": "Двухфакторная аутентификация отключена",
  "auth.2fa_reset": "Двухфакторная аутентификация сброшена администратором",
  "auth.2fa_failed": "Неверный код второго фактора",
  "auth.recovery_used": "Вход по резервному коду",
  "auth.recovery_codes": "Новые резервные коды",
  "auth.sessions_revoked": "Сессии завершены",
  "user.create": "Пользователь создан",
  "user.update": "Пользователь изменён (роль, блокировка, пароль)",
  "user.projects": "Доступ к проектам изменён",
  "user.delete": "Пользователь удалён",
  "user.personal_data": "Выгрузка персональных данных пользователя",
  "user.anonymize": "Пользователь обезличен",
  "role.create": "Роль создана",
  "role.update": "Роль изменена",
  "role.delete": "Роль удалена",
  "project.create": "Проект создан",
  "project.update": "Проект изменён",
  "project.delete": "Проект удалён в корзину",
  "project.restore": "Проект восстановлен",
  "project.purge": "Проект удалён навсегда",
  "project.export": "Проект выгружен",
  "project.import": "Проект загружен",
  "case.delete": "Тест-кейс удалён в корзину",
  "run.delete": "Прогон удалён в корзину",
  "bug.delete": "Баг удалён в корзину",
  "trash.restore": "Восстановлено из корзины",
  "trash.purge": "Удалено из корзины навсегда",
  "plan.delete": "Тест-план удалён",
  "requirement.delete": "Требование удалено",
  "requirements.import": "Импорт требований",
  "plan.lock": "Тест-план заблокирован",
  "plan.unlock": "Тест-план разблокирован",
  "autorun.delete": "Запуск автотестов удалён",
  "autotest.delete": "Автотест удалён из реестра",
  "attachment.delete": "Вложение удалено",
  "folder.delete": "Папка удалена",
  "comment.delete": "Комментарий удалён",
  "integration.webhook": "Вебхук изменён",
  "integration.tracker": "Трекер задач изменён",
  "integration.ci": "Задача CI изменена",
  "settings.llm": "Настройки языковой модели изменены",
  "settings.license": "Лицензия изменена",
  "token.create": "Токен создан",
  "token.delete": "Токен отозван",
  "cases.import": "Импорт тест-кейсов",
};

// Маршрут → действие для автоматической записи. Тело запроса в журнал не попадает (там бывают пароли и секреты):
// только метод, путь и цель
const RULES = [
  [/^POST \/api\/admin\/users$/, "user.create"],
  [/^PATCH \/api\/admin\/users\/([^/]+)$/, "user.update", 1],
  [/^PUT \/api\/admin\/users\/([^/]+)\/projects$/, "user.projects", 1],
  [/^DELETE \/api\/admin\/users\/([^/]+)$/, "user.delete", 1],
  [/^(POST|PUT|PATCH|DELETE) \/api\/admin\/llm/, "settings.llm"],
  [/^(POST|PUT|DELETE) \/api\/admin\/license/, "settings.license"],
  [/^POST \/api\/projects$/, "project.create"],
  [/^PATCH \/api\/projects\/[^/]+$/, "project.update"],
  [/^POST \/api\/projects-import/, "project.import"],
  [/^GET \/api\/projects\/[^/]+\/export/, "project.export"],
  [/^DELETE \/api\/projects\/[^/]+\/plans\/(\d+)$/, "plan.delete", 1, "P"],
  [/^DELETE \/api\/projects\/[^/]+\/requirements\/(\d+)$/, "requirement.delete", 1, "R"],
  [/^POST \/api\/projects\/[^/]+\/requirements\/import$/, "requirements.import"],
  [/^POST \/api\/projects\/[^/]+\/plans\/(\d+)\/lock$/, "plan.lock", 1, "P"],
  [/^POST \/api\/projects\/[^/]+\/plans\/(\d+)\/unlock$/, "plan.unlock", 1, "P"],
  [/^DELETE \/api\/projects\/[^/]+\/autoruns\/(\d+)$/, "autorun.delete", 1, "A"],
  [/^DELETE \/api\/projects\/[^/]+\/autotests\/(\d+)$/, "autotest.delete", 1],
  [/^DELETE \/api\/projects\/[^/]+\/folders\/(\d+)$/, "folder.delete", 1],
  [/^DELETE \/api\/projects\/[^/]+\/comments\/(\d+)$/, "comment.delete", 1],
  [/^DELETE \/api\/attachments\/([^/]+)$/, "attachment.delete", 1],
  [/^(POST|PATCH|DELETE) \/api\/projects\/[^/]+\/webhooks(?:\/(\d+))?$/, "integration.webhook", 2],
  [/^(PUT|DELETE) \/api\/projects\/[^/]+\/tracker$/, "integration.tracker"],
  [/^(POST|PATCH|DELETE) \/api\/projects\/[^/]+\/ci-jobs(?:\/(\d+))?$/, "integration.ci", 2],
  [/^POST \/api\/tokens$/, "token.create"],
  [/^DELETE \/api\/tokens\/(\d+)$/, "token.delete", 1],
  [/^POST \/api\/projects\/[^/]+\/cases\/import$/, "cases.import"],
];

const projectOf = (path) => (path.match(/^\/api\/projects\/([A-Z]{2,6})(?:\/|$)/) || [])[1] || null;

async function write({ actor, ip, action, project = null, target = "", details = {} }) {
  try {
    await pool.query(
      `INSERT INTO audit_log(actor_id, actor_login, ip, action, project_key, target, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor?.id || null, actor?.login || "", String(ip || "").slice(0, 100), action, project, String(target).slice(0, 300), details]
    );
  } catch (e) {
    // журнал не должен ронять основное действие, но молчать о сбое тоже нельзя
    console.error("[audit] запись не удалась:", e.message);
  }
}

// Явная запись из обработчика
const log = (req, action, { project, target = "", details = {}, actor } = {}) =>
  write({ actor: actor || req.user, ip: req.ip, action, project: project === undefined ? projectOf(req.originalUrl) : project, target, details });

function middleware() {
  return (req, res, next) => {
    const line = `${req.method} ${req.originalUrl.split("?")[0]}`;
    const rule = RULES.find(([re]) => re.test(line));
    if (!rule) return next();
    res.on("finish", () => {
      if (res.statusCode >= 400 || !req.user) return;
      const m = line.match(rule[0]);
      const project = projectOf(req.originalUrl);
      const raw = rule[2] && m[rule[2]] ? decodeURIComponent(m[rule[2]]) : "";
      const target = raw && rule[3] && project ? `${project}-${rule[3]}${raw}` : raw || project || "";
      write({ actor: req.user, ip: req.ip, action: rule[1], project, target, details: { method: req.method, path: req.originalUrl.split("?")[0], via: req.viaToken ? "token" : "session" } });
    });
    next();
  };
}

// ---------- чтение журнала (только админ, монтируется на /api/admin) ----------
const router = express.Router();

function filters(q) {
  const params = [];
  const where = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (q.actor) add("actor_login = ?", str(q.actor, 64).toLowerCase());
  if (q.action) add("action LIKE ? || '%'", str(q.action, 50));
  if (q.project) add("project_key = ?", str(q.project, 10).toUpperCase());
  if (q.target) add("target ILIKE '%' || ? || '%'", str(q.target, 100));
  if (q.from && !isNaN(Date.parse(q.from))) add("at >= ?", new Date(q.from));
  if (q.to && !isNaN(Date.parse(q.to))) add("at < ?", new Date(q.to));
  return { params, where };
}

const toEntry = (r) => ({
  id: Number(r.id), at: ms(r.at), actor: r.actor_login, ip: r.ip, action: r.action, title: ACTIONS[r.action] || r.action,
  project: r.project_key, target: r.target, details: r.details,
});

router.get("/audit", wrap(async (req, res) => {
  const { params, where } = filters(req.query);
  const limit = Math.min(500, Math.max(1, num(req.query.limit) || 100));
  if (num(req.query.before)) {
    params.push(num(req.query.before));
    where.push(`id < $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit + 1}`,
    params
  );
  const items = rows.slice(0, limit).map(toEntry);
  res.json({ items, next: rows.length > limit ? String(items[items.length - 1].id) : null, actions: ACTIONS, retentionDays: RETENTION_DAYS });
}));

// Выгрузка в CSV (Excel): те же фильтры, до 100 тыс. записей
router.get("/audit.csv", wrap(async (req, res) => {
  const { params, where } = filters(req.query);
  const { rows } = await pool.query(
    `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 100000`,
    params
  );
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  let out = "﻿" + csvRow(["Время (UTC)", "Пользователь", "IP", "Действие", "Код действия", "Проект", "Цель", "Подробности"]);
  for (const r of rows) {
    out += csvRow([r.at.toISOString(), r.actor_login, r.ip, ACTIONS[r.action] || r.action, r.action, r.project_key || "", r.target, JSON.stringify(r.details)]);
  }
  res.send(out);
}));

async function purge() {
  const r = await pool.query("DELETE FROM audit_log WHERE at < now() - make_interval(days => $1)", [RETENTION_DAYS]);
  if (r.rowCount) console.log(`[audit] удалено старых записей: ${r.rowCount}`);
}

module.exports = { log, write, middleware, router, purge, ACTIONS, RETENTION_DAYS };
