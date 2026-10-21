const path = require("path");
const express = require("express");
const { pool, tx } = require("./db");
const { migrate, waitForDb } = require("./migrate");
const auth = require("./auth");
const live = require("./live");
const attachments = require("./attachments");
const { wrap, str, num, ms } = require("./util");

const PORT = Number(process.env.PORT || 3000);
// Статус готовности кейса. Результат прохождения хранится в прогонах (server/runs.js)
const STATUSES = ["draft", "ready", "deprecated"];
const PRIORITIES = ["critical", "high", "medium", "low"];
const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
const KEY_RE = /^[A-Z]{2,6}$/;
const { broadcast } = live;

const app = express();
app.disable("x-powered-by");
// За обратным прокси (Cloudflare Tunnel, Caddy, nginx) нужно доверять X-Forwarded-*, чтобы cookie получали флаг Secure
app.set("trust proxy", process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal");

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  next();
});
app.use(express.json({ limit: "200kb" }));

// Защита от CSRF: изменяющие запросы принимаются только как JSON.
// Загрузка файла идёт «сырым» телом, поэтому требует заголовок X-Upload: чужой сайт не может
// прислать его без CORS-разрешения, которого сервер не даёт.
app.use("/api", (req, res, next) => {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && !req.is("application/json")) {
    const upload = req.method === "POST" && req.path.endsWith("/attachments") && req.get("x-upload") === "1";
    if (!upload) return res.status(415).json({ error: "Ожидается Content-Type: application/json" });
  }
  next();
});
app.use(auth.loadUser);

app.get("/api/events", auth.requireUser, live.events);

// ---------- авторизация ----------
app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.user ? { login: req.user.login, name: req.user.name } : null });
});

app.post("/api/auth/register", wrap(async (req, res) => {
  const login = str(req.body.login, 64).toLowerCase();
  const name = str(req.body.name, 100);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!LOGIN_RE.test(login)) return res.status(400).json({ error: "Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание" });
  if (!name) return res.status(400).json({ error: "Укажите имя" });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Пароль должен быть от 8 до 200 символов" });
  const hash = await auth.hashPassword(password);
  const { rows } = await pool.query(
    "INSERT INTO users(login, name, password_hash) VALUES ($1,$2,$3) ON CONFLICT (login) DO NOTHING RETURNING id",
    [login, name, hash]
  );
  if (!rows[0]) return res.status(409).json({ error: "Логин уже занят. Выберите другой или войдите" });
  await auth.createSession(res, req, rows[0].id);
  broadcast("users");
  res.status(201).json({ user: { login, name } });
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const login = str(req.body.login, 64).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const key = `${req.ip}|${login}`;
  if (auth.tooManyAttempts(key)) return res.status(429).json({ error: "Слишком много попыток входа. Подождите 15 минут" });
  const { rows } = await pool.query("SELECT id, login, name, password_hash FROM users WHERE login=$1", [login]);
  const u = rows[0];
  const check = u ? await auth.verifyPassword(password, u.password_hash) : { ok: false };
  if (!check.ok) {
    auth.recordFailure(key);
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  auth.clearFailures(key);
  if (check.legacy) {
    // пароль из прошлой версии — сразу перехэшируем в bcrypt
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await auth.hashPassword(password), u.id]);
  }
  await auth.createSession(res, req, u.id);
  res.json({ user: { login: u.login, name: u.name } });
}));

app.post("/api/auth/logout", wrap(async (req, res) => {
  await auth.destroySession(req, res);
  res.json({ ok: true });
}));

// ---------- данные ----------
const caseSql = `SELECT c.project_key, c.num, c.title, c.priority, c.status, c.preconditions, c.steps, c.expected,
  cu.login AS created_by, uu.login AS updated_by, c.created_at, c.updated_at
  FROM test_cases c LEFT JOIN users cu ON cu.id=c.created_by LEFT JOIN users uu ON uu.id=c.updated_by`;
const toCase = (r) => ({
  id: `${r.project_key}-${r.num}`, pid: r.project_key, num: r.num, title: r.title, priority: r.priority, status: r.status,
  pre: r.preconditions, steps: r.steps, expected: r.expected, createdBy: r.created_by, updatedBy: r.updated_by,
  created: r.created_at.getTime(), updated: r.updated_at.getTime(),
});

