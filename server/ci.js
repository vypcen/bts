// Параметризованные запуски автотестов в CI: GitLab CI, GitHub Actions, Jenkins или любой HTTP-адрес.
// Задача CI описывается один раз (куда стучаться, какие параметры можно задать); запуск из интерфейса создаёт
// запуск автотестов в состоянии «В очереди» и передаёт в CI его номер (TESTBALL_RUN). Репортер (scripts/report.js,
// scripts/playwright-reporter.js) видит TESTBALL_RUN и пишет результаты в этот запуск, а не создаёт новый.
// Монтируется на /api/projects/:key.
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const secrets = require("./secrets");
const events = require("./events");
const { wrap, str, num, HttpError } = require("./util");

const KINDS = ["gitlab", "github", "jenkins", "generic"];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

function readJob(body) {
  const j = {
    name: str(body.name, 100),
    kind: str(body.kind, 20),
    baseUrl: str(body.baseUrl ?? body.base_url, 500).replace(/\/+$/, ""),
    target: str(body.target, 300),
    ref: str(body.ref, 200) || "main",
    login: str(body.login, 200),
    params: [],
  };
  if (!j.name) return { error: "Укажите название задачи" };
  if (!KINDS.includes(j.kind)) return { error: `Тип CI: ${KINDS.join(", ")}` };
  if (j.kind === "github" && !j.baseUrl) j.baseUrl = "https://api.github.com";
  if (!/^https?:\/\//.test(j.baseUrl)) return { error: "Укажите адрес CI (http:// или https://)" };
  if (j.kind === "github" && !/^[\w.-]+\/[\w.-]+\/[\w.-]+\.ya?ml$/.test(j.target)) return { error: "Для GitHub укажите owner/repo/workflow.yml" };
  if ((j.kind === "gitlab" || j.kind === "jenkins") && !j.target) return { error: j.kind === "gitlab" ? "Укажите id проекта GitLab" : "Укажите путь задачи Jenkins, например folder/e2e" };
  const list = Array.isArray(body.params) ? body.params.slice(0, 25) : [];
  for (const p of list) {
    const name = str(p?.name, 64);
    if (!NAME_RE.test(name)) return { error: `Имя параметра «${name}»: латинские буквы, цифры и _` };
    if (j.params.some((x) => x.name === name)) return { error: `Параметр ${name} указан дважды` };
    const options = Array.isArray(p.options) ? p.options.map((o) => str(String(o), 200)).filter(Boolean).slice(0, 50) : [];
    j.params.push({ name, label: str(p.label, 100) || name, default: str(String(p.default ?? ""), 500), options, required: p.required === true });
  }
  return { j };
}

// Значения параметров запуска: из присланных, по умолчанию — значение из описания задачи
function readValues(job, given = {}) {
  const out = {};
  for (const p of job.params) {
    const v = given[p.name] === undefined ? p.default : str(String(given[p.name]), 500);
    if (p.required && !v) throw new HttpError(400, `Заполните параметр «${p.label}»`);
    if (p.options.length && v && !p.options.includes(v)) throw new HttpError(400, `«${p.label}»: допустимые значения — ${p.options.join(", ")}`);
    if (v !== "") out[p.name] = v;
  }
  return out;
}

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new HttpError(502, `CI недоступен: ${e.name === "TimeoutError" ? "нет ответа" : e.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new HttpError(502, `CI ответил ${res.status}: ${String(json?.message || json?.error || text).slice(0, 300)}`);
  return { res, json };
}

// Запустить задачу. vars — параметры пользователя + служебные TESTBALL_*. Возвращает адрес запуска в CI (если известен)
const TRIGGERS = {
  async gitlab(job, token, vars) {
    const base = `${job.base_url}/api/v4/projects/${encodeURIComponent(job.target)}`;
    // токен триггера (glptt-…) — через /trigger/pipeline; личный или проектный токен — через /pipeline
    if (token.startsWith("glptt-")) {
      const form = new URLSearchParams({ token, ref: job.ref });
      for (const [k, v] of Object.entries(vars)) form.set(`variables[${k}]`, v);
      const { json } = await request(`${base}/trigger/pipeline`, { method: "POST", body: form });
      return json?.web_url || "";
    }
    const { json } = await request(`${base}/pipeline`, {
      method: "POST",
      headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: job.ref, variables: Object.entries(vars).map(([key, value]) => ({ key, value })) }),
    });
    return json?.web_url || "";
  },
  async github(job, token, vars) {
    const [owner, repo, workflow] = job.target.split("/");
    // workflow_dispatch принимает только объявленные в workflow inputs: служебный — testball_run
    const inputs = { ...vars };
    delete inputs.TESTBALL_PROJECT;
    delete inputs.TESTBALL_URL;
    inputs.testball_run = inputs.TESTBALL_RUN;
    delete inputs.TESTBALL_RUN;
    await request(`${job.base_url}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: job.ref, inputs }),
    });
    const web = job.base_url === "https://api.github.com" ? "https://github.com" : job.base_url.replace(/\/api\/v3$/, "");
    return `${web}/${owner}/${repo}/actions/workflows/${workflow}`;
  },
  async jenkins(job, token, vars) {
    const jobPath = job.target.split("/").filter(Boolean).map((s) => `/job/${encodeURIComponent(s)}`).join("");
    const headers = token ? { Authorization: "Basic " + Buffer.from(`${job.login}:${token}`).toString("base64") } : {};
    await request(`${job.base_url}${jobPath}/buildWithParameters`, { method: "POST", headers, body: new URLSearchParams(vars) });
    return `${job.base_url}${jobPath}/`;
  },
  async generic(job, token, vars) {
    const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const { json } = await request(job.base_url, { method: "POST", headers, body: JSON.stringify({ ref: job.ref, target: job.target, params: vars }) });
    return typeof json?.url === "string" ? json.url : typeof json?.web_url === "string" ? json.web_url : "";
  },
};

