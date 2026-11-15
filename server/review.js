// Ревью и согласование тест-кейсов (D-08). Монтируется на /api/projects/:key.
// Автор отправляет кейс на ревью (статус «На ревью») одному или нескольким рецензентам или любому с правом
// cases.review. Рецензент утверждает (когда утвердили все назначенные — кейс «Готов») или возвращает на доработку
// с комментарием (кейс снова «Черновик»). Своё ревью утвердить нельзя.
// Режим проекта review_required: «Готов» — только через ревью (или рецензентом), правка готового кейса возвращает его в черновик.
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const access = require("./access");
const roles = require("./roles");
const events = require("./events");
const casemodel = require("./casemodel");
const { wrap, str, num } = require("./util");

const router = express.Router({ mergeParams: true });

const required = async (db, key) => (await db.query("SELECT review_required FROM projects WHERE key=$1", [key])).rows[0]?.review_required === true;

// Проверка смены статуса при сохранении кейса. prev — кейс до правки, next — после (status, title, pre, …).
// Возвращает {status} — итоговый статус, или {error}
async function gateStatus(req, prev, next) {
  const key = req.params.key;
  if (next.status === "review" && prev?.status !== "review") return { error: "На ревью кейс отправляется кнопкой «Отправить на ревью»" };
  const policy = await required(pool, key);
  const reviewer = access.can(req.projectRole, "cases.review");
  if (policy && !reviewer && next.status === "ready" && prev?.status !== "ready") {
    return { error: "В этом проекте кейс становится готовым только после ревью: отправьте его на ревью" };
  }
  if (policy && !reviewer && prev?.status === "ready" && next.status === "ready" && contentChanged(prev, next)) {
    return { status: "draft", reset: true };
  }
  return { status: next.status };
}
const contentChanged = (a, b) =>
  a.title !== b.title || (a.pre ?? a.preconditions) !== (b.pre ?? b.preconditions) || a.expected !== b.expected || a.steps !== b.steps || a.kind !== b.kind
  || JSON.stringify(casemodel.normalizeSteps(a.step_list ?? a.stepList ?? []) || []) !== JSON.stringify(b.stepList || []);

// Кейс ушёл со статуса «На ревью» правкой или массовой сменой статуса — незавершённые заявки отменяются
const cancelPending = (db, caseIds) =>
  db.query("UPDATE case_reviews SET status='cancelled', decided_at=now() WHERE case_id = ANY($1::int[]) AND status='pending'", [caseIds]);

// Кто может быть рецензентом: участник проекта (или админ), у роли которого есть cases.review
async function reviewers(key, logins) {
  await roles.load();
  const { rows } = await pool.query(
    `SELECT u.id, u.login, u.name, u.role AS global_role, m.role AS project_role, (m.user_id IS NOT NULL) AS member
     FROM users u LEFT JOIN project_members m ON m.user_id=u.id AND m.project_key=$1 WHERE u.login = ANY($2::text[]) AND NOT u.blocked`,
    [key, logins]
  );
  const out = [];
  for (const login of logins) {
    const u = rows.find((r) => r.login === login);
    const role = !u ? null : u.global_role === "admin" ? "admin" : u.member ? u.project_role || u.global_role : null;
    if (!role) return { error: `${login}: нет доступа к проекту` };
    if (!roles.can(role, "cases.review")) return { error: `${u.name}: у роли нет права проводить ревью` };
    out.push(u);
  }
  return { users: out };
}

const reviewOut = (r) => ({
  id: r.id, version: r.case_version, status: r.status, reviewer: r.reviewer_login || null, requestedBy: r.requested_login || null,
  requestComment: r.request_comment, comment: r.comment, decidedBy: r.decided_login || null,
  created: r.created_at.getTime(), decided: r.decided_at ? r.decided_at.getTime() : null,
});
const reviewSql = `SELECT r.*, ru.login AS reviewer_login, qu.login AS requested_login, du.login AS decided_login FROM case_reviews r
  LEFT JOIN users ru ON ru.id=r.reviewer_id LEFT JOIN users qu ON qu.id=r.requested_by LEFT JOIN users du ON du.id=r.decided_by`;

// История ревью кейса
router.get("/cases/:num(\\d+)/reviews", wrap(async (req, res) => {
  const { rows } = await pool.query(`${reviewSql} JOIN test_cases c ON c.id=r.case_id WHERE c.project_key=$1 AND c.num=$2 ORDER BY r.created_at DESC, r.id DESC LIMIT 50`,
    [req.params.key, num(req.params.num)]);
  res.json({ reviews: rows.map(reviewOut), required: await required(pool, req.params.key) });
}));

