// Аналитика проекта для дашборда. Монтируется на /api/projects/:key. ?days=30 — период (7…365).
// Всё считается в базе одним набором запросов: в браузер уходят только агрегаты.
//
// Предрасчёт: готовый ответ хранится в analytics_cache. Свежий (моложе FRESH_MS) отдаётся как есть;
// постарше — тоже отдаётся сразу, а пересчёт уходит в очередь (server/jobs.js); старше MAX_STALE_MS — считаем сразу.
// Раз в 10 минут очередь пересчитывает аналитику проектов, которую открывали за последнюю неделю.
const express = require("express");
const { pool } = require("./db");
const jobs = require("./jobs");
const { Limiter, MIN } = require("./limits");
const { wrap } = require("./util");

const FRESH_MS = Number(process.env.ANALYTICS_FRESH_SECONDS ?? 60) * 1000;
const MAX_STALE_MS = 60 * 60 * 1000;
const router = express.Router({ mergeParams: true });

async function compute(key, days) {
  // PostgreSQL не принимает лишние параметры: $2 (период) передаём только тем запросам, где он есть
  const q = (sql) => pool.query(sql, sql.includes("$2") ? [key, days] : [key]).then((r) => r.rows);

  const [cases, execution, runs, bugsNow, bugFlow, autoRuns, topFailing, flaky, workload, coverage] = await Promise.all([
    // кейсы: всего, по статусу и виду, сколько автоматизировано
    q(`SELECT count(*)::int AS total,
         count(*) FILTER (WHERE status='ready')::int AS ready, count(*) FILTER (WHERE status='draft')::int AS draft,
         count(*) FILTER (WHERE status='deprecated')::int AS deprecated, count(*) FILTER (WHERE kind='checklist')::int AS checklists,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM auto_tests a WHERE a.case_id=c.id))::int AS automated,
         count(*) FILTER (WHERE updated_at > now() - make_interval(days => $2))::int AS changed
       FROM test_cases c WHERE project_key=$1`),
    // ручные проверки по дням и результатам
    q(`SELECT to_char(date_trunc('day', rr.executed_at), 'YYYY-MM-DD') AS day, rr.result, count(*)::int AS n
       FROM run_results rr JOIN test_runs t ON t.id=rr.run_id
       WHERE t.project_key=$1 AND rr.executed_at > now() - make_interval(days => $2) AND rr.result <> 'untested'
       GROUP BY 1, 2 ORDER BY 1`),
    // последние прогоны: распределение результатов и процент прохождения
    q(`SELECT t.num, t.title, t.state, t.created_at, count(rr.id)::int AS total,
         count(rr.id) FILTER (WHERE rr.result='passed')::int AS passed, count(rr.id) FILTER (WHERE rr.result='failed')::int AS failed,
         count(rr.id) FILTER (WHERE rr.result='blocked')::int AS blocked, count(rr.id) FILTER (WHERE rr.result='skipped')::int AS skipped,
         count(rr.id) FILTER (WHERE rr.result='untested')::int AS untested
       FROM (SELECT * FROM test_runs WHERE project_key=$1 ORDER BY num DESC LIMIT 20) t LEFT JOIN run_results rr ON rr.run_id=t.id
       GROUP BY t.id, t.num, t.title, t.state, t.created_at ORDER BY t.num DESC`),
    // открытые баги по серьёзности и статусу
    q(`SELECT severity, status, count(*)::int AS n FROM bugs WHERE project_key=$1 AND status NOT IN ('closed','rejected','duplicate')
       GROUP BY 1, 2`),
    // поток багов: заведено и решено по дням
    q(`SELECT day, sum(created)::int AS created, sum(resolved)::int AS resolved FROM (
         SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, 1 AS created, 0 AS resolved FROM bugs
         WHERE project_key=$1 AND created_at > now() - make_interval(days => $2)
         UNION ALL
         SELECT to_char(date_trunc('day', l.changed_at), 'YYYY-MM-DD'), 0, 1 FROM bug_status_log l JOIN bugs b ON b.id=l.bug_id
         WHERE b.project_key=$1 AND l.changed_at > now() - make_interval(days => $2) AND l.to_status IN ('closed','rejected','duplicate','verified')
       ) x GROUP BY day ORDER BY day`),
    // автотесты: последние запуски
    q(`SELECT r.num, r.title, r.branch, r.state, r.created_at, count(ar.id)::int AS total,
         count(ar.id) FILTER (WHERE ar.status='passed')::int AS passed, count(ar.id) FILTER (WHERE ar.status='failed')::int AS failed,
         count(ar.id) FILTER (WHERE ar.status='broken')::int AS broken, count(ar.id) FILTER (WHERE ar.status='skipped')::int AS skipped,
         count(ar.id) FILTER (WHERE ar.flaky)::int AS flaky, COALESCE(sum(ar.duration_ms), 0)::bigint AS duration
       FROM (SELECT * FROM auto_runs WHERE project_key=$1 AND state IN ('running','finished') ORDER BY num DESC LIMIT 30) r
       LEFT JOIN auto_results ar ON ar.run_id=r.id
       GROUP BY r.id, r.num, r.title, r.branch, r.state, r.created_at ORDER BY r.num DESC`),
    // чаще всего падающие автотесты за период
    q(`SELECT t.id, t.suite, t.name, count(*) FILTER (WHERE ar.status IN ('failed','broken'))::int AS fails, count(*)::int AS runs
       FROM auto_results ar JOIN auto_runs r ON r.id=ar.run_id JOIN auto_tests t ON t.id=ar.test_id
       WHERE r.project_key=$1 AND r.created_at > now() - make_interval(days => $2) AND NOT t.quarantined
       GROUP BY t.id HAVING count(*) FILTER (WHERE ar.status IN ('failed','broken')) > 0
       ORDER BY 4 DESC, 5 LIMIT 10`),
    q(`SELECT id, suite, name, flaky_score, flaky_reason, quarantined, flaky_since FROM auto_tests
       WHERE project_key=$1 AND flaky_since IS NOT NULL ORDER BY flaky_score DESC LIMIT 10`),
    // нагрузка исполнителей в открытых прогонах
    q(`SELECT u.login, count(*) FILTER (WHERE rr.result='untested')::int AS todo,
         count(*) FILTER (WHERE rr.result <> 'untested')::int AS done
       FROM run_results rr JOIN test_runs t ON t.id=rr.run_id JOIN users u ON u.id=rr.assignee_id
       WHERE t.project_key=$1 AND t.state='open' GROUP BY u.login ORDER BY 2 DESC`),
    // покрытие: сколько готовых кейсов проверялось за период
    q(`SELECT count(DISTINCT rr.case_id)::int AS executed FROM run_results rr JOIN test_runs t ON t.id=rr.run_id
       WHERE t.project_key=$1 AND rr.executed_at > now() - make_interval(days => $2) AND rr.result <> 'untested'`),
  ]);

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const autoFinished = autoRuns.filter((r) => r.state === "finished" && r.total);
  const lastAuto = autoFinished[0];
  return {
    days,
    cases: cases[0],
    coverage: {
      executed: coverage[0].executed,
      executedPct: pct(coverage[0].executed, cases[0].ready),
      automatedPct: pct(cases[0].automated, cases[0].total - cases[0].deprecated),
    },
    execution,
    runs: runs.map((r) => ({
      num: r.num, title: r.title, state: r.state, created: r.created_at.getTime(),
      counts: { passed: r.passed, failed: r.failed, blocked: r.blocked, skipped: r.skipped, untested: r.untested }, total: r.total,
      passRate: pct(r.passed, r.total - r.untested),
    })).reverse(),
    bugs: { open: bugsNow, flow: bugFlow },
    auto: {
      runs: autoRuns.map((r) => ({
        num: r.num, title: r.title, branch: r.branch, created: r.created_at.getTime(), total: r.total,
        counts: { passed: r.passed, failed: r.failed, broken: r.broken, skipped: r.skipped }, flaky: r.flaky,
        durationMs: Number(r.duration), passRate: pct(r.passed, r.total - r.skipped),
      })).reverse(),
      lastPassRate: lastAuto ? pct(lastAuto.passed, lastAuto.total - lastAuto.skipped) : null,
      topFailing: topFailing.map((t) => ({ id: t.id, suite: t.suite, name: t.name, fails: t.fails, runs: t.runs })),
      flaky: flaky.map((t) => ({ id: t.id, suite: t.suite, name: t.name, score: t.flaky_score, reason: t.flaky_reason, quarantined: t.quarantined, since: t.flaky_since.getTime() })),
    },
    workload,
  };
}

