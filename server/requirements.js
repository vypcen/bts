// Требования и трассировка. Монтируется на /api/projects/:key.
// Требование связано с тест-кейсами; покрытие считается по последним результатам связанных кейсов,
// баги — те, что заведены по этим кейсам. Матрица трассировки выгружается в CSV (Excel)
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const { normalizeTags } = require("./casemodel");
const { csvRow } = require("./csvutil");
const { wrap, str, num } = require("./util");

const STATUSES = ["draft", "approved", "implemented", "obsolete"];
const STATUS_LABELS = { draft: "Черновик", approved: "Согласовано", implemented: "Реализовано", obsolete: "Устарело" };
const PRIORITIES = ["low", "medium", "high"];
const COVERAGE_LABELS = { none: "Не покрыто", untested: "Не проверено", failed: "Провалено", partial: "Проверено частично", passed: "Пройдено" };
const RESULT_LABELS = { passed: "Пройден", failed: "Упал", blocked: "Заблокирован", skipped: "Пропущен", untested: "Не проверен" };
const OPEN_BUGS = "b.status NOT IN ('closed','rejected','duplicate','verified')";

// Покрытие по последним результатам кейсов. Упал или заблокирован хоть один — «провалено»
function coverage(results) {
  if (!results.length) return "none";
  if (results.some((r) => r === "failed" || r === "blocked")) return "failed";
  const passed = results.filter((r) => r === "passed").length;
  if (passed === results.length) return "passed";
  return passed ? "partial" : "untested";
}

const listSql = `
  SELECT r.*, u.login AS created_by_login,
    COALESCE(ARRAY_AGG(c.num ORDER BY c.num) FILTER (WHERE c.id IS NOT NULL), '{}') AS case_nums,
    COALESCE(ARRAY_AGG(c.last_result ORDER BY c.num) FILTER (WHERE c.id IS NOT NULL), '{}') AS case_results,
    (SELECT count(*)::int FROM bugs b JOIN requirement_cases x ON x.case_id=b.case_id WHERE x.requirement_id=r.id AND ${OPEN_BUGS}) AS open_bugs
  FROM requirements r
  LEFT JOIN users u ON u.id=r.created_by
  LEFT JOIN requirement_cases rc ON rc.requirement_id=r.id
  LEFT JOIN test_cases c ON c.id=rc.case_id
  WHERE r.project_key=$1`;

const toReq = (r) => ({
  num: r.num, title: r.title, description: r.description, status: r.status, priority: r.priority,
  extRef: r.ext_ref, url: r.url, tags: r.tags, createdBy: r.created_by_login || null,
  created: r.created_at.getTime(), updated: r.updated_at.getTime(),
  cases: r.case_nums, coverage: coverage(r.case_results), openBugs: r.open_bugs,
  counts: r.case_results.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {}),
});

