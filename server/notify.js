// Уведомления (I-01, I-02, I-03): в приложении (колокольчик) и письмом.
// Кого уведомлять, решают маршруты: назначили баг или кейсы прогона, сменился статус бага, новый комментарий,
// @упоминание, заявка и решение ревью. Сам себе человек уведомлений не получает. Письма уходят через очередь задач,
// если настроен SMTP (SMTP_URL) и у пользователя есть адрес и не выключены письма.
const express = require("express");
const { pool } = require("./db");
const jobs = require("./jobs");
const { wrap, num, str } = require("./util");

const KINDS = {
  assigned: "Назначили мне",
  mention: "Упомянули меня",
  status: "Статус бага, за которым слежу",
  comment: "Комментарии в том, за чем слежу",
  review: "Ревью кейсов",
  run: "Кейсы в прогоне назначили мне",
};
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const smtpOn = () => Boolean(process.env.SMTP_URL);

// recipients — id пользователей; actor — req.user (ему не шлём); n — {key, kind, title, body, link}
async function send(recipients, n, actor) {
  const ids = [...new Set(recipients.filter((id) => id && id !== actor?.id))];
  if (!ids.length) return 0;
  // только активные пользователи с доступом к проекту (или админы) и не выключившие этот вид
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.notify_prefs FROM users u
     WHERE u.id = ANY($1::int[]) AND NOT u.blocked
       AND (u.role='admin' OR $2::text IS NULL OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.project_key=$2))
       AND NOT (COALESCE(u.notify_prefs->'off', '[]'::jsonb) ? $3)`,
    [ids, n.key || null, n.kind]);
  for (const u of rows) {
    const { rows: ins } = await pool.query(
      "INSERT INTO notifications(user_id, project_key, kind, title, body, link, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [u.id, n.key || null, n.kind, str(n.title, 500), str(n.body, 2000), n.link || "", actor?.id || null]);
    if (smtpOn() && u.email && u.notify_prefs?.email !== false) await jobs.enqueue("notify.email", { id: ins[0].id });
  }
  return rows.length;
}

// --- подписки ---
async function watch(userIds, { bugId, caseId }) {
  for (const id of new Set(userIds.filter(Boolean))) {
    await pool.query(
      bugId ? "INSERT INTO watches(user_id, bug_id) VALUES ($1,$2) ON CONFLICT (user_id, bug_id) WHERE bug_id IS NOT NULL DO NOTHING"
        : "INSERT INTO watches(user_id, case_id) VALUES ($1,$2) ON CONFLICT (user_id, case_id) WHERE case_id IS NOT NULL DO NOTHING",
      [id, bugId || caseId]);
  }
}
async function watchers({ bugId, caseId }) {
  const { rows } = await pool.query(`SELECT user_id FROM watches WHERE ${bugId ? "bug_id" : "case_id"}=$1 AND NOT muted`, [bugId || caseId]);
  return rows.map((r) => r.user_id);
}

// @логин в тексте → id участников проекта (и админов)
async function mentioned(key, text) {
  const logins = [...new Set([...String(text).matchAll(/(^|[^\w.@-])@([a-z0-9][a-z0-9._-]{1,31})/gi)].map((m) => m[2].toLowerCase().replace(/[._-]+$/, "")))];
  if (!logins.length) return [];
  const { rows } = await pool.query(
    `SELECT u.id FROM users u WHERE lower(u.login) = ANY($2::text[]) AND NOT u.blocked
       AND (u.role='admin' OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.project_key=$1))`, [key, logins]);
  return rows.map((r) => r.id);
}

const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- поводы ---
async function onComment(req, { kind, ownerId, ownerNum, title, text }) {
  const key = req.params.key;
  const ref = kind === "bugs" ? { bugId: ownerId } : { caseId: ownerId };
  const label = kind === "bugs" ? `${key}-B${ownerNum}` : `${key}-${ownerNum}`;
  const link = `p/${key}/${kind}/${ownerNum}`;
  const mentions = await mentioned(key, text);
  await send(mentions, { key, kind: "mention", title: `${req.user.name} упомянул(а) вас в ${label}: ${title}`, body: short(text), link }, req.user);
  const others = (await watchers(ref)).filter((id) => !mentions.includes(id));
  await send(others, { key, kind: "comment", title: `Комментарий в ${label}: ${title}`, body: `${req.user.name}: ${short(text)}`, link }, req.user);
  await watch([req.user.id], ref);
}

async function onBugCreated(req, { bugId, num: n, title, assigneeId }) {
  const key = req.params.key;
  await watch([req.user.id, assigneeId], { bugId });
  if (assigneeId) await send([assigneeId], { key, kind: "assigned", title: `Вам назначен баг ${key}-B${n}: ${title}`, link: `p/${key}/bugs/${n}` }, req.user);
}
async function onBugAssigned(req, { bugId, num: n, title, assigneeId }) {
  const key = req.params.key;
  if (!assigneeId) return;
  await watch([assigneeId], { bugId });
  await send([assigneeId], { key, kind: "assigned", title: `Вам назначен баг ${key}-B${n}: ${title}`, link: `p/${key}/bugs/${n}` }, req.user);
}
const STATUS = { new: "Новый", in_progress: "В работе", fixed: "Исправлен", verified: "Проверен", closed: "Закрыт", rejected: "Отклонён", duplicate: "Дубликат" };
async function onBugStatus(req, { bugId, num: n, title, from, to }) {
  const key = req.params.key;
  await send(await watchers({ bugId }), { key, kind: "status", title: `${key}-B${n}: ${STATUS[from] || from} → ${STATUS[to] || to}`, body: `${title} · ${req.user.name}`, link: `p/${key}/bugs/${n}` }, req.user);
}
async function onReviewRequested(req, { num: n, title, reviewerIds }) {
  const key = req.params.key;
  await send(reviewerIds, { key, kind: "review", title: `Кейс ${key}-${n} на ревью: ${title}`, body: `Отправил(а) ${req.user.name}`, link: `p/${key}/cases/${n}` }, req.user);
}
async function onReviewed(req, { num: n, title, requesterIds, decision, status, comment }) {
  const key = req.params.key;
  const what = decision === "approve" ? (status === "ready" ? "утверждён" : "утверждён частью рецензентов") : "возвращён на доработку";
  await send(requesterIds, { key, kind: "review", title: `Кейс ${key}-${n} ${what}: ${title}`, body: comment ? `${req.user.name}: ${short(comment)}` : `Рецензент: ${req.user.name}`, link: `p/${key}/cases/${n}` }, req.user);
}
// после распределения: каждому исполнителю — сколько непроверенных кейсов прогона теперь на нём
async function onRunAssigned(req, { runId, logins, key = req.params.key }) {
  const { rows } = await pool.query(
    `SELECT u.id, count(*)::int AS n, t.num, t.title FROM run_results rr JOIN users u ON u.id=rr.assignee_id JOIN test_runs t ON t.id=rr.run_id
     WHERE rr.run_id=$1 AND rr.result='untested' AND u.login = ANY($2::text[]) GROUP BY u.id, t.num, t.title`, [runId, logins]);
  for (const r of rows) {
    await send([r.id], { key, kind: "run", title: `Вам назначены кейсы в прогоне ${key}-R${r.num}: ${r.n}`, body: r.title, link: `p/${key}/runs/${r.num}` }, req.user);
  }
}

// --- письма ---
let transport = null;
function mailer() {
  if (!transport) transport = require("nodemailer").createTransport(process.env.SMTP_URL);
  return transport;
}
jobs.define("notify.email", async ({ id }) => {
  const { rows } = await pool.query(
    `SELECT n.*, u.email, u.name AS user_name, a.name AS actor_name, p.name AS project_name FROM notifications n JOIN users u ON u.id=n.user_id
     LEFT JOIN users a ON a.id=n.actor_id LEFT JOIN projects p ON p.key=n.project_key WHERE n.id=$1`, [id]);
  const n = rows[0];
  if (!n || !n.email || n.read_at) return; // прочитал в приложении — письмо уже не нужно
  const url = PUBLIC_URL && n.link ? `${PUBLIC_URL}/#/${n.link}` : "";
  const text = [n.title, n.body, url && `Открыть: ${url}`, "", `TestBall QA${n.project_name ? ` · ${n.project_name}` : ""}. Настроить уведомления: значок колокольчика → «Настройки».`].filter((x) => x !== "" && x != null).join("\n\n");
  await mailer().sendMail({ from: process.env.SMTP_FROM || "TestBall QA <testball@localhost>", to: n.email, subject: n.title, text });
}, { maxAttempts: 5, title: "Письмо с уведомлением" });

