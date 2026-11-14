// Списки с постраничной выдачей, фильтрами и поиском — для больших проектов, интеграций и глобального поиска.
//   GET /api/projects/:key/cases?q=&folder=&priority=&status=&kind=&limit=&after=
//   GET /api/projects/:key/bugs?q=&status=&severity=&assignee=&limit=&after=
//   GET /api/projects/:key/runs?state=&q=&limit=&after=
//   GET /api/search?q=&limit=        — поиск по всем доступным проектам: кейсы, баги, прогоны, автотесты
// Курсор — номер последней записи (after=<num>), ответ: {items, next, total?}. total — только с count=1.
// q понимает ID («LK-12», «LK-B7», «LK-R3», «12») и обычный текст с русской морфологией.
const express = require("express");
const { pool } = require("./db");
const access = require("./access");
const state = require("./state");
const { wrap, num, ms } = require("./util");

const MAX_LIMIT = 500;
const limitOf = (v, def = 50) => Math.min(MAX_LIMIT, Math.max(1, num(v) || def));
const listOf = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean));

// Номер из «LK-12» / «LK-B7» / «12» для поиска по ID
function idNum(q, letter = "") {
  const m = String(q).trim().match(new RegExp(`^(?:[A-Za-z]{2,6}-)?${letter}(\\d+)$`, "i"));
  return m ? Number(m[1]) : null;
}

// Условие поиска: полнотекстовый поиск или подстрока в названии (короткие и не словарные запросы)
function textCond(q, col, titleCol, params) {
  params.push(q);
  const p = params.length;
  return `(${col} @@ websearch_to_tsquery('russian', $${p}) OR ${titleCol} ILIKE '%' || replace(replace($${p}, '%', '\\%'), '_', '\\_') || '%')`;
}

async function page(sql, params, req, mapRow, countSql) {
  const limit = limitOf(req.query.limit);
  const { rows } = await pool.query(`${sql} LIMIT ${limit + 1}`, params);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(mapRow);
  const out = { items, next: more ? String(items[items.length - 1].num) : null };
  if (req.query.count === "1" && countSql) out.total = (await pool.query(countSql.sql, countSql.params)).rows[0].n;
  return out;
}

const router = express.Router({ mergeParams: true });

router.get("/cases", wrap(async (req, res) => {
  const params = [req.params.key];
  const where = ["c.project_key=$1"];
  const q = String(req.query.q || "").trim();
  if (q) {
    const n = idNum(q);
    if (n) where.push(`c.num = ${n}`);
    else where.push(textCond(q, "c.search", "c.title", params));
  }
  if (req.query.folder === "none") where.push("c.folder_id IS NULL");
  else if (num(req.query.folder)) {
    params.push(num(req.query.folder));
    // папка вместе с подпапками
    where.push(`c.folder_id IN (WITH RECURSIVE f AS (SELECT id FROM case_folders WHERE id=$${params.length} AND project_key=$1
                UNION ALL SELECT cf.id FROM case_folders cf JOIN f ON cf.parent_id=f.id) SELECT id FROM f)`);
  }
  for (const [field, col] of [["priority", "c.priority"], ["status", "c.status"], ["kind", "c.kind"]]) {
    const vals = listOf(req.query[field]);
    if (vals.length) {
      params.push(vals);
      where.push(`${col} = ANY($${params.length}::text[])`);
    }
  }
  const countSql = { sql: `SELECT count(*)::int AS n FROM test_cases c WHERE ${where.join(" AND ")}`, params: [...params] };
  if (num(req.query.after)) {
    params.push(num(req.query.after));
    where.push(`c.num > $${params.length}`);
  }
  res.json(await page(`${state.caseSql} WHERE ${where.join(" AND ")} ORDER BY c.num`, params, req, state.toCase, countSql));
}));

