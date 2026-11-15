// M-04: резервные копии из интерфейса, по расписанию и из CronJob (scripts/backup.js).
// Копия — один tar-файл:
//   db.dump        — pg_dump -Fc (custom format: pg_restore восстанавливает выборочно и параллельно);
//   uploads.tar.gz — вложения, если они на локальном диске (STORAGE=local). В S3 вложения уже лежат в отдельном
//                    хранилище: их защищают версионирование и репликация бакета, а копия проверяет, что все файлы на месте;
//   manifest.json  — версия, последняя миграция, число строк в основных таблицах, размеры и SHA-256 частей.
// Где хранятся: BACKUP_TARGET=local — каталог BACKUP_DIR; s3 — тот же бакет, префикс S3_BACKUP_PREFIX (по умолчанию
// при STORAGE=s3). Проверка: pg_restore --list разбирает дамп целиком; если задан BACKUP_VERIFY_DATABASE_URL —
// дамп восстанавливается в эту (пустую, служебную) базу и сверяется число строк.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const express = require("express");
const { pool } = require("./db");
const storage = require("./storage");
const jobs = require("./jobs");
const audit = require("./audit");
const version = require("./version");
const { wrap } = require("./util");

const TARGET = (process.env.BACKUP_TARGET || (storage.kind === "s3" ? "s3" : "local")) === "s3" && storage.s3store ? "s3" : "local";
const DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "data", "backups");
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
// 0 — по расписанию не делать (например, копии делает CronJob в Kubernetes)
const EVERY_HOURS = Math.max(0, Number(process.env.BACKUP_EVERY_HOURS ?? 24));
const VERIFY_URL = process.env.BACKUP_VERIFY_DATABASE_URL || "";
const WITH_UPLOADS = process.env.BACKUP_ATTACHMENTS !== "false";
const BIN = process.env.BACKUP_PG_BIN || ""; // каталог с pg_dump/pg_restore нужной версии
const TABLES = ["projects", "users", "test_cases", "test_runs", "run_results", "bugs", "attachments", "comments"];

const store =
  TARGET === "s3"
    ? storage.s3store((process.env.S3_BACKUP_PREFIX || "backups/").replace(/^\/+/, ""))
    : {
        async put(name, file) {
          await fs.promises.mkdir(DIR, { recursive: true });
          // rename не работает между дисками (/tmp → том с копиями) — тогда копируем
          await fs.promises.rename(file, path.join(DIR, name)).catch(async () => {
            await fs.promises.copyFile(file, path.join(DIR, name));
            await fs.promises.unlink(file);
          });
        },
        get: (name) => fs.createReadStream(path.join(DIR, name)),
        remove: (name) => fs.promises.unlink(path.join(DIR, name)).catch(() => {}),
      };

function run(cmd, args, opts = {}) {
  const bin = BIN ? path.join(BIN, cmd) : cmd;
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 256 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") return reject(new Error(`${cmd} не найден: в образе нужен клиент PostgreSQL (postgresql-client) той же или более новой версии, что и сервер; каталог можно задать в BACKUP_PG_BIN`));
        return reject(new Error(`${cmd}: ${(stderr || err.message).toString().trim().split("\n").slice(-3).join(" ")}`));
      }
      resolve(stdout.toString());
    });
  });
}

