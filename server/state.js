// Состояние для интерфейса. Раньше всё приходило одним GET /api/state; на десятках тысяч кейсов и миллионе
// результатов это не работает, поэтому состояние разделено:
//   GET /api/state                    — общее: проекты со сводкой, пользователи, тест-планы (небольшое);
//   GET /api/projects/:key/state      — один проект: кейсы, папки, прогоны со счётчиками, баги, комментарии,
//                                       вложения багов, запуски автотестов и ПОСЛЕДНИЙ результат каждого кейса;
//   GET /api/projects/:key/runs/:num/results — результаты одного прогона и «что было в прошлый раз»;
//   GET /api/projects/:key/cases/:num/history — история кейса по прогонам.
// Ответы GET получают ETag (express), повторный запрос без изменений отвечает 304 без тела.
const express = require("express");
const { pool } = require("./db");
const access = require("./access");
const { wrap, num, ms } = require("./util");

const caseSql = `SELECT c.project_key, c.num, c.kind, c.checked, c.folder_id, c.title, c.priority, c.status, c.preconditions, c.steps, c.expected, c.version,
  EXISTS (SELECT 1 FROM auto_tests a WHERE a.case_id=c.id) AS automated,
  cu.login AS created_by, uu.login AS updated_by, c.created_at, c.updated_at
  FROM test_cases c LEFT JOIN users cu ON cu.id=c.created_by LEFT JOIN users uu ON uu.id=c.updated_by`;
const toCase = (r) => ({
  id: `${r.project_key}-${r.num}`, pid: r.project_key, num: r.num, kind: r.kind, checked: r.checked, folder: r.folder_id, title: r.title, priority: r.priority, status: r.status,
  pre: r.preconditions, steps: r.steps, expected: r.expected, createdBy: r.created_by, updatedBy: r.updated_by, version: r.version, automated: r.automated,
  created: r.created_at.getTime(), updated: r.updated_at.getTime(),
});

const resultSql = `SELECT rr.id, t.project_key, t.num AS run_num, c.num AS case_num, rr.result, rr.comment, rr.items, u.login AS executed_by, rr.executed_at,
    au.login AS assignee, rr.case_version
  FROM run_results rr JOIN test_runs t ON t.id=rr.run_id JOIN test_cases c ON c.id=rr.case_id
  LEFT JOIN users u ON u.id=rr.executed_by LEFT JOIN users au ON au.id=rr.assignee_id`;
const toResult = (r) => ({
  id: r.id, pid: r.project_key, runNum: r.run_num, caseNum: r.case_num, result: r.result, comment: r.comment, items: r.items,
  executedBy: r.executed_by, executed: ms(r.executed_at), assignee: r.assignee, caseVersion: r.case_version,
});

const attachmentSql = `SELECT a.id, COALESCE(b.project_key, t.project_key) AS project_key, b.num AS bug_num, a.run_result_id,
    a.filename, a.mime, a.size, u.login AS uploaded_by, a.created_at
  FROM attachments a LEFT JOIN bugs b ON b.id=a.bug_id
  LEFT JOIN run_results rr ON rr.id=a.run_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
  LEFT JOIN users u ON u.id=a.uploaded_by`;
const toAttachment = (a) => ({
  id: a.id, pid: a.project_key, bugNum: a.bug_num, resultId: a.run_result_id, name: a.filename, mime: a.mime, size: a.size,
  uploadedBy: a.uploaded_by, created: ms(a.created_at),
});