// --- API: /api/notifications (монтируется на этот путь) ---
const router = express.Router();
const out = (r) => ({ id: Number(r.id), project: r.project_key, kind: r.kind, title: r.title, body: r.body, link: r.link, actor: r.actor_login || null, created: r.created_at.getTime(), read: Boolean(r.read_at) });

router.get("/", wrap(async (req, res) => {
  const unreadOnly = req.query.unread === "1";
  const [{ rows }, cnt] = await Promise.all([
    pool.query(`SELECT n.*, a.login AS actor_login FROM notifications n LEFT JOIN users a ON a.id=n.actor_id
                WHERE n.user_id=$1 ${unreadOnly ? "AND n.read_at IS NULL" : ""} ORDER BY n.created_at DESC, n.id DESC LIMIT 50`, [req.user.id]),
    pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [req.user.id]),
  ]);
  res.json({ items: rows.map(out), unread: cnt.rows[0].n });
}));

// {"ids": [1, 2]} или {"all": true}
router.post("/read", wrap(async (req, res) => {
  if (req.body.all === true) await pool.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [req.user.id]);
  else {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(num).filter(Boolean).slice(0, 500);
    if (ids.length) await pool.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2::bigint[]) AND read_at IS NULL", [req.user.id, ids]);
  }
  res.json({ ok: true });
}));

