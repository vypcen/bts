// Вложения к багам, к результатам в прогонах и к результатам автотестов. Файлы хранятся под именем id
// на диске (UPLOAD_DIR) или в S3 (server/storage.js), метаданные — в таблице attachments.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const express = require("express");
const { pool } = require("./db");
const { broadcast } = require("./live");
const access = require("./access");
const storage = require("./storage");
const { wrap, num } = require("./util");

const DIR = storage.DIR;
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 20) * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Эти типы браузер может показать прямо на странице; всё остальное отдаётся только на скачивание
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"]);

function cleanName(raw) {
  let name = "";
  try { name = decodeURIComponent(raw || ""); } catch { name = ""; }
  name = path.basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f"]/g, "").trim().slice(0, 200);
  return name || "file";
}

async function save(req, res, owner) {
  const size = Number(req.get("content-length"));
  if (!size) return res.status(400).json({ error: "Пустой файл" });
  if (size > MAX_BYTES) return res.status(413).json({ error: `Файл больше ${MAX_BYTES / 1024 / 1024} МБ` });
  const id = crypto.randomUUID();
  const tmp = path.join(storage.tmpDir, `${id}.part`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(bytes > MAX_BYTES ? new Error("too large") : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, fs.createWriteStream(tmp));
    // сначала файл занимает своё место, потом появляется запись: запись без файла невозможна,
    // а файл без записи уберёт sweep()
    await storage.put(id, tmp);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    if (bytes > MAX_BYTES) return res.status(413).json({ error: `Файл больше ${MAX_BYTES / 1024 / 1024} МБ` });
    throw e;
  }
  const mime = (req.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase().slice(0, 100);
  try {
    await pool.query(
      "INSERT INTO attachments(id, bug_id, run_result_id, auto_result_id, filename, mime, size, uploaded_by, step_index) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, owner.bugId || null, owner.resultId || null, owner.autoResultId || null, cleanName(req.get("x-filename")), mime, bytes, req.user.id, owner.step ?? null]
    );
  } catch (e) {
    await storage.remove(id);
    throw e;
  }
  broadcast(owner.autoResultId ? "autoruns" : "attachments");
  res.status(201).json({ id });
}

const projectRouter = express.Router({ mergeParams: true });

projectRouter.post("/bugs/:num/attachments", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT id FROM bugs WHERE project_key=$1 AND num=$2", [req.params.key, num(req.params.num)]);
  if (!rows[0]) return res.status(404).json({ error: "Баг не найден" });
  await save(req, res, { bugId: rows[0].id });
}));