// ---------- общее состояние ----------
async function meta(user) {
  const keys = await access.projectKeys(user);
  const mine = (col) => `($1::text[] IS NULL OR ${col} = ANY($1::text[]))`;
  const [projects, users, plans, stats] = await Promise.all([
    // myRole — действующая роль текущего пользователя в проекте (роль в проекте или глобальная)
    pool.query(`SELECT p.key, p.name, p.description, p.created_at, u.login AS created_by,
                  ARRAY(SELECT mu.login FROM project_members m JOIN users mu ON mu.id=m.user_id WHERE m.project_key=p.key ORDER BY mu.login) AS members,
                  COALESCE(json_object_agg(mu2.login, m2.role) FILTER (WHERE m2.role IS NOT NULL), '{}') AS member_roles,
                  CASE WHEN $3 = 'admin' THEN 'admin' ELSE COALESCE((SELECT role FROM project_members WHERE project_key=p.key AND user_id=$2), $3) END AS my_role
                FROM projects p LEFT JOIN users u ON u.id=p.created_by
                LEFT JOIN project_members m2 ON m2.project_key=p.key LEFT JOIN users mu2 ON mu2.id=m2.user_id
                WHERE ${mine("p.key")} GROUP BY p.key, u.login ORDER BY p.created_at DESC`, [keys, user.id, user.role]),
    // Пользователи — те, с кем есть общий проект, и админы (их можно назначить исполнителем). Админ видит всех.
    // Новичок без проектов видит только себя: список логинов и админов не должен доставаться любому зарегистрировавшемуся
    pool.query(
      `SELECT login, name, role FROM users u WHERE $1::text[] IS NULL OR u.id=$2
         OR (u.role='admin' AND cardinality($1::text[]) > 0)
         OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.project_key = ANY($1::text[]))`,
      [keys, user.id]
    ),
    pool.query(`SELECT project_key, num, title, mode, locked FROM test_plans WHERE ${mine("project_key")} ORDER BY project_key, num`, [keys]),
    // Сводка для карточек проектов: считается в базе, а не перебором всех кейсов в браузере
    pool.query(
      `WITH last AS (
         SELECT DISTINCT ON (rr.case_id) rr.case_id, rr.result
         FROM run_results rr JOIN test_runs t ON t.id=rr.run_id
         WHERE ${mine("t.project_key")} AND rr.result <> 'untested' AND rr.executed_at IS NOT NULL
         ORDER BY rr.case_id, rr.executed_at DESC
       )
       SELECT p.key,
         (SELECT count(*) FROM test_cases c WHERE c.project_key=p.key)::int AS cases,
         (SELECT count(*) FROM test_runs r WHERE r.project_key=p.key)::int AS runs,
         (SELECT count(*) FROM bugs b WHERE b.project_key=p.key)::int AS bugs,
         (SELECT count(*) FROM bugs b WHERE b.project_key=p.key AND b.status IN ('new','in_progress','fixed','verified'))::int AS open_bugs,
         (SELECT json_object_agg(res, n) FROM (
            SELECT COALESCE(l.result, 'untested') AS res, count(*)::int AS n FROM test_cases c LEFT JOIN last l ON l.case_id=c.id
            WHERE c.project_key=p.key AND c.status <> 'deprecated' GROUP BY 1) x) AS last
       FROM projects p WHERE ${mine("p.key")}`,
      [keys]
    ),
  ]);
  const statsOf = Object.fromEntries(stats.rows.map((s) => [s.key, s]));
  const empty = { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  return {
    projects: projects.rows.map((p) => {
      const s = statsOf[p.key] || {};
      return {
        id: p.key, name: p.name, desc: p.description, createdBy: p.created_by, created: p.created_at.getTime(), members: p.members,
        memberRoles: p.member_roles, myRole: p.my_role,
        stats: { cases: s.cases || 0, runs: s.runs || 0, bugs: s.bugs || 0, openBugs: s.open_bugs || 0, last: { ...empty, ...(s.last || {}) } },
      };
    }),
    plans: plans.rows.map((p) => ({ id: `${p.project_key}-P${p.num}`, pid: p.project_key, num: p.num, title: p.title, mode: p.mode, locked: p.locked })),
    users: Object.fromEntries(users.rows.map((u) => [u.login, { name: u.name, role: u.role }])),
  };
}

// ---------- состояние проекта ----------
async function project(key) {
  const k = [key];
  const [cases, runs, last, bugs, files, autoruns, comments, caseFolders, testPlans] = await Promise.all([
    pool.query(`${caseSql} WHERE c.project_key=$1 ORDER BY c.num`, k),
    pool.query(`SELECT r.project_key, r.num, r.title, r.build, r.environment, r.state, u.login AS created_by, r.created_at, r.closed_at,
                  p.num AS plan_num, COALESCE(p.locked, false) AS plan_locked,
                  (SELECT json_object_agg(result, n) FROM (SELECT result, count(*)::int AS n FROM run_results WHERE run_id=r.id GROUP BY result) x) AS counts
                FROM test_runs r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN test_plans p ON p.id=r.plan_id
                WHERE r.project_key=$1 ORDER BY r.num`, k),
    // последний выполненный результат каждого кейса и результаты, на которые ссылаются баги
    pool.query(`SELECT * FROM (SELECT DISTINCT ON (case_num) * FROM (${resultSql}
                    WHERE t.project_key=$1 AND rr.result <> 'untested' AND rr.executed_at IS NOT NULL) l
                  ORDER BY case_num, executed_at DESC) a
                UNION
                SELECT * FROM (${resultSql}
                  WHERE rr.id IN (SELECT run_result_id FROM bugs WHERE project_key=$1 AND run_result_id IS NOT NULL)) b`, k),
    pool.query(`SELECT b.project_key, b.num, b.title, b.status, b.severity, au.login AS assignee, b.environment, b.steps, b.actual, b.expected,
                  c.num AS case_num, t.num AS run_num, b.run_result_id, d.num AS dup_num, b.external_key, b.external_url, b.external_status,
                  cu.login AS created_by, uu.login AS updated_by, b.created_at, b.updated_at
                FROM bugs b LEFT JOIN users au ON au.id=b.assignee_id LEFT JOIN test_cases c ON c.id=b.case_id
                LEFT JOIN run_results rr ON rr.id=b.run_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
                LEFT JOIN bugs d ON d.id=b.duplicate_of
                LEFT JOIN users cu ON cu.id=b.created_by LEFT JOIN users uu ON uu.id=b.updated_by
                WHERE b.project_key=$1 ORDER BY b.num`, k),
    // вложения багов и результатов, к которым привязаны баги; вложения прогона отдаёт /runs/:num/results
    pool.query(`${attachmentSql}
                WHERE a.auto_result_id IS NULL AND (b.project_key=$1
                  OR a.run_result_id IN (SELECT run_result_id FROM bugs WHERE project_key=$1 AND run_result_id IS NOT NULL))
                ORDER BY a.created_at`, k),
    // запуски автотестов — только сводка; сами результаты отдаёт GET /api/projects/:key/autoruns/:num
    pool.query(`SELECT r.project_key, r.num, r.title, r.build, r.environment, r.branch, r.scope, r.app_url, r.state, u.login AS created_by, r.created_at, r.finished_at,
                  r.params, r.ci_url, count(ar.id) FILTER (WHERE ar.flaky)::int AS flaky,
                  count(ar.id) FILTER (WHERE ar.status='passed')::int AS passed, count(ar.id) FILTER (WHERE ar.status='failed')::int AS failed,
                  count(ar.id) FILTER (WHERE ar.status='broken')::int AS broken, count(ar.id) FILTER (WHERE ar.status='skipped')::int AS skipped,
                  COALESCE(sum(ar.duration_ms), 0)::bigint AS duration
                FROM auto_runs r LEFT JOIN auto_results ar ON ar.run_id=r.id LEFT JOIN users u ON u.id=r.created_by
                WHERE r.project_key=$1 GROUP BY r.id, u.login ORDER BY r.num`, k),
    pool.query(`SELECT cm.id, COALESCE(b.project_key, c.project_key) AS project_key, b.num AS bug_num, c.num AS case_num,
                  u.login AS author, cm.body, cm.created_at, cm.edited_at
                FROM comments cm LEFT JOIN bugs b ON b.id=cm.bug_id LEFT JOIN test_cases c ON c.id=cm.case_id
                LEFT JOIN users u ON u.id=cm.author_id
                WHERE COALESCE(b.project_key, c.project_key)=$1 ORDER BY cm.created_at, cm.id`, k),
    pool.query(`SELECT id, project_key, parent_id, name FROM case_folders WHERE project_key=$1 ORDER BY name`, k),
    pool.query(`SELECT project_key, num, title, mode, locked FROM test_plans WHERE project_key=$1 ORDER BY num`, k),
  ]);
  const empty = { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  return {
    pid: key,
    plans: testPlans.rows.map((p) => ({ id: `${p.project_key}-P${p.num}`, pid: p.project_key, num: p.num, title: p.title, mode: p.mode, locked: p.locked })),
    cases: cases.rows.map(toCase),
    folders: caseFolders.rows.map((f) => ({ id: f.id, pid: f.project_key, parent: f.parent_id, name: f.name })),
    runs: runs.rows.map((r) => ({
      id: `${r.project_key}-R${r.num}`, pid: r.project_key, num: r.num, title: r.title, build: r.build, env: r.environment,
      state: r.state, createdBy: r.created_by, created: ms(r.created_at), closed: ms(r.closed_at), planNum: r.plan_num, planLocked: r.plan_locked,
      counts: { ...empty, ...(r.counts || {}) },
    })),
    results: last.rows.map(toResult),
    bugs: bugs.rows.map((b) => ({
      id: `${b.project_key}-B${b.num}`, pid: b.project_key, num: b.num, title: b.title, status: b.status, severity: b.severity,
      assignee: b.assignee, env: b.environment, steps: b.steps, actual: b.actual, expected: b.expected,
      caseNum: b.case_num, runNum: b.run_num, resultId: b.run_result_id, duplicateOf: b.dup_num,
      createdBy: b.created_by, updatedBy: b.updated_by, created: ms(b.created_at), updated: ms(b.updated_at),
      external: b.external_key ? { key: b.external_key, url: b.external_url, status: b.external_status || "" } : null,
    })),
    attachments: files.rows.map(toAttachment),
    autoruns: autoruns.rows.map((r) => ({
      id: `${r.project_key}-A${r.num}`, pid: r.project_key, num: r.num, title: r.title, build: r.build, env: r.environment, branch: r.branch,
      scope: r.scope, url: r.app_url, state: r.state, createdBy: r.created_by, created: ms(r.created_at), finished: ms(r.finished_at), durationMs: Number(r.duration),
      counts: { passed: r.passed, failed: r.failed, broken: r.broken, skipped: r.skipped }, flaky: r.flaky, params: r.params, ciUrl: r.ci_url,
    })),
    comments: comments.rows.map((c) => ({
      id: c.id, pid: c.project_key, bugNum: c.bug_num, caseNum: c.case_num, author: c.author, text: c.body,
      created: ms(c.created_at), edited: ms(c.edited_at),
    })),
  };
}

// ---------- маршруты внутри проекта (монтируются на /api/projects/:key) ----------
const router = express.Router({ mergeParams: true });

router.get("/state", wrap(async (req, res) => {
  res.json(await project(req.params.key));
}));

// Результаты прогона, «что было в прошлый раз» по каждому его кейсу и вложения результатов
router.get("/runs/:num/results", wrap(async (req, res) => {
  const n = num(req.params.num);
  const { rows: run } = await pool.query("SELECT id FROM test_runs WHERE project_key=$1 AND num=$2", [req.params.key, n]);
  if (!run[0]) return res.status(404).json({ error: "Прогон не найден" });
  const [results, previous, files] = await Promise.all([
    pool.query(`${resultSql} WHERE rr.run_id=$1 ORDER BY c.num`, [run[0].id]),
    pool.query(
      `SELECT DISTINCT ON (case_num) * FROM (${resultSql}
         WHERE t.project_key=$1 AND t.num < $2 AND rr.result <> 'untested'
           AND rr.case_id IN (SELECT case_id FROM run_results WHERE run_id=$3)) x
       ORDER BY case_num, run_num DESC`,
      [req.params.key, n, run[0].id]
    ),
    pool.query(`${attachmentSql} WHERE a.run_result_id IN (SELECT id FROM run_results WHERE run_id=$1) ORDER BY a.created_at`, [run[0].id]),
  ]);
  res.json({ results: results.rows.map(toResult), previous: previous.rows.map(toResult), attachments: files.rows.map(toAttachment) });
}));

// История кейса: результаты во всех прогонах, свежие первыми
router.get("/cases/:num/history", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `${resultSql} WHERE t.project_key=$1 AND c.num=$2 AND rr.result <> 'untested' ORDER BY rr.executed_at DESC NULLS LAST LIMIT 200`,
    [req.params.key, num(req.params.num)]
  );
  res.json({ results: rows.map(toResult) });
}));

module.exports = { meta, project, router, caseSql, toCase, resultSql, toResult };