// Отправить на ревью: {reviewers: ["petrova"], comment: "…"}; без рецензентов — любому с правом ревью
router.post("/cases/:num(\\d+)/review", wrap(async (req, res) => {
  const key = req.params.key;
  const logins = [...new Set((Array.isArray(req.body.reviewers) ? req.body.reviewers : []).map((l) => str(String(l), 64).toLowerCase()).filter(Boolean))].slice(0, 10);
  if (logins.includes(req.user.login)) return res.status(400).json({ error: "Себя рецензентом назначить нельзя" });
  const rv = await reviewers(key, logins);
  if (rv.error) return res.status(400).json({ error: rv.error });
  const out = await tx(async (db) => {
    const { rows } = await db.query("SELECT id, version, status, kind FROM test_cases WHERE project_key=$1 AND num=$2 FOR UPDATE", [key, num(req.params.num)]);
    const c = rows[0];
    if (!c) return { status: 404, error: "Тест-кейс не найден" };
    if (c.status === "deprecated") return { status: 409, error: "Устаревший кейс на ревью не отправляется" };
    await db.query("UPDATE case_reviews SET status='cancelled', decided_at=now() WHERE case_id=$1 AND status='pending'", [c.id]);
    // смена статуса — новая версия кейса (как при ручной правке); ревью привязано к ней
    const version = (await db.query("UPDATE test_cases SET status='review', updated_by=$2, updated_at=now() WHERE id=$1 RETURNING version", [c.id, req.user.id])).rows[0].version;
    const ids = rv.users.length ? rv.users.map((u) => u.id) : [null];
    for (const id of ids) {
      await db.query("INSERT INTO case_reviews(case_id, case_version, requested_by, reviewer_id, request_comment) VALUES ($1,$2,$3,$4,$5)",
        [c.id, version, req.user.id, id, str(req.body.comment, 2000)]);
    }
    return { version };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  broadcast("cases");
  events.emit(key, "case.review_requested", { case: await events.snap.testCase(key, num(req.params.num)), reviewers: logins }, req.user);
  res.status(201).json({ ok: true });
}));

// Решение рецензента: {decision: "approve" | "changes", comment}
router.post("/cases/:num(\\d+)/review/decision", wrap(async (req, res) => {
  const key = req.params.key;
  const decision = req.body.decision;
  if (!["approve", "changes"].includes(decision)) return res.status(400).json({ error: "decision: approve или changes" });
  const comment = str(req.body.comment, 2000);
  if (decision === "changes" && !comment) return res.status(400).json({ error: "Напишите, что поправить" });
  const out = await tx(async (db) => {
    const { rows } = await db.query("SELECT id, status FROM test_cases WHERE project_key=$1 AND num=$2 FOR UPDATE", [key, num(req.params.num)]);
    const c = rows[0];
    if (!c) return { status: 404, error: "Тест-кейс не найден" };
    const pending = (await db.query("SELECT id, reviewer_id, requested_by FROM case_reviews WHERE case_id=$1 AND status='pending' ORDER BY id", [c.id])).rows;
    if (c.status !== "review" || !pending.length) return { status: 409, error: "Кейс не на ревью" };
    if (pending.every((p) => p.requested_by === req.user.id)) return { status: 409, error: "Своё ревью утвердить или вернуть нельзя" };
    // своя заявка; если назначены другие рецензенты, а не я — нельзя; заявка «любому» подходит всем
    const mine = pending.find((p) => p.reviewer_id === req.user.id) || pending.find((p) => p.reviewer_id === null);
    if (!mine) return { status: 403, error: "Кейс отправлен на ревью другим рецензентам" };
    await db.query("UPDATE case_reviews SET status=$2, comment=$3, decided_by=$4, decided_at=now() WHERE id=$1",
      [mine.id, decision === "approve" ? "approved" : "changes", comment, req.user.id]);
    let status = "review";
    if (decision === "changes") {
      await db.query("UPDATE case_reviews SET status='cancelled', decided_at=now() WHERE case_id=$1 AND status='pending'", [c.id]);
      status = "draft";
    } else if (pending.length === 1) status = "ready"; // утвердили все назначенные
    if (status !== "review") await db.query("UPDATE test_cases SET status=$2, updated_by=$3, updated_at=now() WHERE id=$1", [c.id, status, req.user.id]);
    return { status, left: decision === "approve" ? pending.length - 1 : 0 };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  broadcast("cases");
  events.emit(key, "case.reviewed", { case: await events.snap.testCase(key, num(req.params.num)), decision, comment }, req.user);
  res.json(out);
}));

// Мне на ревью: кейсы проекта, ожидающие моего решения (назначенные мне или «любому»)
router.get("/reviews", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.id) c.num, c.title, r.created_at, qu.login AS requested_by, r.reviewer_id
     FROM case_reviews r JOIN test_cases c ON c.id=r.case_id LEFT JOIN users qu ON qu.id=r.requested_by
     WHERE c.project_key=$1 AND r.status='pending' AND (r.reviewer_id=$2 OR (r.reviewer_id IS NULL AND r.requested_by IS DISTINCT FROM $2))
     ORDER BY c.id, r.created_at`,
    [req.params.key, req.user.id]
  );
  res.json({ items: rows.map((r) => ({ num: r.num, title: r.title, requestedBy: r.requested_by, since: r.created_at.getTime(), assigned: r.reviewer_id !== null })) });
}));

// Кого можно назначить рецензентом: участники проекта и админы с правом cases.review
router.get("/reviewers", wrap(async (req, res) => {
  await roles.load();
  const { rows } = await pool.query(
    `SELECT u.login, u.name, CASE WHEN u.role='admin' THEN 'admin' ELSE COALESCE(m.role, u.role) END AS role
     FROM users u LEFT JOIN project_members m ON m.user_id=u.id AND m.project_key=$1
     WHERE NOT u.blocked AND (u.role='admin' OR m.user_id IS NOT NULL) ORDER BY u.name`, [req.params.key]);
  res.json({ reviewers: rows.filter((r) => roles.can(r.role, "cases.review")).map((r) => ({ login: r.login, name: r.name })) });
}));

// Режим проекта «готов только после ревью»
router.put("/review-settings", wrap(async (req, res) => {
  if (typeof req.body.required !== "boolean") return res.status(400).json({ error: "required: true или false" });
  await pool.query("UPDATE projects SET review_required=$2 WHERE key=$1", [req.params.key, req.body.required]);
  broadcast("projects");
  res.json({ ok: true });
}));

module.exports = { router, gateStatus, required, cancelPending };