async function sha256(file) {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

async function counts(db) {
  const out = {};
  for (const t of TABLES) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t}`).catch(() => ({ rows: [{ n: null }] }));
    out[t] = rows[0].n;
  }
  return out;
}

async function lastMigration(db) {
  const { rows } = await db.query("SELECT max(name) AS name FROM schema_migrations");
  return rows[0].name;
}

// Все ли файлы вложений, записанные в базе, есть в хранилище
async function attachmentsCheck() {
  const [{ rows }, files] = await Promise.all([pool.query("SELECT id::text FROM attachments"), storage.list()]);
  const have = new Set(files.map((f) => f.name));
  const missing = rows.filter((r) => !have.has(r.id)).map((r) => r.id);
  return { rows: rows.length, files: files.length, missing: missing.length, missingSample: missing.slice(0, 10) };
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

// Проверка частей копии в каталоге dir: дамп читается целиком, архив вложений разбирается;
// с BACKUP_VERIFY_DATABASE_URL — пробное восстановление и сверка числа строк
async function verifyDir(dir, manifest) {
  const result = { at: new Date().toISOString(), ok: true, checks: [] };
  const fail = (what, note) => {
    result.ok = false;
    result.checks.push({ what, ok: false, note });
  };
  for (const part of manifest.files || []) {
    const sum = await sha256(path.join(dir, part.name)).catch(() => null);
    if (sum !== part.sha256) fail(`Контрольная сумма ${part.name}`, sum ? "не совпадает" : "файла нет");
  }
  const list = await run("pg_restore", ["--list", path.join(dir, "db.dump")]).catch((e) => fail("Чтение дампа", e.message));
  if (list !== undefined) {
    const tables = (list.match(/ TABLE DATA /g) || []).length;
    if (!tables) fail("Чтение дампа", "в дампе нет данных таблиц");
    else result.checks.push({ what: "Чтение дампа", ok: true, note: `таблиц с данными: ${tables}` });
  }
  if (manifest.files?.some((f) => f.name === "uploads.tar.gz")) {
    await run("tar", ["-tzf", path.join(dir, "uploads.tar.gz")]).then(
      (out) => result.checks.push({ what: "Архив вложений", ok: true, note: `файлов: ${out.split("\n").filter((l) => l && !l.endsWith("/")).length}` }),
      (e) => fail("Архив вложений", e.message)
    );
  }
  if (VERIFY_URL && result.ok) {
    const { Client } = require("pg");
    try {
      await run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--exit-on-error", "-d", VERIFY_URL, path.join(dir, "db.dump")]);
      const c = new Client({ connectionString: VERIFY_URL });
      await c.connect();
      try {
        const restored = await counts(c);
        const migration = await lastMigration(c);
        // строки могли добавиться между подсчётом и снимком — сравниваем мягко: пустая таблица там, где были строки, — ошибка
        const lost = Object.keys(manifest.counts || {}).filter((t) => manifest.counts[t] > 0 && !restored[t]);
        if (migration !== manifest.migration) fail("Пробное восстановление", `миграция ${migration}, ожидалась ${manifest.migration}`);
        else if (lost.length) fail("Пробное восстановление", `пустые таблицы: ${lost.join(", ")}`);
        else result.checks.push({ what: "Пробное восстановление", ok: true, note: `строк: ${Object.entries(restored).map(([t, n]) => `${t} ${n}`).join(", ")}` });
        result.restored = restored;
      } finally {
        await c.end();
      }
    } catch (e) {
      fail("Пробное восстановление", e.message);
    }
  } else if (!VERIFY_URL) {
    result.checks.push({ what: "Пробное восстановление", ok: null, note: "не настроено: задайте BACKUP_VERIFY_DATABASE_URL" });
  }
  return result;
}

async function finishRow(id, fields) {
  const keys = Object.keys(fields);
  await pool.query(`UPDATE backups SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

// Создать копию. trigger: manual | schedule | cron
async function create({ trigger = "manual", userId = null, id = null } = {}) {
  if (!id) id = (await reserve({ trigger, userId })).id;
  const { rows: [row] } = await pool.query("SELECT name FROM backups WHERE id = $1", [id]);
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tb-backup-"));
  const parts = path.join(tmp, "parts");
  await fs.promises.mkdir(parts);
  try {
    const manifest = {
      app: "TestBall QA",
      version: version.VERSION,
      commit: version.COMMIT || null,
      createdAt: new Date().toISOString(),
      migration: await lastMigration(pool),
      counts: await counts(pool),
      storage: storage.kind,
      attachments: await attachmentsCheck(),
      files: [],
    };
    await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", path.join(parts, "db.dump"), "--dbname", process.env.DATABASE_URL]);
    if (WITH_UPLOADS && storage.kind === "local") {
      await run("tar", ["-czf", path.join(parts, "uploads.tar.gz"), "-C", storage.DIR, "."]);
    }
    for (const name of await fs.promises.readdir(parts)) {
      const file = path.join(parts, name);
      manifest.files.push({ name, size: (await fs.promises.stat(file)).size, sha256: await sha256(file) });
    }
    await fs.promises.writeFile(path.join(parts, "manifest.json"), JSON.stringify(manifest, null, 2));
    const verify = await verifyDir(parts, manifest);
    if (manifest.attachments.missing) {
      verify.ok = false;
      verify.checks.push({ what: "Файлы вложений", ok: false, note: `в хранилище нет ${manifest.attachments.missing} из ${manifest.attachments.rows}` });
    } else verify.checks.push({ what: "Файлы вложений", ok: true, note: `все ${manifest.attachments.rows} на месте` });
    const tarFile = path.join(tmp, row.name);
    await run("tar", ["-cf", tarFile, "-C", parts, "."]);
    const size = (await fs.promises.stat(tarFile)).size;
    await store.put(row.name, tarFile);
    await finishRow(id, { status: "ok", size, manifest: JSON.stringify(manifest), verify: JSON.stringify(verify), finished_at: new Date() });
    await prune();
    return { id, name: row.name, size, verify };
  } catch (e) {
    await finishRow(id, { status: "failed", error: String(e.message).slice(0, 2000), finished_at: new Date() });
    throw e;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

async function reserve({ trigger, userId }) {
  let name = `testball-${stamp()}.tar`;
  // две копии в одну секунду — добавим счётчик
  for (let i = 2; ; i++) {
    const { rows } = await pool.query(
      "INSERT INTO backups(name, trigger, target, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING RETURNING id, name",
      [name, trigger, TARGET, userId]
    );
    if (rows[0]) return rows[0];
    name = `testball-${stamp()}-${i}.tar`;
  }
}

// Храним KEEP последних удачных копий; неудачные — 30 дней (без файлов)
async function prune() {
  const { rows } = await pool.query(
    `SELECT id, name, target FROM backups WHERE status = 'ok' ORDER BY started_at DESC OFFSET $1`,
    [KEEP]
  );
  for (const b of rows) {
    if (b.target === TARGET) await store.remove(b.name);
    await pool.query("DELETE FROM backups WHERE id = $1", [b.id]);
  }
  await pool.query("DELETE FROM backups WHERE status = 'failed' AND started_at < now() - interval '30 days'");
  // зависшие (сервер перезапустили посреди копии)
  await pool.query("UPDATE backups SET status = 'failed', error = 'Прервано: сервер перезапущен', finished_at = now() WHERE status = 'running' AND started_at < now() - interval '6 hours'");
}

// Проверить уже сохранённую копию: скачать, распаковать, проверить части
async function verifyExisting(id) {
  const { rows: [b] } = await pool.query("SELECT * FROM backups WHERE id = $1 AND status = 'ok'", [id]);
  if (!b) throw new Error("Копия не найдена");
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tb-verify-"));
  try {
    const tarFile = path.join(tmp, b.name);
    await new Promise((resolve, reject) => {
      const src = store.get(b.name);
      src.on("error", reject);
      src.pipe(fs.createWriteStream(tarFile)).on("finish", resolve).on("error", reject);
    });
    const parts = path.join(tmp, "parts");
    await fs.promises.mkdir(parts);
    await run("tar", ["-xf", tarFile, "-C", parts]);
    const manifest = JSON.parse(await fs.promises.readFile(path.join(parts, "manifest.json"), "utf8"));
    const verify = await verifyDir(parts, manifest);
    await finishRow(id, { verify: JSON.stringify(verify) });
    return verify;
  } catch (e) {
    const verify = { at: new Date().toISOString(), ok: false, checks: [{ what: "Чтение копии", ok: false, note: e.message }] };
    await finishRow(id, { verify: JSON.stringify(verify) });
    return verify;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

jobs.define("backup.create", (p) => create({ trigger: p.trigger || "schedule", userId: p.userId || null, id: p.id || null }), {
  maxAttempts: 1,
  timeoutMs: 6 * 3600e3,
  title: "Резервная копия",
});
jobs.define("backup.verify", (p) => verifyExisting(p.id), { maxAttempts: 1, timeoutMs: 6 * 3600e3, title: "Проверка резервной копии" });

function startSchedule() {
  if (EVERY_HOURS > 0) jobs.every("backup.scheduled", EVERY_HOURS * 3600e3);
}
jobs.define("backup.scheduled", () => create({ trigger: "schedule" }), { maxAttempts: 1, timeoutMs: 6 * 3600e3, title: "Резервная копия по расписанию" });

// ---------- API администратора: /api/admin/backups ----------
const router = express.Router();
const out = (b) => ({
  id: b.id,
  name: b.name,
  status: b.status,
  trigger: b.trigger,
  target: b.target,
  size: b.size === null ? null : Number(b.size),
  manifest: b.manifest,
  verify: b.verify,
  error: b.error,
  createdBy: b.login || null,
  startedAt: b.started_at ? +new Date(b.started_at) : null,
  finishedAt: b.finished_at ? +new Date(b.finished_at) : null,
});

router.get("/backups", wrap(async (_req, res) => {
  const { rows } = await pool.query("SELECT b.*, u.login FROM backups b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.started_at DESC LIMIT 200");
  res.json({
    backups: rows.map(out),
    settings: { target: TARGET, dir: TARGET === "local" ? DIR : null, keep: KEEP, everyHours: EVERY_HOURS, verifyRestore: !!VERIFY_URL, attachments: storage.kind === "local" ? (WITH_UPLOADS ? "в копии" : "не копируются") : "в S3" },
  });
}));

router.post("/backups", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT 1 FROM backups WHERE status = 'running' AND started_at > now() - interval '6 hours'");
  if (rows.length) return res.status(409).json({ error: "Резервная копия уже создаётся" });
  const b = await reserve({ trigger: "manual", userId: req.user.id });
  await jobs.enqueue("backup.create", { id: b.id, trigger: "manual", userId: req.user.id });
  audit.log(req, "backup.create", { project: null, target: b.name });
  res.status(202).json({ id: b.id, name: b.name });
}));

router.post("/backups/:id/verify", wrap(async (req, res) => {
  const { rows: [b] } = await pool.query("SELECT name FROM backups WHERE id = $1 AND status = 'ok'", [Number(req.params.id) || 0]);
  if (!b) return res.status(404).json({ error: "Копия не найдена" });
  await jobs.enqueue("backup.verify", { id: Number(req.params.id) }, { key: `backup.verify:${req.params.id}` });
  res.status(202).json({ ok: true });
}));

router.get("/backups/:id/download", wrap(async (req, res) => {
  const { rows: [b] } = await pool.query("SELECT name, size, target FROM backups WHERE id = $1 AND status = 'ok'", [Number(req.params.id) || 0]);
  if (!b) return res.status(404).json({ error: "Копия не найдена" });
  if (b.target !== TARGET) return res.status(409).json({ error: "Копия сохранена в другом хранилище" });
  audit.log(req, "backup.download", { project: null, target: b.name });
  res.setHeader("content-type", "application/x-tar");
  res.setHeader("content-disposition", `attachment; filename="${b.name}"`);
  if (b.size) res.setHeader("content-length", String(b.size));
  const src = store.get(b.name);
  src.on("error", (e) => {
    if (!res.headersSent) res.status(404).json({ error: `Файл копии недоступен: ${e.code === "ENOENT" ? "удалён с диска" : e.message}` });
    else res.destroy(e);
  });
  src.pipe(res);
}));

router.delete("/backups/:id", wrap(async (req, res) => {
  const { rows: [b] } = await pool.query("DELETE FROM backups WHERE id = $1 AND status <> 'running' RETURNING name, target", [Number(req.params.id) || 0]);
  if (!b) return res.status(404).json({ error: "Копия не найдена" });
  if (b.target === TARGET) await store.remove(b.name);
  audit.log(req, "backup.delete", { project: null, target: b.name });
  res.json({ ok: true });
}));

module.exports = { router, create, verifyExisting, verifyDir, startSchedule, prune, TARGET, DIR };