// Всё состояние одним запросом: для MVP-объёмов это проще и надёжнее точечной синхронизации
app.get("/api/state", auth.requireUser, wrap(async (_req, res) => {
  const [projects, cases, users, runs, results, bugs, files] = await Promise.all([
    pool.query(`SELECT p.key, p.name, p.description, p.created_at, u.login AS created_by
                FROM projects p LEFT JOIN users u ON u.id=p.created_by ORDER BY p.created_at DESC`),
    pool.query(`${caseSql} ORDER BY c.project_key, c.num`),
    pool.query("SELECT login, name FROM users"),
    pool.query(`SELECT r.project_key, r.num, r.title, r.build, r.environment, r.state, u.login AS created_by, r.created_at, r.closed_at
                FROM test_runs r LEFT JOIN users u ON u.id=r.created_by ORDER BY r.project_key, r.num`),
    pool.query(`SELECT rr.id, t.project_key, t.num AS run_num, c.num AS case_num, rr.result, rr.comment, u.login AS executed_by, rr.executed_at
                FROM run_results rr JOIN test_runs t ON t.id=rr.run_id JOIN test_cases c ON c.id=rr.case_id
                LEFT JOIN users u ON u.id=rr.executed_by`),
    pool.query(`SELECT b.project_key, b.num, b.title, b.status, b.severity, au.login AS assignee, b.environment, b.steps, b.actual, b.expected,
                  c.num AS case_num, t.num AS run_num, b.run_result_id, d.num AS dup_num,
                  cu.login AS created_by, uu.login AS updated_by, b.created_at, b.updated_at
                FROM bugs b LEFT JOIN users au ON au.id=b.assignee_id LEFT JOIN test_cases c ON c.id=b.case_id
                LEFT JOIN run_results rr ON rr.id=b.run_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
                LEFT JOIN bugs d ON d.id=b.duplicate_of
                LEFT JOIN users cu ON cu.id=b.created_by LEFT JOIN users uu ON uu.id=b.updated_by
                ORDER BY b.project_key, b.num`),
    pool.query(`SELECT a.id, COALESCE(b.project_key, t.project_key) AS project_key, b.num AS bug_num, a.run_result_id,
                  a.filename, a.mime, a.size, u.login AS uploaded_by, a.created_at
                FROM attachments a LEFT JOIN bugs b ON b.id=a.bug_id
                LEFT JOIN run_results rr ON rr.id=a.run_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
                LEFT JOIN users u ON u.id=a.uploaded_by ORDER BY a.created_at`),
  ]);
  res.json({
    projects: projects.rows.map((p) => ({ id: p.key, name: p.name, desc: p.description, createdBy: p.created_by, created: p.created_at.getTime() })),
    cases: cases.rows.map(toCase),
    runs: runs.rows.map((r) => ({
      id: `${r.project_key}-R${r.num}`, pid: r.project_key, num: r.num, title: r.title, build: r.build, env: r.environment,
      state: r.state, createdBy: r.created_by, created: ms(r.created_at), closed: ms(r.closed_at),
    })),
    results: results.rows.map((r) => ({
      id: r.id, pid: r.project_key, runNum: r.run_num, caseNum: r.case_num, result: r.result, comment: r.comment,
      executedBy: r.executed_by, executed: ms(r.executed_at),
    })),
    bugs: bugs.rows.map((b) => ({
      id: `${b.project_key}-B${b.num}`, pid: b.project_key, num: b.num, title: b.title, status: b.status, severity: b.severity,
      assignee: b.assignee, env: b.environment, steps: b.steps, actual: b.actual, expected: b.expected,
      caseNum: b.case_num, runNum: b.run_num, resultId: b.run_result_id, duplicateOf: b.dup_num,
      createdBy: b.created_by, updatedBy: b.updated_by, created: ms(b.created_at), updated: ms(b.updated_at),
    })),
    attachments: files.rows.map((a) => ({
      id: a.id, pid: a.project_key, bugNum: a.bug_num, resultId: a.run_result_id, name: a.filename, mime: a.mime, size: a.size,
      uploadedBy: a.uploaded_by, created: ms(a.created_at),
    })),
    users: Object.fromEntries(users.rows.map((u) => [u.login, { name: u.name }])),
  });
}));

app.post("/api/projects", auth.requireUser, wrap(async (req, res) => {
  const key = str(req.body.key, 10).toUpperCase();
  const name = str(req.body.name, 200);
  const desc = str(req.body.desc, 2000);
  if (!name) return res.status(400).json({ error: "Укажите название проекта" });
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "Ключ: от 2 до 6 латинских букв" });
  const { rows } = await pool.query(
    "INSERT INTO projects(key, name, description, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING RETURNING key",
    [key, name, desc, req.user.id]
  );
  if (!rows[0]) return res.status(409).json({ error: `Ключ ${key} уже занят другим проектом` });
  broadcast("projects");
  res.status(201).json({ id: key });
}));

