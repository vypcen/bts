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