async function list(key, { q, status, coverage: cov } = {}) {
  const params = [key];
  let where = "";
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (lower(r.title) LIKE $${params.length} OR lower(r.ext_ref) LIKE $${params.length} OR lower(r.description) LIKE $${params.length})`;
  }
  if (status) {
    params.push(status.split(","));
    where += ` AND r.status = ANY($${params.length}::text[])`;
  }
  const { rows } = await pool.query(`${listSql}${where} GROUP BY r.id, u.login ORDER BY r.num`, params);
  let items = rows.map(toReq);
  if (cov) {
    const want = cov.split(",");
    items = items.filter((r) => want.includes(r.coverage));
  }
  return items;
}

function readBody(body, prev = {}) {
  const pick = (k, d) => (body[k] !== undefined ? body[k] : d);
  const out = {
    title: str(pick("title", prev.title), 500),
    description: str(pick("description", prev.description ?? ""), 20000),
    status: pick("status", prev.status ?? "draft"),
    priority: pick("priority", prev.priority ?? "medium"),
    extRef: str(pick("extRef", prev.ext_ref ?? ""), 100),
    url: str(pick("url", prev.url ?? ""), 2000),
    tags: body.tags !== undefined ? normalizeTags(body.tags) : prev.tags ?? [],
  };
  if (!out.title) return { error: "Укажите название требования" };
  if (!STATUSES.includes(out.status)) return { error: `Статус: ${STATUSES.join(", ")}` };
  if (!PRIORITIES.includes(out.priority)) return { error: `Приоритет: ${PRIORITIES.join(", ")}` };
  if (out.url && !/^https?:\/\//i.test(out.url)) return { error: "Ссылка должна начинаться с http:// или https://" };
  return { value: out };
}

// Номера кейсов → id в проекте. Неизвестные номера — ошибка, чтобы опечатка не терялась молча
async function caseIds(db, key, nums) {
  const list = [...new Set((Array.isArray(nums) ? nums : []).map(num).filter((n) => n > 0))];
  if (!list.length) return { ids: [] };
  const { rows } = await db.query("SELECT id, num FROM test_cases WHERE project_key=$1 AND num = ANY($2::int[])", [key, list]);
  const missing = list.filter((n) => !rows.some((r) => r.num === n));
  if (missing.length) return { error: `Нет тест-кейсов: ${missing.map((n) => `${key}-${n}`).join(", ")}` };
  return { ids: rows.map((r) => r.id) };
}

const router = express.Router({ mergeParams: true });

router.get("/requirements", wrap(async (req, res) => {
  const items = await list(req.params.key, { q: str(req.query.q, 200), status: str(req.query.status, 100), coverage: str(req.query.coverage, 100) });
  const summary = items.filter((r) => r.status !== "obsolete").reduce((m, r) => ({ ...m, [r.coverage]: (m[r.coverage] || 0) + 1 }), {});
  res.json({ items, summary });
}));

// Матрица трассировки: требование × кейс × последний результат × открытые баги. CSV для Excel (UTF-8 с BOM, «;»)
router.get("/requirements/matrix.csv", wrap(async (req, res) => {
  const key = req.params.key;
  const { rows } = await pool.query(
    `SELECT r.num, r.title, r.ext_ref, r.status, c.num AS case_num, c.title AS case_title, c.last_result,
       t.num AS run_num, rr.executed_at,
       (SELECT string_agg('BUG-' || b.num, ', ' ORDER BY b.num) FROM bugs b WHERE b.case_id=c.id AND ${OPEN_BUGS}) AS bugs
     FROM requirements r
     LEFT JOIN requirement_cases rc ON rc.requirement_id=r.id
     LEFT JOIN test_cases c ON c.id=rc.case_id
     LEFT JOIN run_results rr ON rr.id=c.last_result_id
     LEFT JOIN test_runs t ON t.id=rr.run_id
     WHERE r.project_key=$1 ORDER BY r.num, c.num`,
    [key]
  );
  const reqs = await list(key);
  const cov = Object.fromEntries(reqs.map((r) => [r.num, r.coverage]));
  let out = "﻿" + csvRow(["Требование", "Название", "Внешний ключ", "Статус", "Покрытие", "Тест-кейс", "Название кейса", "Последний результат", "Прогон", "Когда", "Открытые баги"]);
  for (const r of rows) {
    out += csvRow([
      `R-${r.num}`, r.title, r.ext_ref, STATUS_LABELS[r.status], COVERAGE_LABELS[cov[r.num]],
      r.case_num ? `${key}-${r.case_num}` : "", r.case_title || "", r.case_num ? RESULT_LABELS[r.last_result] || r.last_result : "",
      r.run_num ? `#${r.run_num}` : "", r.executed_at ? r.executed_at.toISOString().slice(0, 16).replace("T", " ") : "", r.bugs || "",
    ]);
  }
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${key}-traceability.csv"`);
  res.send(out);
}));

