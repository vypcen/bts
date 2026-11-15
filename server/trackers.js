// Интеграция с трекерами задач: Jira (Cloud и Server/DC), YouTrack, GitLab, GitHub, Redmine.
// Один трекер на проект. Из бага TestBall можно создать задачу в трекере или привязать существующую;
// статус задачи подтягивается (по кнопке и раз в 10 минут), закрытие задачи может переводить баг в «Исправлен».
// Монтируется на /api/projects/:key.
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const secrets = require("./secrets");
const events = require("./events");
const jobs = require("./jobs");
const { wrap, str, num, HttpError } = require("./util");

const KINDS = ["jira", "youtrack", "gitlab", "github", "redmine"];
const SYNC_EVERY = 10 * 60 * 1000;

// ---------- адаптеры ----------
async function call(t, method, path, body, extraHeaders = {}) {
  const base = t.base_url.replace(/\/+$/, "");
  const token = secrets.decrypt(t.secret_enc);
  const headers = { Accept: "application/json", "User-Agent": "TestBall", ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (t.kind === "jira") headers.Authorization = t.login ? "Basic " + Buffer.from(`${t.login}:${token}`).toString("base64") : `Bearer ${token}`;
  else if (t.kind === "gitlab") headers["PRIVATE-TOKEN"] = token;
  else if (t.kind === "redmine") headers["X-Redmine-API-Key"] = token;
  else headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new HttpError(502, `Трекер недоступен: ${e.name === "TimeoutError" ? "нет ответа" : e.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    const msg = json?.errorMessages?.join("; ") || (json?.errors && JSON.stringify(json.errors)) || json?.message || json?.error || text.slice(0, 200);
    throw new HttpError(res.status === 404 ? 404 : 502, `Трекер ответил ${res.status}: ${String(msg).slice(0, 300)}`);
  }
  return json || {};
}

function describe(bug, key) {
  const parts = [
    bug.environment && `Окружение: ${bug.environment}`,
    bug.steps && `Шаги воспроизведения:\n${bug.steps.split("\n").filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    bug.actual && `Фактический результат:\n${bug.actual}`,
    bug.expected && `Ожидаемый результат:\n${bug.expected}`,
    `Серьёзность: ${bug.severity}`,
    `TestBall: ${bug.url || `${key}-B${bug.num}`}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

// Каждый адаптер: create(t, bug) → {key, url}; get(t, key) → {key, url, status, done}; ping(t)
const ADAPTERS = {
  jira: {
    async create(t, bug, key) {
      const fields = {
        project: { key: t.project_ref }, summary: bug.title, description: describe(bug, key),
        issuetype: { name: t.settings.issueType || "Bug" },
      };
      if (t.settings.labels?.length) fields.labels = t.settings.labels;
      const r = await call(t, "POST", "/rest/api/2/issue", { fields });
      return { key: r.key, url: `${t.base_url.replace(/\/+$/, "")}/browse/${r.key}` };
    },
    async get(t, k) {
      const r = await call(t, "GET", `/rest/api/2/issue/${encodeURIComponent(k)}?fields=status,summary`);
      const st = r.fields?.status;
      return { key: r.key, url: `${t.base_url.replace(/\/+$/, "")}/browse/${r.key}`, status: st?.name || "", done: st?.statusCategory?.key === "done" };
    },
    ping: (t) => call(t, "GET", `/rest/api/2/project/${encodeURIComponent(t.project_ref)}`),
  },
  youtrack: {
    async create(t, bug, key) {
      const r = await call(t, "POST", "/api/issues?fields=idReadable", { project: { id: t.project_ref }, summary: bug.title, description: describe(bug, key) });
      return { key: r.idReadable, url: `${t.base_url.replace(/\/+$/, "")}/issue/${r.idReadable}` };
    },
    async get(t, k) {
      const r = await call(t, "GET", `/api/issues/${encodeURIComponent(k)}?fields=idReadable,resolved,customFields(name,value(name))`);
      const state = (r.customFields || []).find((f) => f.name === "State")?.value?.name || "";
      return { key: r.idReadable, url: `${t.base_url.replace(/\/+$/, "")}/issue/${r.idReadable}`, status: state, done: Boolean(r.resolved) };
    },
    ping: (t) => call(t, "GET", `/api/admin/projects/${encodeURIComponent(t.project_ref)}?fields=id,name`),
  },
  gitlab: {
    async create(t, bug, key) {
      const r = await call(t, "POST", `/api/v4/projects/${encodeURIComponent(t.project_ref)}/issues`, {
        title: bug.title, description: describe(bug, key), labels: (t.settings.labels || []).join(","),
      });
      return { key: `#${r.iid}`, url: r.web_url };
    },
    async get(t, k) {
      const r = await call(t, "GET", `/api/v4/projects/${encodeURIComponent(t.project_ref)}/issues/${encodeURIComponent(k.replace(/^#/, ""))}`);
      return { key: `#${r.iid}`, url: r.web_url, status: r.state, done: r.state === "closed" };
    },
    ping: (t) => call(t, "GET", `/api/v4/projects/${encodeURIComponent(t.project_ref)}`),
  },
  github: {
    async create(t, bug, key) {
      const r = await call(t, "POST", `/repos/${t.project_ref}/issues`, { title: bug.title, body: describe(bug, key), labels: t.settings.labels || [] }, { "X-GitHub-Api-Version": "2022-11-28" });
      return { key: `#${r.number}`, url: r.html_url };
    },
    async get(t, k) {
      const r = await call(t, "GET", `/repos/${t.project_ref}/issues/${encodeURIComponent(k.replace(/^#/, ""))}`, undefined, { "X-GitHub-Api-Version": "2022-11-28" });
      return { key: `#${r.number}`, url: r.html_url, status: r.state_reason ? `${r.state} (${r.state_reason})` : r.state, done: r.state === "closed" };
    },
    ping: (t) => call(t, "GET", `/repos/${t.project_ref}`, undefined, { "X-GitHub-Api-Version": "2022-11-28" }),
  },
  redmine: {
    async create(t, bug, key) {
      const issue = { project_id: t.project_ref, subject: bug.title, description: describe(bug, key) };
      if (t.settings.trackerId) issue.tracker_id = Number(t.settings.trackerId);
      const r = await call(t, "POST", "/issues.json", { issue });
      return { key: `#${r.issue.id}`, url: `${t.base_url.replace(/\/+$/, "")}/issues/${r.issue.id}` };
    },
    async get(t, k) {
      const id = k.replace(/^#/, "");
      const r = await call(t, "GET", `/issues/${encodeURIComponent(id)}.json`);
      const closed = (t.settings.closedStatuses || ["Closed", "Resolved", "Rejected", "Закрыта", "Решена", "Отклонена"]).includes(r.issue.status?.name);
      return { key: `#${r.issue.id}`, url: `${t.base_url.replace(/\/+$/, "")}/issues/${r.issue.id}`, status: r.issue.status?.name || "", done: r.issue.status?.is_closed ?? closed };
    },
    ping: (t) => call(t, "GET", `/projects/${encodeURIComponent(t.project_ref)}.json`),
  },
};

const trackerOf = async (db, key) => (await db.query("SELECT * FROM trackers WHERE project_key=$1", [key])).rows[0];

// Снимок бага для описания задачи
async function bugRow(db, key, n) {
  const { rows } = await db.query(
    "SELECT id, num, title, status, severity, environment, steps, actual, expected, external_key FROM bugs WHERE project_key=$1 AND num=$2", [key, n]
  );
  return rows[0] && { ...rows[0], url: events.link("p", key, "bugs", rows[0].num) };
}

// Сохранить состояние задачи; закрытие задачи переводит баг «В работе» → «Исправлен», если так настроено
async function applyIssue(db, t, bug, issue, actorId = null) {
  await db.query(
    "UPDATE bugs SET external_key=$1, external_url=$2, external_status=$3, external_synced_at=now() WHERE id=$4",
    [issue.key, issue.url, issue.status || "", bug.id]
  );
  if (issue.done && t.settings.closeToFixed !== false && bug.status === "in_progress") {
    await db.query("UPDATE bugs SET status='fixed', updated_at=now() WHERE id=$1", [bug.id]);
    await db.query("INSERT INTO bug_status_log(bug_id, from_status, to_status, changed_by) VALUES ($1,'in_progress','fixed',$2)", [bug.id, actorId]);
    return true;
  }
  return false;
}

async function createIssue(key, n, user) {
  const t = await trackerOf(pool, key);
  if (!t) throw new HttpError(400, "Трекер для проекта не настроен");
  const bug = await bugRow(pool, key, n);
  if (!bug) throw new HttpError(404, "Баг не найден");
  if (bug.external_key) throw new HttpError(409, `Баг уже связан с задачей ${bug.external_key}`);
  const issue = await ADAPTERS[t.kind].create(t, bug, key);
  await applyIssue(pool, t, bug, { ...issue, status: "" }, user?.id);
  broadcast("bugs");
  return issue;
}

// автосоздание задачи для новых багов (настройка autoCreate, можно ограничить серьёзностью).
// Через очередь: трекер недоступен — задача создастся при повторе, а не потеряется
jobs.define("tracker.create", async ({ key, num }) => {
  const bug = await pool.query("SELECT external_key FROM bugs WHERE project_key=$1 AND num=$2", [key, num]);
  if (!bug.rows[0] || bug.rows[0].external_key) return; // баг удалён или задачу уже создали вручную
  await createIssue(key, num, null);
}, { maxAttempts: 6, title: "Создание задачи в трекере" });

events.subscribe(async (event) => {
  if (event.event !== "bug.created") return;
  const t = await trackerOf(pool, event.project.key);
  if (!t?.settings.autoCreate) return;
  const sev = t.settings.autoCreateSeverities;
  if (Array.isArray(sev) && sev.length && !sev.includes(event.bug.severity)) return;
  await jobs.enqueue("tracker.create", { key: event.project.key, num: event.bug.num }, { key: `tracker.create:${event.project.key}:${event.bug.num}` });
});

// Фоновая синхронизация статусов открытых багов. Если реплик несколько — работает одна (advisory lock)
async function syncAll() {
  const c = await pool.connect();
  try {
    const { rows: lock } = await c.query("SELECT pg_try_advisory_lock(7204312) AS ok");
    if (!lock[0].ok) return;
    try {
      const { rows } = await c.query(
        `SELECT b.id, b.num, b.status, b.external_key, b.project_key FROM bugs b JOIN trackers t ON t.project_key=b.project_key JOIN projects pr ON pr.key=b.project_key AND pr.deleted_at IS NULL
         WHERE b.external_key IS NOT NULL AND b.status NOT IN ('closed','rejected','duplicate')
         ORDER BY b.external_synced_at NULLS FIRST LIMIT 200`
      );
      let changed = false;
      for (const b of rows) {
        const t = await trackerOf(c, b.project_key);
        try {
          const issue = await ADAPTERS[t.kind].get(t, b.external_key);
          changed = (await applyIssue(c, t, b, issue)) || changed;
        } catch (e) {
          console.error(`[trackers] ${b.project_key}-B${b.num} (${b.external_key}):`, e.message);
        }
      }
      if (rows.length) broadcast("bugs");
    } finally {
      await c.query("SELECT pg_advisory_unlock(7204312)");
    }
  } finally {
    c.release();
  }
}
// Синхронизация — периодическая задача очереди: при нескольких репликах её выполняет одна
jobs.define("tracker.sync", () => syncAll(), { maxAttempts: 1, title: "Синхронизация статусов с трекером" });
function startSync() {
  jobs.every("tracker.sync", SYNC_EVERY);
}

// ---------- API ----------
const router = express.Router({ mergeParams: true });

const toTracker = (t) => t && {
  kind: t.kind, baseUrl: t.base_url, projectRef: t.project_ref, login: t.login, hasToken: Boolean(t.secret_enc), settings: t.settings,
};

router.get("/tracker", wrap(async (req, res) => {
  res.json({ tracker: toTracker(await trackerOf(pool, req.params.key)) || null });
}));

router.put("/tracker", wrap(async (req, res) => {
  const kind = str(req.body.kind, 20);
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `Тип трекера: ${KINDS.join(", ")}` });
  const baseUrl = str(req.body.baseUrl, 500).replace(/\/+$/, "") || (kind === "github" ? "https://api.github.com" : "");
  if (!/^https?:\/\//.test(baseUrl)) return res.status(400).json({ error: "Укажите адрес трекера (http:// или https://)" });
  const projectRef = str(req.body.projectRef, 200);
  if (!projectRef) return res.status(400).json({ error: "Укажите проект в трекере" });
  if (kind === "github" && !/^[\w.-]+\/[\w.-]+$/.test(projectRef)) return res.status(400).json({ error: "Для GitHub укажите репозиторий как owner/repo" });
  const s = req.body.settings && typeof req.body.settings === "object" ? req.body.settings : {};
  const settings = {
    issueType: str(s.issueType, 100) || undefined,
    labels: Array.isArray(s.labels) ? s.labels.map((l) => str(String(l), 100)).filter(Boolean).slice(0, 20) : [],
    autoCreate: s.autoCreate === true,
    autoCreateSeverities: Array.isArray(s.autoCreateSeverities) ? s.autoCreateSeverities.filter((x) => ["blocker", "critical", "major", "minor"].includes(x)) : [],
    closeToFixed: s.closeToFixed !== false,
    trackerId: s.trackerId ? str(String(s.trackerId), 20) : undefined,
  };
  const cur = await trackerOf(pool, req.params.key);
  const secret = req.body.token === undefined && cur ? cur.secret_enc : secrets.encrypt(str(req.body.token, 2000));
  if (!secret) return res.status(400).json({ error: "Укажите токен доступа к трекеру" });
  await pool.query(
    `INSERT INTO trackers(project_key, kind, base_url, project_ref, login, secret_enc, settings, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (project_key) DO UPDATE SET kind=EXCLUDED.kind, base_url=EXCLUDED.base_url, project_ref=EXCLUDED.project_ref,
       login=EXCLUDED.login, secret_enc=EXCLUDED.secret_enc, settings=EXCLUDED.settings`,
    [req.params.key, kind, baseUrl, projectRef, str(req.body.login, 200), secret, settings, req.user.id]
  );
  broadcast("tracker");
  res.json({ ok: true });
}));

router.delete("/tracker", wrap(async (req, res) => {
  await pool.query("DELETE FROM trackers WHERE project_key=$1", [req.params.key]);
  broadcast("tracker");
  res.json({ ok: true });
}));

router.post("/tracker/test", wrap(async (req, res) => {
  const t = await trackerOf(pool, req.params.key);
  if (!t) return res.status(400).json({ error: "Трекер не настроен" });
  await ADAPTERS[t.kind].ping(t);
  res.json({ ok: true });
}));

// {"create": true} — завести задачу; {"key": "PROJ-12"} — привязать существующую
router.post("/bugs/:num/external", wrap(async (req, res) => {
  const n = num(req.params.num);
  if (req.body.create === true) return res.status(201).json(await createIssue(req.params.key, n, req.user));
  const k = str(req.body.key, 100);
  if (!k) return res.status(400).json({ error: "Укажите ключ задачи, например PROJ-12 или #34" });
  const t = await trackerOf(pool, req.params.key);
  if (!t) return res.status(400).json({ error: "Трекер для проекта не настроен" });
  const bug = await bugRow(pool, req.params.key, n);
  if (!bug) return res.status(404).json({ error: "Баг не найден" });
  const issue = await ADAPTERS[t.kind].get(t, k);
  await tx((db) => applyIssue(db, t, bug, issue, req.user.id));
  broadcast("bugs");
  res.json(issue);
}));

router.post("/bugs/:num/external/sync", wrap(async (req, res) => {
  const t = await trackerOf(pool, req.params.key);
  if (!t) return res.status(400).json({ error: "Трекер для проекта не настроен" });
  const bug = await bugRow(pool, req.params.key, num(req.params.num));
  if (!bug?.external_key) return res.status(404).json({ error: "Баг не связан с задачей трекера" });
  const issue = await ADAPTERS[t.kind].get(t, bug.external_key);
  const moved = await tx((db) => applyIssue(db, t, bug, issue, req.user.id));
  broadcast("bugs");
  res.json({ ...issue, movedToFixed: moved });
}));

router.delete("/bugs/:num/external", wrap(async (req, res) => {
  const r = await pool.query(
    "UPDATE bugs SET external_key=NULL, external_url=NULL, external_status=NULL, external_synced_at=NULL WHERE project_key=$1 AND num=$2",
    [req.params.key, num(req.params.num)]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Баг не найден" });
  broadcast("bugs");
  res.json({ ok: true });
}));

module.exports = { router, startSync, ADAPTERS };