const bugSql = `SELECT b.project_key, b.num, b.title, b.status, b.severity, au.login AS assignee, b.environment, b.steps, b.actual, b.expected,
    c.num AS case_num, b.created_at, b.updated_at, cu.login AS created_by, b.external_key, b.external_url, b.external_status
  FROM bugs b LEFT JOIN users au ON au.id=b.assignee_id LEFT JOIN test_cases c ON c.id=b.case_id LEFT JOIN users cu ON cu.id=b.created_by`;
const toBug = (b) => ({
  id: `${b.project_key}-B${b.num}`, pid: b.project_key, num: b.num, title: b.title, status: b.status, severity: b.severity, assignee: b.assignee,
  env: b.environment, steps: b.steps, actual: b.actual, expected: b.expected, caseNum: b.case_num, createdBy: b.created_by,
  created: ms(b.created_at), updated: ms(b.updated_at),
  external: b.external_key ? { key: b.external_key, url: b.external_url, status: b.external_status || "" } : null,
});

router.get("/bugs", wrap(async (req, res) => {
  const params = [req.params.key];
  const where = ["b.project_key=$1"];
  const q = String(req.query.q || "").trim();
  if (q) {
    const n = idNum(q, "B?");
    if (n) where.push(`b.num = ${n}`);
    else where.push(textCond(q, "b.search", "b.title", params));
  }
  for (const [field, col] of [["status", "b.status"], ["severity", "b.severity"]]) {
    const vals = listOf(req.query[field]);
    if (vals.length) {
      params.push(vals);
      where.push(`${col} = ANY($${params.length}::text[])`);
    }
  }
  if (req.query.assignee !== undefined) {
    if (req.query.assignee === "") where.push("b.assignee_id IS NULL");
    else {
      params.push(String(req.query.assignee).toLowerCase());
      where.push(`au.login = $${params.length}`);
    }
  }
  const countSql = { sql: `SELECT count(*)::int AS n FROM bugs b LEFT JOIN users au ON au.id=b.assignee_id WHERE ${where.join(" AND ")}`, params: [...params] };
  if (num(req.query.after)) {
    params.push(num(req.query.after));
    where.push(`b.num > $${params.length}`);
  }
  res.json(await page(`${bugSql} WHERE ${where.join(" AND ")} ORDER BY b.num`, params, req, toBug, countSql));
}));

router.get("/runs", wrap(async (req, res) => {
  const params = [req.params.key];
  const where = ["r.project_key=$1"];
  if (["open", "closed"].includes(req.query.state)) {
    params.push(req.query.state);
    where.push(`r.state = $${params.length}`);
  }
  const q = String(req.query.q || "").trim();
  if (q) {
    const n = idNum(q, "R?");
    if (n) where.push(`r.num = ${n}`);
    else {
      params.push(q);
      where.push(`(r.title ILIKE '%' || $${params.length} || '%' OR r.build ILIKE '%' || $${params.length} || '%')`);
    }
  }
  const countSql = { sql: `SELECT count(*)::int AS n FROM test_runs r WHERE ${where.join(" AND ")}`, params: [...params] };
  if (num(req.query.after)) {
    params.push(num(req.query.after));
    where.push(`r.num > $${params.length}`);
  }
  res.json(await page(
    `SELECT r.project_key, r.num, r.title, r.build, r.environment, r.state, r.created_at, r.closed_at, u.login AS created_by,
       (SELECT json_object_agg(result, n) FROM (SELECT result, count(*)::int AS n FROM run_results WHERE run_id=r.id GROUP BY result) x) AS counts
     FROM test_runs r LEFT JOIN users u ON u.id=r.created_by WHERE ${where.join(" AND ")} ORDER BY r.num`,
    params, req,
    (r) => ({
      id: `${r.project_key}-R${r.num}`, pid: r.project_key, num: r.num, title: r.title, build: r.build, env: r.environment, state: r.state,
      createdBy: r.created_by, created: ms(r.created_at), closed: ms(r.closed_at),
      counts: { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, ...(r.counts || {}) },
    }),
    countSql
  ));
}));

