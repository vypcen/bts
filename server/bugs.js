// Баг-репорты. Монтируется на /api/projects/:key
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { wrap, str, num } = require("./util");

const SEVERITIES = ["blocker", "critical", "major", "minor"];
// Допустимые переходы жизненного цикла. Тот же список есть в web/src/labels.ts
const FLOW = {
  new: ["in_progress", "rejected", "duplicate"],
  in_progress: ["fixed", "new", "rejected"],
  fixed: ["verified", "in_progress"],
  verified: ["closed", "in_progress"],
  closed: ["in_progress"],
  rejected: ["new"],
  duplicate: ["new"],
};
const LABELS = { new: "Новый", in_progress: "В работе", fixed: "Исправлен", verified: "Проверен", closed: "Закрыт", rejected: "Отклонён", duplicate: "Дубликат" };

const router = express.Router({ mergeParams: true });

// Исполнитель — участник проекта или админ. undefined — такого нет
async function userId(db, key, login) {
  if (!login) return null;
  const { rows } = await db.query(
    `SELECT id FROM users u WHERE login=$1 AND NOT blocked
       AND (role='admin' OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.project_key=$2))`,
    [login, key]
  );
  return rows[0] ? rows[0].id : undefined;
}

function readBug(body) {
  const b = {
    title: str(body.title, 500),
    severity: str(body.severity, 20),
    assignee: str(body.assignee, 64),
    env: str(body.env, 500),
    steps: str(body.steps),
    actual: str(body.actual),
    expected: str(body.expected),
  };
  if (!b.title) return { error: "Укажите заголовок бага" };
  if (!SEVERITIES.includes(b.severity)) return { error: "Неизвестная серьёзность" };
  return { b };
}

router.post("/bugs", wrap(async (req, res) => {
  const { b, error } = readBug(req.body);
  if (error) return res.status(400).json({ error });
  const key = req.params.key;
  const out = await tx(async (db) => {
    const assignee = await userId(db, key, b.assignee);
    if (assignee === undefined) return { status: 400, error: "Исполнитель не найден среди участников проекта" };
    // связь с кейсом и, если баг заведён из прогона, с конкретным результатом
    let caseId = null, resultId = null;
    if (req.body.caseNum != null) {
      const c = await db.query("SELECT id FROM test_cases WHERE project_key=$1 AND num=$2", [key, num(req.body.caseNum)]);
      if (!c.rows[0]) return { status: 400, error: "Связанный тест-кейс не найден" };
      caseId = c.rows[0].id;
      if (req.body.runNum != null) {
        const r = await db.query(
          "SELECT rr.id FROM run_results rr JOIN test_runs t ON t.id=rr.run_id WHERE t.project_key=$1 AND t.num=$2 AND rr.case_id=$3",
          [key, num(req.body.runNum), caseId]
        );
        if (!r.rows[0]) return { status: 400, error: "Кейс не входит в указанный прогон" };
        resultId = r.rows[0].id;
      }
    }
    const seq = await db.query("UPDATE projects SET bug_seq=bug_seq+1 WHERE key=$1 RETURNING bug_seq", [key]);
    if (!seq.rows[0]) return { status: 404, error: "Проект не найден" };
    const n = seq.rows[0].bug_seq;
    await db.query(
      `INSERT INTO bugs(project_key, num, title, severity, assignee_id, environment, steps, actual, expected,
         case_id, run_result_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [key, n, b.title, b.severity, assignee, b.env, b.steps, b.actual, b.expected, caseId, resultId, req.user.id]
    );
    return { n };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  broadcast("bugs");
  res.status(201).json({ num: out.n });
}));

router.patch("/bugs/:num", wrap(async (req, res) => {
  const key = req.params.key, n = num(req.params.num);
  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.severity, u.login AS assignee, b.assignee_id, b.environment AS env, b.steps, b.actual, b.expected,
       b.status, b.duplicate_of
     FROM bugs b LEFT JOIN users u ON u.id=b.assignee_id WHERE b.project_key=$1 AND b.num=$2`,
    [key, n]
  );
  const cur = rows[0];
  if (!cur) return res.status(404).json({ error: "Баг не найден" });
  // частичное обновление: можно прислать только status или assignee
  const { b, error } = readBug({ ...cur, assignee: cur.assignee || "", ...req.body });
  if (error) return res.status(400).json({ error });
  // прежнего исполнителя, которого с тех пор убрали из проекта, можно оставить
  const assignee = b.assignee === cur.assignee ? cur.assignee_id : await userId(pool, key, b.assignee);
  if (assignee === undefined) return res.status(400).json({ error: "Исполнитель не найден среди участников проекта" });

  const status = req.body.status === undefined ? cur.status : str(req.body.status, 20);
  if (status !== cur.status && !(FLOW[cur.status] || []).includes(status)) {
    return res.status(409).json({ error: `Нельзя перевести баг из «${LABELS[cur.status]}» в «${LABELS[status] || status}»` });
  }
  let dup = null;
  if (status === "duplicate") {
    if (req.body.duplicateOf == null && cur.duplicate_of) dup = cur.duplicate_of;
    else {
      const d = await pool.query("SELECT id FROM bugs WHERE project_key=$1 AND num=$2", [key, num(req.body.duplicateOf)]);
      if (!d.rows[0]) return res.status(400).json({ error: "Укажите баг, дубликатом которого является этот" });
      if (d.rows[0].id === cur.id) return res.status(400).json({ error: "Баг не может быть дубликатом самого себя" });
      dup = d.rows[0].id;
    }
  }
  await pool.query(
    `UPDATE bugs SET title=$1, severity=$2, assignee_id=$3, environment=$4, steps=$5, actual=$6, expected=$7,
       status=$8, duplicate_of=$9, updated_by=$10, updated_at=now() WHERE id=$11`,
    [b.title, b.severity, assignee, b.env, b.steps, b.actual, b.expected, status, dup, req.user.id, cur.id]
  );
  broadcast("bugs");
  res.json({ ok: true });
}));

router.delete("/bugs/:num", wrap(async (req, res) => {
  const r = await pool.query("DELETE FROM bugs WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  if (!r.rowCount) return res.status(404).json({ error: "Баг не найден" });
  broadcast("bugs");
  res.json({ ok: true });
}));

module.exports = router;