router.get("/settings", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT email, notify_prefs FROM users WHERE id=$1", [req.user.id]);
  const p = rows[0].notify_prefs || {};
  res.json({ email: rows[0].email || "", emailOn: p.email !== false, off: p.off || [], kinds: KINDS, smtp: smtpOn() });
}));

// {"email": "ivanova@company.ru", "emailOn": true, "off": ["comment"]}
router.put("/settings", wrap(async (req, res) => {
  const off = (Array.isArray(req.body.off) ? req.body.off : []).filter((k) => KINDS[k]);
  const sets = ["notify_prefs=$2"];
  const params = [req.user.id, JSON.stringify({ email: req.body.emailOn !== false, off })];
  if (req.body.email !== undefined) {
    const email = str(req.body.email, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Адрес почты выглядит неверно" });
    // у пользователей из SSO/LDAP адрес приходит из каталога и при входе обновится оттуда
    sets.push(`email=$${params.push(email)}`);
  }
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id=$1`, params);
  res.json({ ok: true });
}));

// Подписка: /api/projects/:key/watch?kind=bugs&num=3 (GET — статус), POST {kind, num, watching}
const projectRouter = express.Router({ mergeParams: true });
async function ownerId(key, kind, n) {
  if (!["bugs", "cases"].includes(kind)) return null;
  const { rows } = await pool.query(`SELECT id FROM ${kind === "bugs" ? "bugs" : "test_cases"} WHERE project_key=$1 AND num=$2`, [key, num(n)]);
  return rows[0]?.id ?? null;
}
projectRouter.get("/watch", wrap(async (req, res) => {
  const id = await ownerId(req.params.key, req.query.kind, req.query.num);
  if (!id) return res.status(404).json({ error: "Не найдено" });
  const col = req.query.kind === "bugs" ? "bug_id" : "case_id";
  const { rows } = await pool.query(`SELECT muted FROM watches WHERE user_id=$1 AND ${col}=$2`, [req.user.id, id]);
  const count = (await pool.query(`SELECT count(*)::int AS n FROM watches WHERE ${col}=$1 AND NOT muted`, [id])).rows[0].n;
  res.json({ watching: Boolean(rows[0] && !rows[0].muted), watchers: count });
}));
projectRouter.post("/watch", wrap(async (req, res) => {
  const id = await ownerId(req.params.key, req.body.kind, req.body.num);
  if (!id) return res.status(404).json({ error: "Не найдено" });
  const col = req.body.kind === "bugs" ? "bug_id" : "case_id";
  await pool.query(
    `INSERT INTO watches(user_id, ${col}, muted) VALUES ($1,$2,$3) ON CONFLICT (user_id, ${col}) WHERE ${col} IS NOT NULL DO UPDATE SET muted=$3`,
    [req.user.id, id, req.body.watching === false]);
  res.json({ ok: true, watching: req.body.watching !== false });
}));

module.exports = { router, projectRouter, send, watch, mentioned, onComment, onBugCreated, onBugAssigned, onBugStatus, onReviewRequested, onReviewed, onRunAssigned, KINDS };
