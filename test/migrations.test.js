// Миграции: накат с нуля, повторный старт ничего не ломает, имена уникальны и идут по порядку
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { startServer } = require("./helpers");

test("имена миграций: NNN_название.sql, номера без пропусков и повторов", () => {
  const files = fs.readdirSync(path.join(__dirname, "..", "server", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  files.forEach((f, i) => assert.match(f, new RegExp(`^${String(i + 1).padStart(3, "0")}_[a-z0-9_]+\\.sql$`), f));
});

test("накат с нуля и повторный запуск на той же базе", async () => {
  const srv = await startServer();
  const url = srv.dbUrl;
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows } = await c.query("SELECT count(*)::int AS n FROM schema_migrations");
  const total = fs.readdirSync(path.join(__dirname, "..", "server", "migrations")).filter((f) => f.endsWith(".sql")).length;
  assert.equal(rows[0].n, total);
  await c.end();
  // второй процесс на той же базе: миграции уже применены, сервер должен подняться
  const { spawn } = require("node:child_process");
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: url, PORT: String(port), LLM_URL: "" },
    stdio: "ignore",
  });
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 150));
    ok = await fetch(`http://127.0.0.1:${port}/readyz`).then((r) => r.ok, () => false);
  }
  child.kill("SIGTERM");
  await new Promise((r) => child.on("exit", r));
  assert.ok(ok, "второй старт на той же базе");
  await srv.stop();
});

test("откат на старую версию: сервер не стартует на базе от более новой версии", async () => {
  const srv = await startServer();
  const c = new Client({ connectionString: srv.dbUrl });
  await c.connect();
  const { rows } = await c.query("SELECT version FROM app_versions");
  assert.deepEqual(rows.map((r) => r.version), [require("../package.json").version]);
  const { spawnSync } = require("node:child_process");
  const run = (env = {}) =>
    spawnSync(process.execPath, ["-e", "require('./server/migrate').migrate().then(()=>process.exit(0),(e)=>{console.error(e.message);process.exit(1)})"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: srv.dbUrl, ...env },
      encoding: "utf8",
    });
  // базу уже запускала версия 99.0.0
  await c.query("INSERT INTO app_versions(version) VALUES ('99.0.0')");
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /более новой версией TestBall \(99\.0\.0\)/);
  assert.equal(run({ ALLOW_DOWNGRADE: "1" }).status, 0);
  // или в базе миграция, о которой этот код не знает
  await c.query("DELETE FROM app_versions WHERE version='99.0.0'");
  await c.query("INSERT INTO schema_migrations(name) VALUES ('999_future.sql')");
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /999_future\.sql/);
  await c.end();
  await srv.stop();
});
