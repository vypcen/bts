// Общие помощники для тестов: отдельная база на каждый файл тестов и сервер в дочернем процессе.
// Нужен PostgreSQL: TEST_DATABASE_URL — адрес служебной базы, у пользователя есть право CREATE DATABASE
// (по умолчанию postgres://postgres@localhost:5432/postgres). В CI его поднимает сервис postgres.
const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");
const { Client } = require("pg");

const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://postgres@localhost:5432/postgres";
const ROOT = path.join(__dirname, "..");
const SETUP_CODE = "test-setup-code";

function dbUrl(name) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function createDb() {
  const name = `tb_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  return name;
}

async function dropDb(name) {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.end();
}

// Сервер на свежей базе. env — дополнительные переменные окружения
async function startServer(env = {}) {
  const db = await createDb();
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(db),
      PORT: String(port),
      SETUP_CODE,
      REGISTRATION: "open",
      TRUST_PROXY: "false",
      LLM_URL: "",
      STORAGE: "local",
      UPLOAD_DIR: path.join(require("node:os").tmpdir(), db),
      NODE_ENV: "test",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Сервер завершился при старте:\n${log}`);
    try {
      const r = await fetch(`${base}/readyz`);
      if (r.ok) break;
    } catch {}
    if (Date.now() - started > 30000) throw new Error(`Сервер не поднялся за 30 с:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    base,
    db,
    dbUrl: dbUrl(db),
    log: () => log,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
      await dropDb(db);
    },
  };
}

// Клиент с cookie-сессией (или токеном)
function client(base, { token } = {}) {
  let cookie = "";
  async function call(method, url, body, headers = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined && !(body instanceof Buffer)) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    } else if (body instanceof Buffer) payload = body;
    else if (method !== "GET") {
      h["content-type"] = "application/json";
      payload = "{}";
    }
    const r = await fetch(base + url, { method, headers: h, body: payload, redirect: "manual" });
    const set = r.headers.getSetCookie?.() || [];
    for (const c of set) {
      const pair = c.split(";")[0];
      if (/=$/.test(pair) || /Max-Age=0/i.test(c)) cookie = "";
      else cookie = pair;
    }
    const type = r.headers.get("content-type") || "";
    const data = type.includes("json") ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers };
  }
  return {
    get: (u, h) => call("GET", u, undefined, h),
    post: (u, b, h) => call("POST", u, b, h),
    patch: (u, b, h) => call("PATCH", u, b, h),
    put: (u, b, h) => call("PUT", u, b, h),
    del: (u, b, h) => call("DELETE", u, b, h),
    raw: call,
    get cookie() {
      return cookie;
    },
  };
}

// Типовой набор: админ, тестировщик, разработчик и проект LK
async function seed(srv) {
  const admin = client(srv.base);
  let r = await admin.post("/api/auth/register", { login: "admin", name: "Админ", password: "password123", setupCode: SETUP_CODE });
  if (r.status !== 201) throw new Error(`register admin: ${r.status} ${JSON.stringify(r.data)}`);
  for (const [login, role] of [["tester", "tester"], ["dev", "developer"], ["viewer", "viewer"], ["outsider", "tester"]]) {
    r = await admin.post("/api/admin/users", { login, name: login, password: "password123", role });
    if (r.status !== 201) throw new Error(`create ${login}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  r = await admin.post("/api/projects", { key: "LK", name: "Личный кабинет" });
  if (r.status !== 201) throw new Error(`project: ${r.status} ${JSON.stringify(r.data)}`);
  for (const login of ["tester", "dev", "viewer"]) await admin.put(`/api/admin/users/${login}/projects`, { projects: ["LK"] });
  const login = async (name) => {
    const c = client(srv.base);
    const res = await c.post("/api/auth/login", { login: name, password: "password123" });
    if (res.status !== 200) throw new Error(`login ${name}: ${res.status}`);
    return c;
  };
  return { admin, tester: await login("tester"), dev: await login("dev"), viewer: await login("viewer"), outsider: await login("outsider") };
}

module.exports = { startServer, client, seed, SETUP_CODE, ADMIN_URL, dbUrl, createDb, dropDb };
