// Комментарии к багам и тест-кейсам. Монтируется на /api/projects/:key
// Писать может любой участник проекта (и разработчик тоже), менять — только автор, удалять — автор или админ
const express = require("express");
const { pool } = require("./db");
const { broadcast } = require("./live");
const { isAdmin } = require("./access");
const { wrap, str, num } = require("./util");

const MAX = 10000;
const router = express.Router({ mergeParams: true });

function readText(body) {
  const text = str(body.text, MAX + 1);
  if (!text) return { error: "Напишите текст комментария" };
  if (text.length > MAX) return { error: `Комментарий длиннее ${MAX} символов` };
  return { text };
}

// К чему комментарий: баг или тест-кейс этого проекта
const OWNERS = {
  bugs: { table: "bugs", col: "bug_id", missing: "Баг не найден" },
  cases: { table: "test_cases", col: "case_id", missing: "Тест-кейс не найден" },
};

for (const [kind, o] of Object.entries(OWNERS)) {
  router.post(`/${kind}/:num/comments`, wrap(async (req, res) => {
    const { text, error } = readText(req.body);
    if (error) return res.status(400).json({ error });
    const { rows } = await pool.query(`SELECT id FROM ${o.table} WHERE project_key=$1 AND num=$2`, [req.params.key, num(req.params.num)]);
    if (!rows[0]) return res.status(404).json({ error: o.missing });
    const r = await pool.query(`INSERT INTO comments(${o.col}, author_id, body) VALUES ($1,$2,$3) RETURNING id`, [rows[0].id, req.user.id, text]);
    broadcast("comments");
    res.status(201).json({ id: r.rows[0].id });
  }));
}

// Комментарий этого проекта; из чужого проекта — как несуществующий
async function findComment(key, id) {
  const { rows } = await pool.query(
    `SELECT cm.id, cm.author_id FROM comments cm
     LEFT JOIN bugs b ON b.id=cm.bug_id LEFT JOIN test_cases c ON c.id=cm.case_id
     WHERE cm.id=$1 AND COALESCE(b.project_key, c.project_key)=$2`,
    [id, key]
  );
  return rows[0];
}

router.patch("/comments/:id", wrap(async (req, res) => {
  const cm = await findComment(req.params.key, num(req.params.id));
  if (!cm) return res.status(404).json({ error: "Комментарий не найден" });
  if (cm.author_id !== req.user.id) return res.status(403).json({ error: "Изменить комментарий может только его автор" });
  const { text, error } = readText(req.body);
  if (error) return res.status(400).json({ error });
  await pool.query("UPDATE comments SET body=$1, edited_at=now() WHERE id=$2", [text, cm.id]);
  broadcast("comments");
  res.json({ ok: true });
}));

router.delete("/comments/:id", wrap(async (req, res) => {
  const cm = await findComment(req.params.key, num(req.params.id));
  if (!cm) return res.status(404).json({ error: "Комментарий не найден" });
  if (cm.author_id !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: "Удалить комментарий может только его автор или администратор" });
  await pool.query("DELETE FROM comments WHERE id=$1", [cm.id]);
  broadcast("comments");
  res.json({ ok: true });
}));

module.exports = router;
