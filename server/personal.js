// Персональные данные пользователей (152-ФЗ). Монтируется на /api/admin (только администратор).
//
// Что хранится о человеке: логин, имя, почта, роль, даты входа и регистрации, согласие на обработку,
// IP-адреса и браузер в сессиях и журнале аудита, его комментарии и авторство кейсов, багов, прогонов.
// - GET  /users/:login/personal-data — выгрузка всего этого одним JSON (ответ на запрос субъекта ПДн);
// - POST /users/:login/anonymize {confirm: login} — обезличивание: логин, имя, почта, IP и сессии удаляются
//   или заменяются, пользователь блокируется; кейсы, баги и история остаются, автором будет «Удалённый пользователь».
// IP-адреса в журнале аудита старше AUDIT_IP_DAYS (по умолчанию 180) обезличиваются при ежечасной уборке.
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const audit = require("./audit");
const { wrap, str } = require("./util");

const IP_DAYS = Number(process.env.AUDIT_IP_DAYS ?? 180);
const router = express.Router();

const iso = (d) => (d ? d.toISOString() : null);

router.get("/users/:login/personal-data", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, login, name, email, role, blocked, auth_provider, created_at, last_login_at, password_changed_at,
            pd_consent_at, anonymized_at, totp_enabled_at FROM users WHERE login=$1`,
    [str(req.params.login, 64)]
  );
  const u = rows[0];
  if (!u) return res.status(404).json({ error: "Пользователь не найден" });
  const q = (sql) => pool.query(sql, [u.id]).then((r) => r.rows);
  const [projects, sessions, tokens, auditRows, comments, authored] = await Promise.all([
    q("SELECT project_key, role FROM project_members WHERE user_id=$1 ORDER BY project_key"),
    q("SELECT created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id=$1 ORDER BY created_at DESC"),
    q("SELECT name, project_key, scopes, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC"),
    q("SELECT at, ip, action, project_key, target FROM audit_log WHERE actor_id=$1 ORDER BY at DESC LIMIT 5000"),
    q(`SELECT cm.created_at, cm.body, b.project_key || '-B' || b.num AS bug, c.project_key || '-' || c.num AS "case"
       FROM comments cm LEFT JOIN bugs b ON b.id=cm.bug_id LEFT JOIN test_cases c ON c.id=cm.case_id
       WHERE cm.author_id=$1 ORDER BY cm.created_at DESC`),
    q(`SELECT (SELECT count(*) FROM test_cases WHERE created_by=$1)::int AS cases,
              (SELECT count(*) FROM bugs WHERE created_by=$1)::int AS bugs,
              (SELECT count(*) FROM bugs WHERE assignee_id=$1)::int AS assigned_bugs,
              (SELECT count(*) FROM test_runs WHERE created_by=$1)::int AS runs,
              (SELECT count(*) FROM run_results WHERE executed_by=$1)::int AS results`),
  ]);
  audit.log(req, "user.personal_data", { project: null, target: u.login });
  const data = {
    exported: new Date().toISOString(),
    note: "Выгрузка персональных данных пользователя TestBall QA",
    profile: {
      login: u.login, name: u.name, email: u.email, role: u.role, blocked: u.blocked, provider: u.auth_provider,
      registered: iso(u.created_at), lastLogin: iso(u.last_login_at), passwordChanged: iso(u.password_changed_at),
      consent: iso(u.pd_consent_at), twoFactorSince: iso(u.totp_enabled_at), anonymized: iso(u.anonymized_at),
    },
    projects: projects.map((p) => ({ project: p.project_key, role: p.role })),
    sessions: sessions.map((s) => ({ created: iso(s.created_at), lastSeen: iso(s.last_seen_at), expires: iso(s.expires_at), ip: s.ip, browser: s.user_agent })),
    apiTokens: tokens.map((t) => ({ name: t.name, project: t.project_key, scopes: t.scopes, created: iso(t.created_at), lastUsed: iso(t.last_used_at), expires: iso(t.expires_at) })),
    auditLog: auditRows.map((a) => ({ at: iso(a.at), ip: a.ip, action: a.action, project: a.project_key, target: a.target })),
    comments: comments.map((c) => ({ at: iso(c.created_at), on: c.bug || c.case, text: c.body })),
    authorship: authored[0],
  };
  res.set("Content-Disposition", `attachment; filename="personal-data-${u.login}.json"`);
  res.json(data);
}));

router.post("/users/:login/anonymize", wrap(async (req, res) => {
  const login = str(req.params.login, 64);
  if (login === req.user.login) return res.status(409).json({ error: "Себя обезличить нельзя" });
  if (req.body.confirm !== login) return res.status(400).json({ error: `Для подтверждения передайте confirm: "${login}"` });
  const out = await tx(async (db) => {
    const { rows } = await db.query("SELECT id, role, anonymized_at FROM users WHERE login=$1 FOR UPDATE", [login]);
    const u = rows[0];
    if (!u) return { status: 404, error: "Пользователь не найден" };
    if (u.anonymized_at) return { status: 409, error: "Пользователь уже обезличен" };
    if (u.role === "admin") {
      const admins = await db.query("SELECT count(*)::int AS n FROM users WHERE role='admin' AND NOT blocked AND id<>$1", [u.id]);
      if (!admins.rows[0].n) return { status: 409, error: "Это последний администратор" };
    }
    const alias = `deleted-${u.id}`;
    await db.query(
      `UPDATE users SET login=$2, name='Удалённый пользователь', email='', blocked=true, role='viewer', password_hash='',
         totp_secret=NULL, totp_pending=NULL, totp_enabled_at=NULL, totp_last_step=NULL, last_login_at=NULL,
         pd_consent_at=NULL, anonymized_at=now() WHERE id=$1`,
      [u.id, alias]
    );
    for (const t of ["sessions", "api_tokens", "user_recovery_codes", "password_history", "project_members"]) {
      await db.query(`DELETE FROM ${t} WHERE user_id=$1`, [u.id]);
    }
    // журнал аудита сохраняется (это журнал безопасности), но без логина и IP человека
    await db.query("UPDATE audit_log SET actor_login=$2, ip='' WHERE actor_id=$1", [u.id, alias]);
    await db.query("UPDATE audit_log SET target=$2 WHERE target=$1 AND action LIKE ANY(ARRAY['auth.%','user.%'])", [login, alias]);
    return { alias };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  audit.log(req, "user.anonymize", { project: null, target: out.alias });
  broadcast("users");
  res.json({ ok: true, login: out.alias });
}));

// Уборка: IP-адреса в журнале аудита старше AUDIT_IP_DAYS
async function purgeIps() {
  if (!(IP_DAYS > 0)) return;
  await pool.query("UPDATE audit_log SET ip='' WHERE ip<>'' AND at < now() - make_interval(days => $1)", [IP_DAYS]);
}

module.exports = { router, purgeIps };
