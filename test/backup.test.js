// M-04: резервные копии из интерфейса — создание, проверка с пробным восстановлением, скачивание,
// восстановление скриптом, хранение последних N, ошибки
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { Client } = require("pg");
const { startServer, seed, createDb, dropDb, dbUrl } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-bk-test-"));
const BACKUP_DIR = path.join(tmp, "backups");
let srv, u, verifyDb, restoreDb;

test.before(async () => {
  verifyDb = await createDb();
  restoreDb = await createDb();
  srv = await startServer({ BACKUP_DIR, BACKUP_EVERY_HOURS: "0", BACKUP_KEEP: "2", BACKUP_VERIFY_DATABASE_URL: dbUrl(verifyDb), JOB_POLL_MS: "100" });
  u = await seed(srv);
});
test.after(async () => {
  srv && (await srv.stop());
  for (const d of [verifyDb, restoreDb]) if (d) await dropDb(d);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function waitDone(id) {
  for (let i = 0; i < 200; i++) {
    const b = (await u.admin.get("/api/admin/backups")).data.backups.find((x) => x.id === id);
    if (b && b.status !== "running") return b;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("копия не завершилась");
}

const uploadDir = () => path.join(os.tmpdir(), srv.db);

test("копия: права, создание, проверка с пробным восстановлением, скачивание и восстановление", async () => {
  const bug = await u.tester.post("/api/projects/LK/bugs", { title: "Не входит", severity: "critical" });
  assert.equal(bug.status, 201);
  const up = await fetch(`${srv.base}/api/projects/LK/bugs/${bug.data.num}/attachments`, {
    method: "POST", headers: { cookie: u.tester.cookie, "x-upload": "1", "content-type": "text/plain", "x-filename": "log.txt" }, body: Buffer.from("журнал"),
  });
  assert.equal(up.status, 201);

  assert.equal((await u.tester.post("/api/admin/backups", {})).status, 403, "только администратор");
  assert.equal((await u.tester.get("/api/admin/backups")).status, 403);

  const r = await u.admin.post("/api/admin/backups", {});
  assert.equal(r.status, 202);
  assert.match(r.data.name, /^testball-\d{8}-\d{6}(-\d+)?\.tar$/);
  const b = await waitDone(r.data.id);
  assert.equal(b.status, "ok", b.error);
  assert.equal(b.trigger, "manual");
  assert.equal(b.createdBy, "admin");
  assert.equal(b.manifest.counts.bugs, 1);
  assert.equal(b.manifest.attachments.rows, 1);
  assert.ok(b.verify.ok, JSON.stringify(b.verify));
  const restoreCheck = b.verify.checks.find((c) => c.what === "Пробное восстановление");
  assert.equal(restoreCheck.ok, true, "дамп восстановился в служебную базу");
  assert.ok(fs.existsSync(path.join(BACKUP_DIR, b.name)));
  const list = await u.admin.get("/api/admin/backups");
  assert.equal(list.data.settings.target, "local");
  assert.equal(list.data.settings.verifyRestore, true);

  // скачивание — тот же tar
  const dl = await fetch(`${srv.base}/api/admin/backups/${b.id}/download`, { headers: { cookie: u.admin.cookie } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition"), /testball-.*\.tar/);
  const file = path.join(tmp, "dl.tar");
  fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
  const names = execFileSync("tar", ["-tf", file]).toString();
  for (const n of ["db.dump", "uploads.tar.gz", "manifest.json"]) assert.ok(names.includes(n), n);
  assert.equal((await fetch(`${srv.base}/api/admin/backups/${b.id}/download`, { headers: { cookie: u.tester.cookie } })).status, 403);

  // проверка скриптом
  const env = { ...process.env, DATABASE_URL: srv.dbUrl, STORAGE: "local", UPLOAD_DIR: uploadDir(), BACKUP_DIR };
  let p = spawnSync(process.execPath, [path.join(ROOT, "scripts/backup.js"), "verify", file], { env, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr + p.stdout);
  assert.match(p.stdout, /✓ Чтение дампа/);

  // восстановление в чистую базу без --yes отказывает, с --yes — восстанавливает базу и вложения
  const restoreUploads = path.join(tmp, "restored-uploads");
  const renv = { ...env, DATABASE_URL: dbUrl(restoreDb), UPLOAD_DIR: restoreUploads };
  p = spawnSync(process.execPath, [path.join(ROOT, "scripts/backup.js"), "restore", file], { env: renv, encoding: "utf8" });
  assert.equal(p.status, 1);
  assert.match(p.stderr, /--yes/);
  p = spawnSync(process.execPath, [path.join(ROOT, "scripts/backup.js"), "restore", file, "--yes"], { env: renv, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr + p.stdout);
  const c = new Client({ connectionString: dbUrl(restoreDb) });
  await c.connect();
  let rows;
  try {
    ({ rows } = await c.query("SELECT a.id::text, b.title FROM bugs b JOIN attachments a ON a.bug_id = b.id"));
  } finally {
    await c.end();
  }
  assert.equal(rows[0].title, "Не входит");
  assert.equal(fs.readFileSync(path.join(restoreUploads, rows[0].id), "utf8"), "журнал");
});

test("копия замечает пропавшие файлы вложений; хранятся последние BACKUP_KEEP; удаление; журнал", async () => {
  const before = (await u.admin.get("/api/admin/backups")).data.backups;
  // файл вложения пропал с диска
  for (const f of fs.readdirSync(uploadDir())) fs.unlinkSync(path.join(uploadDir(), f));
  const r = await u.admin.post("/api/admin/backups", {});
  const b = await waitDone(r.data.id);
  assert.equal(b.status, "ok");
  assert.equal(b.verify.ok, false);
  assert.match(b.verify.checks.find((c) => c.what === "Файлы вложений").note, /нет 1 из 1/);

  const r3 = await u.admin.post("/api/admin/backups", {});
  await waitDone(r3.data.id);
  const after = (await u.admin.get("/api/admin/backups")).data.backups.filter((x) => x.status === "ok");
  assert.equal(after.length, 2, "BACKUP_KEEP=2");
  assert.ok(!after.some((x) => x.id === before[0].id), "самая старая удалена");
  assert.ok(!fs.existsSync(path.join(BACKUP_DIR, before[0].name)), "и её файл тоже");

  // повторная проверка в фоне
  assert.equal((await u.admin.post(`/api/admin/backups/${after[0].id}/verify`, {})).status, 202);

  const del = await u.admin.del(`/api/admin/backups/${after[1].id}`);
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(path.join(BACKUP_DIR, after[1].name)));
  assert.equal((await u.admin.del(`/api/admin/backups/${after[1].id}`)).status, 404);

  const audit = await u.admin.get("/api/admin/audit?action=backup.create");
  assert.ok(audit.data.items.length >= 1);
});

test("скрипт create (CronJob): без pg_dump — понятная ошибка и запись «ошибка»", async () => {
  const env = { ...process.env, DATABASE_URL: srv.dbUrl, STORAGE: "local", UPLOAD_DIR: uploadDir(), BACKUP_DIR, BACKUP_PG_BIN: "/nonexistent" };
  const p = spawnSync(process.execPath, [path.join(ROOT, "scripts/backup.js"), "create"], { env, encoding: "utf8" });
  assert.equal(p.status, 1);
  assert.match(p.stderr, /pg_dump не найден/);
  const failed = (await u.admin.get("/api/admin/backups")).data.backups.find((x) => x.status === "failed");
  assert.equal(failed.trigger, "cron");
  assert.match(failed.error, /postgresql-client/);
});
