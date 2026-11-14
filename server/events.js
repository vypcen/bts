// События предметной области: «баг создан», «прогон закрыт», «запуск автотестов завершён»…
// Маршруты вызывают emit() после успешного изменения; подписчики (вебхуки) получают событие асинхронно
// и не задерживают ответ пользователю.
const { pool } = require("./db");

const EVENTS = {
  "case.created": "Тест-кейс создан",
  "case.updated": "Тест-кейс изменён (новая версия)",
  "case.deleted": "Тест-кейс удалён",
  "run.created": "Прогон создан",
  "run.closed": "Прогон закрыт",
  "run.result": "Результат кейса в прогоне отмечен",
  "bug.created": "Баг создан",
  "bug.updated": "Баг изменён",
  "bug.status": "Статус бага изменился",
  "plan.locked": "Тест-план заблокирован",
  "plan.unlocked": "Тест-план разблокирован",
  "autorun.created": "Запуск автотестов начат",
  "autorun.finished": "Запуск автотестов завершён",
  "test.flaky": "Автотест стал нестабильным",
};

const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const link = (...parts) => (PUBLIC_URL ? `${PUBLIC_URL}/#/${parts.map((p) => encodeURIComponent(String(p))).join("/")}` : "");

const subscribers = [];
const subscribe = (fn) => subscribers.push(fn);

// key — проект, type — из EVENTS, data — данные события, actor — кто сделал (req.user) или null
function emit(key, type, data, actor) {
  if (!EVENTS[type]) throw new Error(`Неизвестное событие ${type}`);
  const event = {
    event: type,
    title: EVENTS[type],
    at: new Date().toISOString(),
    project: { key },
    actor: actor ? { login: actor.login, name: actor.name } : null,
    ...data,
  };
  setImmediate(async () => {
    try {
      const { rows } = await pool.query("SELECT name FROM projects WHERE key=$1", [key]);
      event.project.name = rows[0]?.name || "";
    } catch {}
    for (const fn of subscribers) Promise.resolve(fn(event)).catch((e) => console.error(`[events] ${type}:`, e.message));
  });
}

// Снимки сущностей для данных события (одинаковая форма во всех вебхуках)
const snap = {
  async bug(key, num) {
    const { rows } = await pool.query(
      `SELECT b.num, b.title, b.status, b.severity, b.environment, b.steps, b.actual, b.expected, b.external_key, b.external_url,
         au.login AS assignee, cu.login AS created_by, c.num AS case_num
       FROM bugs b LEFT JOIN users au ON au.id=b.assignee_id LEFT JOIN users cu ON cu.id=b.created_by
       LEFT JOIN test_cases c ON c.id=b.case_id WHERE b.project_key=$1 AND b.num=$2`,
      [key, num]
    );
    const b = rows[0];
    return b && {
      id: `${key}-B${b.num}`, num: b.num, title: b.title, status: b.status, severity: b.severity, environment: b.environment,
      steps: b.steps, actual: b.actual, expected: b.expected, assignee: b.assignee, createdBy: b.created_by,
      case: b.case_num ? `${key}-${b.case_num}` : null, external: b.external_key ? { key: b.external_key, url: b.external_url } : null,
      url: link("p", key, "bugs", b.num),
    };
  },
  async run(key, num) {
    const { rows } = await pool.query(
      `SELECT r.num, r.title, r.build, r.environment, r.state, p.num AS plan_num,
         count(rr.id)::int AS total, count(rr.id) FILTER (WHERE rr.result='passed')::int AS passed,
         count(rr.id) FILTER (WHERE rr.result='failed')::int AS failed, count(rr.id) FILTER (WHERE rr.result='blocked')::int AS blocked,
         count(rr.id) FILTER (WHERE rr.result='skipped')::int AS skipped, count(rr.id) FILTER (WHERE rr.result='untested')::int AS untested
       FROM test_runs r LEFT JOIN run_results rr ON rr.run_id=r.id LEFT JOIN test_plans p ON p.id=r.plan_id
       WHERE r.project_key=$1 AND r.num=$2 GROUP BY r.id, p.num`,
      [key, num]
    );
    const r = rows[0];
    return r && {
      id: `${key}-R${r.num}`, num: r.num, title: r.title, build: r.build, environment: r.environment, state: r.state,
      plan: r.plan_num ? `${key}-P${r.plan_num}` : null,
      counts: { total: r.total, passed: r.passed, failed: r.failed, blocked: r.blocked, skipped: r.skipped, untested: r.untested },
      passRate: r.total - r.untested ? Math.round((r.passed / (r.total - r.untested)) * 1000) / 10 : null,
      url: link("p", key, "runs", r.num),
    };
  },
  async testCase(key, num) {
    const { rows } = await pool.query("SELECT num, kind, title, priority, status, version FROM test_cases WHERE project_key=$1 AND num=$2", [key, num]);
    const c = rows[0];
    return c && { id: `${key}-${c.num}`, num: c.num, kind: c.kind, title: c.title, priority: c.priority, status: c.status, version: c.version, url: link("p", key, "cases", c.num) };
  },
  async autorun(key, num) {
    const { rows } = await pool.query(
      `SELECT r.num, r.title, r.build, r.environment, r.branch, r.state, r.params, r.ci_url,
         count(ar.id)::int AS total, count(ar.id) FILTER (WHERE ar.status='passed')::int AS passed,
         count(ar.id) FILTER (WHERE ar.status='failed')::int AS failed, count(ar.id) FILTER (WHERE ar.status='broken')::int AS broken,
         count(ar.id) FILTER (WHERE ar.status='skipped')::int AS skipped, count(ar.id) FILTER (WHERE ar.flaky)::int AS flaky
       FROM auto_runs r LEFT JOIN auto_results ar ON ar.run_id=r.id WHERE r.project_key=$1 AND r.num=$2 GROUP BY r.id`,
      [key, num]
    );
    const r = rows[0];
    return r && {
      id: `${key}-A${r.num}`, num: r.num, title: r.title, build: r.build, environment: r.environment, branch: r.branch, state: r.state,
      params: r.params, ciUrl: r.ci_url,
      counts: { total: r.total, passed: r.passed, failed: r.failed, broken: r.broken, skipped: r.skipped, flaky: r.flaky },
      url: link("p", key, "auto", r.num),
    };
  },
};

module.exports = { EVENTS, emit, subscribe, snap, link };