router.get("/requirements/:num(\\d+)", wrap(async (req, res) => {
  const key = req.params.key;
  const { rows } = await pool.query(`${listSql} AND r.num=$2 GROUP BY r.id, u.login`, [key, num(req.params.num)]);
  if (!rows[0]) return res.status(404).json({ error: "Требование не найдено" });
  const [cases, bugs] = await Promise.all([
    pool.query(
      `SELECT c.num, c.title, c.priority, c.status, c.last_result, t.num AS run_num, rr.executed_at
       FROM requirement_cases rc JOIN test_cases c ON c.id=rc.case_id
       LEFT JOIN run_results rr ON rr.id=c.last_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
       WHERE rc.requirement_id=$1 ORDER BY c.num`,
      [rows[0].id]
    ),
    pool.query(
      `SELECT b.num, b.title, b.status, b.severity, c.num AS case_num
       FROM requirement_cases rc JOIN bugs b ON b.case_id=rc.case_id JOIN test_cases c ON c.id=b.case_id
       WHERE rc.requirement_id=$1 ORDER BY (${OPEN_BUGS}) DESC, b.num DESC LIMIT 200`,
      [rows[0].id]
    ),
  ]);
  res.json({
    ...toReq(rows[0]),
    caseList: cases.rows.map((c) => ({
      num: c.num, title: c.title, priority: c.priority, status: c.status, lastResult: c.last_result,
      runNum: c.run_num, executed: c.executed_at ? c.executed_at.getTime() : null,
    })),
    bugs: bugs.rows.map((b) => ({ num: b.num, title: b.title, status: b.status, severity: b.severity, caseNum: b.case_num })),
  });
}));