// ---------- глобальный поиск ----------
const searchRouter = express.Router();

searchRouter.get("/", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 200);
  if (q.length < 2 && !/^\d+$/.test(q)) return res.json({ cases: [], bugs: [], runs: [], autotests: [] });
  const keys = await access.projectKeys(req.user);
  const lim = Math.min(20, limitOf(req.query.limit, 8));
  // «LK-B7» → проект LK и номер; «LK-12» → кейс; без ключа — во всех проектах
  const m = q.match(/^([A-Za-z]{2,6})-([BRAP]?)(\d+)$/i);
  const key = m ? m[1].toUpperCase() : null;
  const kind = m ? m[2].toUpperCase() : null;
  const n = m ? Number(m[3]) : null;
  const mine = (col) => `($1::text[] IS NULL OR ${col} = ANY($1::text[]))`;
  const tsq = `websearch_to_tsquery('russian', $2)`;
  const like = `'%' || replace(replace($2, '%', '\\%'), '_', '\\_') || '%'`;
  const [cases, bugs, runs, autotests] = await Promise.all([
    m && kind !== ""
      ? { rows: [] }
      : pool.query(
          `SELECT c.project_key, c.num, c.title, c.status, c.kind, ts_rank(c.search, ${tsq}) AS rank FROM test_cases c
           WHERE ${mine("c.project_key")} AND ${m ? "c.project_key=$3 AND c.num=$4" : `(c.search @@ ${tsq} OR c.title ILIKE ${like})`}
           ORDER BY rank DESC, c.num DESC LIMIT ${lim}`,
          m ? [keys, q, key, n] : [keys, q]
        ),
    m && kind !== "B"
      ? { rows: [] }
      : pool.query(
          `SELECT b.project_key, b.num, b.title, b.status, b.severity, ts_rank(b.search, ${tsq}) AS rank FROM bugs b
           WHERE ${mine("b.project_key")} AND ${m ? "b.project_key=$3 AND b.num=$4" : `(b.search @@ ${tsq} OR b.title ILIKE ${like})`}
           ORDER BY rank DESC, b.num DESC LIMIT ${lim}`,
          m ? [keys, q, key, n] : [keys, q]
        ),
    m && kind !== "R"
      ? { rows: [] }
      : pool.query(
          `SELECT r.project_key, r.num, r.title, r.state, r.build FROM test_runs r
           WHERE ${mine("r.project_key")} AND ${m ? "r.project_key=$3 AND r.num=$4" : `(r.title ILIKE ${like} OR r.build ILIKE ${like})`}
           ORDER BY r.num DESC LIMIT ${lim}`,
          m ? [keys, q, key, n] : [keys, q]
        ),
    m
      ? { rows: [] }
      : pool.query(
          `SELECT t.id, t.project_key, t.suite, t.name FROM auto_tests t
           WHERE ${mine("t.project_key")} AND (t.search @@ plainto_tsquery('simple', $2) OR t.name ILIKE ${like})
           ORDER BY t.id DESC LIMIT ${lim}`,
          [keys, q]
        ),
  ]);
  res.json({
    cases: cases.rows.map((c) => ({ id: `${c.project_key}-${c.num}`, pid: c.project_key, num: c.num, title: c.title, status: c.status, kind: c.kind })),
    bugs: bugs.rows.map((b) => ({ id: `${b.project_key}-B${b.num}`, pid: b.project_key, num: b.num, title: b.title, status: b.status, severity: b.severity })),
    runs: runs.rows.map((r) => ({ id: `${r.project_key}-R${r.num}`, pid: r.project_key, num: r.num, title: r.title, state: r.state, build: r.build })),
    autotests: autotests.rows.map((t) => ({ id: t.id, pid: t.project_key, suite: t.suite, name: t.name })),
  });
}));

module.exports = { router, searchRouter, idNum };