// Посчитать и сохранить
async function refresh(key, days) {
  const started = Date.now();
  const data = await compute(key, days);
  const ms = Date.now() - started;
  const { rows } = await pool.query(
    `INSERT INTO analytics_cache(project_key, days, data, computed_at, compute_ms) VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (project_key, days) DO UPDATE SET data=EXCLUDED.data, computed_at=now(), compute_ms=EXCLUDED.compute_ms
     RETURNING computed_at`,
    [key, days, JSON.stringify(data), ms]
  );
  return { data, computedAt: rows[0].computed_at.getTime() };
}

jobs.define("analytics.refresh", ({ key, days }) => refresh(key, days), { maxAttempts: 2, title: "Пересчёт аналитики" });
// фоновый предрасчёт: проекты, чью аналитику открывали за неделю и которая устарела
jobs.define("analytics.precompute", async () => {
  const { rows } = await pool.query(
    `SELECT c.project_key, c.days FROM analytics_cache c JOIN projects p ON p.key=c.project_key AND p.deleted_at IS NULL
     WHERE c.requested_at > now() - interval '7 days' AND c.computed_at < now() - make_interval(secs => $1::float / 1000)`,
    [FRESH_MS]
  );
  for (const r of rows) await jobs.enqueue("analytics.refresh", { key: r.project_key, days: r.days }, { key: `analytics:${r.project_key}:${r.days}` });
}, { maxAttempts: 1, title: "Предрасчёт аналитики" });
jobs.every("analytics.precompute", 10 * 60 * 1000);

// «Пересчитать» в интерфейсе — не чаще 6 раз в минуту на пользователя
const forceLimit = new Limiter(6, MIN);

router.get("/analytics", wrap(async (req, res) => {
  const key = req.params.key;
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
  const force = req.query.fresh === "1" && forceLimit.take(String(req.user.id));
  const { rows } = await pool.query(
    "UPDATE analytics_cache SET requested_at=now() WHERE project_key=$1 AND days=$2 RETURNING data, computed_at",
    [key, days]
  );
  const cached = rows[0];
  const age = cached ? Date.now() - cached.computed_at.getTime() : Infinity;
  if (!force && age < MAX_STALE_MS) {
    // устарело — пересчёт в фоне, а пользователь сразу получает то, что есть
    if (age >= FRESH_MS) await jobs.enqueue("analytics.refresh", { key, days }, { key: `analytics:${key}:${days}` });
    return res.json({ ...cached.data, computedAt: cached.computed_at.getTime(), refreshing: age >= FRESH_MS });
  }
  const r = await refresh(key, days);
  res.json({ ...r.data, computedAt: r.computedAt, refreshing: false });
}));

module.exports = { router, compute, refresh };