router.post("/requirements", wrap(async (req, res) => {
  const key = req.params.key;
  const b = readBody(req.body);
  if (b.error) return res.status(400).json({ error: b.error });
  const out = await tx(async (db) => {
    const ids = await caseIds(db, key, req.body.cases);
    if (ids.error) return { status: 400, error: ids.error };
    const seq = await db.query("UPDATE projects SET req_seq=req_seq+1 WHERE key=$1 RETURNING req_seq", [key]);
    const n = seq.rows[0].req_seq;
    const v = b.value;
    const { rows } = await db.query(
      `INSERT INTO requirements(project_key, num, title, description, status, priority, ext_ref, url, tags, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
      [key, n, v.title, v.description, v.status, v.priority, v.extRef, v.url, v.tags, req.user.id]
    );
    if (ids.ids.length) await db.query("INSERT INTO requirement_cases SELECT $1, unnest($2::int[])", [rows[0].id, ids.ids]);
    return { n };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  broadcast("requirements");
  res.status(201).json({ num: out.n });
}));

router.patch("/requirements/:num(\\d+)", wrap(async (req, res) => {
  const key = req.params.key;
  const { rows } = await pool.query("SELECT * FROM requirements WHERE project_key=$1 AND num=$2", [key, num(req.params.num)]);
  if (!rows[0]) return res.status(404).json({ error: "Требование не найдено" });
  const b = readBody(req.body, rows[0]);
  if (b.error) return res.status(400).json({ error: b.error });
  const out = await tx(async (db) => {
    const v = b.value;
    await db.query(
      `UPDATE requirements SET title=$2, description=$3, status=$4, priority=$5, ext_ref=$6, url=$7, tags=$8, updated_by=$9, updated_at=now() WHERE id=$1`,
      [rows[0].id, v.title, v.description, v.status, v.priority, v.extRef, v.url, v.tags, req.user.id]
    );
    // cases — полный список связанных кейсов (заменяет прежний)
    if (req.body.cases !== undefined) {
      const ids = await caseIds(db, key, req.body.cases);
      if (ids.error) return { status: 400, error: ids.error };
      await db.query("DELETE FROM requirement_cases WHERE requirement_id=$1", [rows[0].id]);
      if (ids.ids.length) await db.query("INSERT INTO requirement_cases SELECT $1, unnest($2::int[])", [rows[0].id, ids.ids]);
    }
    return {};
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  broadcast("requirements");
  res.json({ ok: true });
}));

// Связать или отвязать один кейс (из карточки кейса): {caseNum, linked: true|false}
router.post("/requirements/:num(\\d+)/link", wrap(async (req, res) => {
  const key = req.params.key;
  const r = await pool.query("SELECT id FROM requirements WHERE project_key=$1 AND num=$2", [key, num(req.params.num)]);
  if (!r.rows[0]) return res.status(404).json({ error: "Требование не найдено" });
  const ids = await caseIds(pool, key, [req.body.caseNum]);
  if (ids.error || !ids.ids.length) return res.status(400).json({ error: ids.error || "Укажите caseNum" });
  if (req.body.linked === false) await pool.query("DELETE FROM requirement_cases WHERE requirement_id=$1 AND case_id=$2", [r.rows[0].id, ids.ids[0]]);
  else await pool.query("INSERT INTO requirement_cases VALUES ($1,$2) ON CONFLICT DO NOTHING", [r.rows[0].id, ids.ids[0]]);
  broadcast("requirements");
  res.json({ ok: true });
}));

router.delete("/requirements/:num(\\d+)", wrap(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM requirements WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  if (!rowCount) return res.status(404).json({ error: "Требование не найдено" });
  broadcast("requirements");
  res.json({ ok: true });
}));

// Требования, связанные с кейсом (для карточки кейса)
router.get("/cases/:num(\\d+)/requirements", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.num, r.title, r.status, r.ext_ref FROM requirements r JOIN requirement_cases rc ON rc.requirement_id=r.id
     JOIN test_cases c ON c.id=rc.case_id WHERE c.project_key=$1 AND c.num=$2 ORDER BY r.num`,
    [req.params.key, num(req.params.num)]
  );
  res.json({ items: rows.map((r) => ({ num: r.num, title: r.title, status: r.status, extRef: r.ext_ref })) });
}));

// Импорт требований из CSV-строк, уже разобранных клиентом или скриптом: [{title, extRef, url, description, priority, cases: [nums]}].
// Требование с тем же extRef обновляется, а не дублируется — так можно регулярно подтягивать выгрузку из Jira
router.post("/requirements/import", wrap(async (req, res) => {
  const key = req.params.key;
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 5000) : null;
  if (!items) return res.status(400).json({ error: "items: массив требований" });
  const result = await tx(async (db) => {
    let created = 0, updated = 0;
    const errors = [];
    for (const [i, it] of items.entries()) {
      const prev = it.extRef
        ? (await db.query("SELECT * FROM requirements WHERE project_key=$1 AND ext_ref=$2", [key, str(it.extRef, 100)])).rows[0]
        : null;
      const b = readBody(it, prev || {});
      if (b.error) {
        errors.push(`Строка ${i + 1}: ${b.error}`);
        continue;
      }
      const ids = await caseIds(db, key, it.cases);
      if (ids.error) {
        errors.push(`Строка ${i + 1}: ${ids.error}`);
        continue;
      }
      const v = b.value;
      let id;
      if (prev) {
        await db.query(
          `UPDATE requirements SET title=$2, description=$3, status=$4, priority=$5, url=$6, tags=$7, updated_by=$8, updated_at=now() WHERE id=$1`,
          [prev.id, v.title, v.description, v.status, v.priority, v.url, v.tags, req.user.id]
        );
        id = prev.id;
        updated++;
      } else {
        const n = (await db.query("UPDATE projects SET req_seq=req_seq+1 WHERE key=$1 RETURNING req_seq", [key])).rows[0].req_seq;
        id = (await db.query(
          `INSERT INTO requirements(project_key, num, title, description, status, priority, ext_ref, url, tags, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
          [key, n, v.title, v.description, v.status, v.priority, v.extRef, v.url, v.tags, req.user.id]
        )).rows[0].id;
        created++;
      }
      if (ids.ids.length) await db.query("INSERT INTO requirement_cases SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING", [id, ids.ids]);
    }
    return { created, updated, errors };
  });
  broadcast("requirements");
  res.json(result);
}));

module.exports = { router, coverage, STATUSES, COVERAGE_LABELS };