app.patch("/api/projects/:key", auth.requireUser, wrap(async (req, res) => {
  const name = str(req.body.name, 200);
  const desc = str(req.body.desc, 2000);
  if (!name) return res.status(400).json({ error: "Укажите название проекта" });
  const r = await pool.query("UPDATE projects SET name=$1, description=$2 WHERE key=$3", [name, desc, req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: "Проект не найден" });
  broadcast("projects");
  res.json({ ok: true });
}));

app.delete("/api/projects/:key", auth.requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT created_by FROM projects WHERE key=$1", [req.params.key]);
  if (!rows[0]) return res.status(404).json({ error: "Проект не найден" });
  if (rows[0].created_by !== null && rows[0].created_by !== req.user.id) {
    return res.status(403).json({ error: "Удалить проект может только его создатель" });
  }
  await pool.query("DELETE FROM projects WHERE key=$1", [req.params.key]); // кейсы, прогоны и баги удалятся каскадно
  broadcast("projects");
  res.json({ ok: true });
}));

function readCase(body) {
  const c = {
    title: str(body.title, 500),
    priority: str(body.priority, 20),
    status: str(body.status, 20),
    pre: str(body.pre),
    steps: str(body.steps),
    expected: str(body.expected),
  };
  if (!c.title) return { error: "Укажите название тест-кейса" };
  if (!PRIORITIES.includes(c.priority)) return { error: "Неизвестный приоритет" };
  if (!STATUSES.includes(c.status)) return { error: "Неизвестный статус" };
  return { c };
}

app.post("/api/projects/:key/cases", auth.requireUser, wrap(async (req, res) => {
  const { c, error } = readCase(req.body);
  if (error) return res.status(400).json({ error });
  const n = await tx(async (db) => {
    // атомарно берём следующий номер — два одновременных создания не получат один ID
    const r = await db.query("UPDATE projects SET seq=seq+1 WHERE key=$1 RETURNING seq", [req.params.key]);
    if (!r.rows[0]) return null;
    const next = r.rows[0].seq;
    await db.query(
      `INSERT INTO test_cases(project_key, num, title, priority, status, preconditions, steps, expected, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [req.params.key, next, c.title, c.priority, c.status, c.pre, c.steps, c.expected, req.user.id]
    );
    return next;
  });
  if (n === null) return res.status(404).json({ error: "Проект не найден" });
  broadcast("cases");
  res.status(201).json({ id: `${req.params.key}-${n}`, num: n });
}));

app.patch("/api/projects/:key/cases/:num", auth.requireUser, wrap(async (req, res) => {
  const n = num(req.params.num);
  // частичное обновление: можно прислать только status
  const { rows } = await pool.query("SELECT title, priority, status, preconditions AS pre, steps, expected FROM test_cases WHERE project_key=$1 AND num=$2", [req.params.key, n]);
  if (!rows[0]) return res.status(404).json({ error: "Тест-кейс не найден" });
  const { c, error } = readCase({ ...rows[0], ...req.body });
  if (error) return res.status(400).json({ error });
  await pool.query(
    `UPDATE test_cases SET title=$1, priority=$2, status=$3, preconditions=$4, steps=$5, expected=$6, updated_by=$7, updated_at=now()
     WHERE project_key=$8 AND num=$9`,
    [c.title, c.priority, c.status, c.pre, c.steps, c.expected, req.user.id, req.params.key, n]
  );
  broadcast("cases");
  res.json({ ok: true });
}));

app.delete("/api/projects/:key/cases/:num", auth.requireUser, wrap(async (req, res) => {
  const r = await pool.query("DELETE FROM test_cases WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  if (!r.rowCount) return res.status(404).json({ error: "Тест-кейс не найден" });
  broadcast("cases");
  res.json({ ok: true });
}));

app.use("/api/projects/:key", auth.requireUser, require("./runs"), require("./bugs"), attachments.projectRouter);
app.use("/api/attachments", auth.requireUser, attachments.fileRouter);

app.get("/healthz", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "Не найдено" }));
// Интерфейс собирается из web/ командой npm run build:web (в Docker — автоматически)
app.use(express.static(path.join(__dirname, "..", "public"), { index: "index.html", maxAge: 0 }));

app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Некорректный JSON" });
  console.error("[server]", err);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: "Внутренняя ошибка сервера. Подробности в логах." });
});

(async () => {
  await waitForDb();
  await migrate();
  attachments.startSweeper();
  app.listen(PORT, "0.0.0.0", () => console.log(`[server] Testbed QA запущен: http://localhost:${PORT}`));
})().catch((e) => {
  console.error("[server] Не удалось запуститься:", e.message);
  process.exit(1);
});