const toJob = (j) => ({
  id: j.id, name: j.name, kind: j.kind, baseUrl: j.base_url, target: j.target, ref: j.ref, login: j.login, params: j.params,
  hasToken: Boolean(j.secret_enc), created: j.created_at.getTime(),
});

const router = express.Router({ mergeParams: true });

// Список задач видят все участники (чтобы понимать, откуда запуски); менять и запускать — тестировщики
router.get("/ci-jobs", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ci_jobs WHERE project_key=$1 ORDER BY name", [req.params.key]);
  res.json({ jobs: rows.map(toJob) });
}));

router.post("/ci-jobs", wrap(async (req, res) => {
  const { j, error } = readJob(req.body);
  if (error) return res.status(400).json({ error });
  const { rows } = await pool.query(
    `INSERT INTO ci_jobs(project_key, name, kind, base_url, target, ref, login, secret_enc, params, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [req.params.key, j.name, j.kind, j.baseUrl, j.target, j.ref, j.login, secrets.encrypt(str(req.body.token, 2000)), JSON.stringify(j.params), req.user.id]
  );
  broadcast("ci");
  res.status(201).json({ id: rows[0].id });
}));

router.patch("/ci-jobs/:id", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ci_jobs WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: "Задача CI не найдена" });
  const { j, error } = readJob({ ...rows[0], ...req.body });
  if (error) return res.status(400).json({ error });
  const secret = req.body.token === undefined ? rows[0].secret_enc : secrets.encrypt(str(req.body.token, 2000));
  await pool.query(
    "UPDATE ci_jobs SET name=$1, kind=$2, base_url=$3, target=$4, ref=$5, login=$6, secret_enc=$7, params=$8 WHERE id=$9",
    [j.name, j.kind, j.baseUrl, j.target, j.ref, j.login, secret, JSON.stringify(j.params), rows[0].id]
  );
  broadcast("ci");
  res.json({ ok: true });
}));

router.delete("/ci-jobs/:id", wrap(async (req, res) => {
  const r = await pool.query("DELETE FROM ci_jobs WHERE project_key=$1 AND id=$2", [req.params.key, num(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Задача CI не найдена" });
  broadcast("ci");
  res.json({ ok: true });
}));

// Запуск: {"params": {"BROWSER": "firefox"}, "title": "…", "ref": "release/2.0"}
router.post("/ci-jobs/:id/trigger", wrap(async (req, res) => {
  const key = req.params.key;
  const { rows } = await pool.query("SELECT * FROM ci_jobs WHERE project_key=$1 AND id=$2", [key, num(req.params.id)]);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: "Задача CI не найдена" });
  const values = readValues(job, req.body.params && typeof req.body.params === "object" ? req.body.params : {});
  const ref = str(req.body.ref, 200) || job.ref;
  const summary = Object.entries(values).map(([k, v]) => `${k}=${v}`).join(", ");
  const title = str(req.body.title, 300) || `${job.name}${summary ? ` (${summary})` : ""}`.slice(0, 300);
  const n = await tx(async (db) => {
    const seq = await db.query("UPDATE projects SET auto_seq=auto_seq+1 WHERE key=$1 RETURNING auto_seq", [key]);
    await db.query(
      `INSERT INTO auto_runs(project_key, num, title, branch, state, params, ci_job_id, scope, created_by)
       VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8)`,
      [key, seq.rows[0].auto_seq, title, ref, values, job.id, job.name, req.user.id]
    );
    return seq.rows[0].auto_seq;
  });
  const vars = { ...values, TESTBALL_RUN: String(n), TESTBALL_PROJECT: key, ...(PUBLIC_URL ? { TESTBALL_URL: PUBLIC_URL } : {}) };
  try {
    const ciUrl = await TRIGGERS[job.kind]({ ...job, ref }, secrets.decrypt(job.secret_enc), vars);
    await pool.query("UPDATE auto_runs SET ci_url=$1 WHERE project_key=$2 AND num=$3", [ciUrl.slice(0, 1000), key, n]);
  } catch (e) {
    // запуск не состоялся — помечаем его, чтобы в истории было видно попытку
    await pool.query("UPDATE auto_runs SET state='failed', finished_at=now() WHERE project_key=$1 AND num=$2", [key, n]);
    broadcast("autoruns");
    throw e;
  }
  broadcast("autoruns");
  events.emit(key, "autorun.created", { autorun: await events.snap.autorun(key, n) }, req.user);
  res.status(201).json({ num: n, id: `${key}-A${n}` });
}));

module.exports = { router, readValues, readJob };