projectRouter.post("/runs/:num/results/:case/attachments", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT rr.id FROM run_results rr JOIN test_runs t ON t.id=rr.run_id JOIN test_cases c ON c.id=rr.case_id
     WHERE t.project_key=$1 AND t.num=$2 AND c.num=$3`,
    [req.params.key, num(req.params.num), num(req.params.case)]
  );
  if (!rows[0]) return res.status(404).json({ error: "Кейс не входит в этот прогон" });
  // ?step=2 — вложение к шагу (скриншот упавшего шага)
  const step = req.query.step === undefined ? null : Number(req.query.step);
  if (step !== null && (!Number.isInteger(step) || step < 0 || step > 1000)) return res.status(400).json({ error: "step — номер шага с 0" });
  await save(req, res, { resultId: rows[0].id, step });
}));

// Скриншот упавшего автотеста: :rid — id результата из ответа POST /autoruns/:num/results
projectRouter.post("/autoruns/:num/results/:rid/attachments", wrap(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT ar.id FROM auto_results ar JOIN auto_runs r ON r.id=ar.run_id WHERE r.project_key=$1 AND r.num=$2 AND ar.id=$3",
    [req.params.key, num(req.params.num), num(req.params.rid)]
  );
  if (!rows[0]) return res.status(404).json({ error: "Результат не входит в этот запуск" });
  await save(req, res, { autoResultId: rows[0].id });
}));

const fileRouter = express.Router();

// Файл вместе с ключом проекта, которому он принадлежит. Файл из недоступного проекта — как несуществующий
async function findFile(req, write = false) {
  if (!UUID_RE.test(req.params.id)) return null;
  const { rows } = await pool.query(
    `SELECT a.filename, a.mime, a.size, COALESCE(b.project_key, t.project_key, r.project_key) AS project_key,
       a.bug_id, a.run_result_id, a.auto_result_id
     FROM attachments a
     LEFT JOIN bugs b ON b.id=a.bug_id
     LEFT JOIN run_results rr ON rr.id=a.run_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
     LEFT JOIN auto_results ar ON ar.id=a.auto_result_id LEFT JOIN auto_runs r ON r.id=ar.run_id
     WHERE a.id=$1`,
    [req.params.id]
  );
  const a = rows[0];
  if (!a) return null;
  const [role] = await Promise.all([access.projectRole(req.user, a.project_key), require("./roles").load()]);
  if (!role) return null;
  if (!write) return a;
  // удалить вложение может тот, кто может менять то, к чему оно приложено
  const perm = a.bug_id ? ["bugs.edit", "bugs.create"] : a.run_result_id ? ["runs.execute"] : ["autotests.manage"];
  return perm.some((p) => access.can(role, p)) ? a : null;
}

fileRouter.get("/:id", wrap(async (req, res) => {
  const a = await findFile(req);
  if (!a) return res.status(404).json({ error: "Файл не найден" });
  const inline = INLINE.has(a.mime);
  const ascii = a.filename.replace(/[^\x20-\x7e]/g, "_");
  res.set({
    "Content-Type": inline ? (a.mime === "text/plain" ? "text/plain; charset=utf-8" : a.mime) : "application/octet-stream",
    "Content-Length": String(a.size),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    // даже если в файле окажется что-то исполняемое, браузер не даст ему ничего сделать
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  const stream = storage.get(req.params.id);
  stream.on("error", (e) => {
    console.error("[attachments] не удалось прочитать файл", req.params.id, e.message);
    if (!res.headersSent) res.status(404).json({ error: "Файл не найден на диске" });
    else res.destroy();
  });
  stream.pipe(res);
}));

fileRouter.delete("/:id", wrap(async (req, res) => {
  if (!(await findFile(req, true))) return res.status(404).json({ error: "Файл не найден или нет прав на удаление" });
  const r = await pool.query("DELETE FROM attachments WHERE id=$1", [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Файл не найден" });
  await storage.remove(req.params.id);
  broadcast("attachments");
  res.json({ ok: true });
}));

// Удаляет с диска файлы, у которых больше нет записи в базе: записи пропадают каскадно,
// когда удаляют баг, прогон, кейс, запуск автотестов или проект. Свежие файлы не трогаем — их может дописывать save().
async function sweep() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const files = await storage.list();
  const ids = files.map((f) => f.name).filter((n) => UUID_RE.test(n));
  // файлы удалённого в корзину (server/trash.js) не трогаем, пока снимок в корзине
  const { rows } = ids.length
    ? await pool.query(
        `SELECT id::text FROM attachments WHERE id = ANY($1::uuid[])
         UNION SELECT f::text FROM trash, unnest(files) f WHERE f = ANY($1::uuid[])`,
        [ids]
      )
    : { rows: [] };
  const known = new Set(rows.map((r) => r.id));
  let removed = 0;
  for (const { name: n, mtimeMs } of files) {
    if (known.has(n) || !(UUID_RE.test(n) || n.endsWith(".part"))) continue;
    if (mtimeMs < cutoff) {
      if (n.endsWith(".part")) await fs.promises.unlink(path.join(storage.tmpDir, n)).catch(() => {});
      else await storage.remove(n);
      removed++;
    }
  }
  if (removed) console.log(`[attachments] удалено файлов без записи в базе: ${removed}`);
}
// Очистка — периодическая задача очереди (одна реплика за раз)
function startSweeper() {
  const jobs = require("./jobs");
  jobs.define("attachments.sweep", () => sweep(), { maxAttempts: 1, title: "Удаление файлов без записи в базе" });
  jobs.every("attachments.sweep", 30 * 60 * 1000);
}

// Для экспорта проекта: содержимое файла целиком
async function readFile(id) {
  const chunks = [];
  for await (const c of storage.get(id)) chunks.push(c);
  return Buffer.concat(chunks);
}

// Для импорта проекта: сохранить файл из буфера и вернуть новый id
async function writeFile(buf) {
  const id = crypto.randomUUID();
  const tmp = path.join(storage.tmpDir, `${id}.part`);
  await fs.promises.writeFile(tmp, buf);
  await storage.put(id, tmp);
  return id;
}

module.exports = { projectRouter, fileRouter, startSweeper, readFile, writeFile, DIR };
