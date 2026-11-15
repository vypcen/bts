// Очередь фоновых задач в PostgreSQL: вебхуки, задачи в трекере, синхронизация, уборка.
// - задачи переживают перезапуск сервера: недоставленный вебхук доставится после рестарта;
// - при нескольких репликах задачу выполняет ровно одна (FOR UPDATE SKIP LOCKED);
// - ошибка → повтор с нарастающей паузой, после maxAttempts — «упала», её видно администратору и можно повторить;
// - периодические задачи (every) ставятся в очередь одной репликой — кто первым сдвинул расписание.
// JOB_CONCURRENCY — сколько задач одна реплика выполняет одновременно (4), JOB_POLL_MS — как часто проверять очередь (1000).
const os = require("os");
const { pool } = require("./db");
const log = require("./log");

const CONCURRENCY = Math.max(1, Number(process.env.JOB_CONCURRENCY || 4));
const POLL_MS = Math.max(50, Number(process.env.JOB_POLL_MS || 1000));
const WORKER = `${os.hostname()}:${process.pid}`;
const DEFAULT_BACKOFF = [10e3, 60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3];

const handlers = new Map(); // kind → {fn, maxAttempts, backoff, timeoutMs, title}
const schedules = new Map(); // kind → intervalMs
let running = 0;
let timer = null;
let stopping = false;
const inflight = new Set();
const stats = { done: 0, failed: 0, retried: 0 };

// fn(payload, job) — бросает ошибку, если надо повторить; job.attempt — номер попытки (с 1)
function define(kind, fn, { maxAttempts = 5, backoff = DEFAULT_BACKOFF, timeoutMs = 5 * 60e3, title = kind } = {}) {
  handlers.set(kind, { fn, maxAttempts, backoff, timeoutMs, title });
}

// Поставить задачу. key — не ставить вторую такую же, пока первая не выполнена (например, одна синхронизация на проект)
async function enqueue(kind, payload = {}, { runAt = null, delayMs = 0, key = null, db = pool } = {}) {
  const h = handlers.get(kind);
  if (!h) throw new Error(`Неизвестный тип фоновой задачи: ${kind}`);
  const { rows } = await db.query(
    `INSERT INTO jobs(kind, payload, run_at, max_attempts, dedupe_key)
     VALUES ($1, $2, COALESCE($3::timestamptz, now() + make_interval(secs => $4::float / 1000)), $5, $6)
     ON CONFLICT (dedupe_key) WHERE status IN ('queued','running') DO NOTHING RETURNING id`,
    [kind, JSON.stringify(payload), runAt, delayMs, h.maxAttempts, key]
  );
  if (rows[0] && !stopping) setImmediate(tick);
  return rows[0]?.id ?? null;
}

// Периодическая задача: раз в intervalMs одна из реплик ставит её в очередь
function every(kind, intervalMs) {
  schedules.set(kind, intervalMs);
}

async function schedule() {
  for (const [kind, ms] of schedules) {
    // кто первым сдвинул next_run_at — тот и ставит задачу; остальные реплики увидят новое время
    const { rows } = await pool.query(
      `INSERT INTO job_schedule(kind, next_run_at) VALUES ($1, now() + make_interval(secs => $2::float / 1000))
       ON CONFLICT (kind) DO UPDATE SET next_run_at = now() + make_interval(secs => $2::float / 1000)
         WHERE job_schedule.next_run_at <= now()
       RETURNING kind`,
      [kind, ms]
    );
    // при первом запуске расписание создаётся, а задача ставится сразу
    if (rows[0]) await enqueue(kind, {}, { key: `every:${kind}` });
  }
}

async function claim() {
  const kinds = [...handlers.keys()];
  const { rows } = await pool.query(
    `UPDATE jobs SET status='running', attempts=attempts+1, started_at=now(), worker=$2,
            locked_until = now() + make_interval(secs => $3::float / 1000)
     WHERE id = (
       SELECT id FROM jobs
       WHERE kind = ANY($1::text[]) AND ((status='queued' AND run_at <= now()) OR (status='running' AND locked_until < now()))
       ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [kinds, WORKER, Math.max(...[...handlers.values()].map((h) => h.timeoutMs))]
  );
  return rows[0] || null;
}

async function run(job) {
  const h = handlers.get(job.kind);
  const started = Date.now();
  try {
    await h.fn(job.payload, { id: job.id, attempt: job.attempts, maxAttempts: job.max_attempts });
    await pool.query("UPDATE jobs SET status='done', finished_at=now(), last_error=NULL, locked_until=NULL WHERE id=$1", [job.id]);
    stats.done++;
    log.debug("jobs", `${job.kind} выполнена`, { id: Number(job.id), ms: Date.now() - started });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 2000);
    if (job.attempts < job.max_attempts && !e?.permanent) {
      const wait = h.backoff[Math.min(job.attempts - 1, h.backoff.length - 1)];
      await pool.query(
        "UPDATE jobs SET status='queued', run_at=now() + make_interval(secs => $2::float / 1000), last_error=$3, locked_until=NULL WHERE id=$1",
        [job.id, wait, msg]
      );
      stats.retried++;
      log.warn("jobs", `${job.kind}: ${msg}; повтор через ${Math.round(wait / 1000)} с`, { id: Number(job.id), attempt: job.attempts });
    } else {
      await pool.query("UPDATE jobs SET status='failed', finished_at=now(), last_error=$2, locked_until=NULL WHERE id=$1", [job.id, msg]);
      stats.failed++;
      log.error("jobs", `${job.kind} не выполнена после ${job.attempts} попыток: ${msg}`, { id: Number(job.id) });
    }
  }
}

async function tick() {
  if (stopping) return;
  try {
    await schedule();
    while (running < CONCURRENCY && !stopping) {
      const job = await claim();
      if (!job) break;
      running++;
      const p = run(job).catch((e) => log.error("jobs", e.message)).finally(() => {
        running--;
        inflight.delete(p);
        if (!stopping) setImmediate(tick);
      });
      inflight.add(p);
    }
  } catch (e) {
    log.error("jobs", `очередь недоступна: ${e.message}`);
  }
}

function start() {
  if (timer) return;
  stopping = false;
  timer = setInterval(tick, POLL_MS);
  timer.unref();
  setImmediate(tick);
}

// Остановка: новые задачи не берём, ждём текущие (до timeoutMs). Невыполненные возьмёт другая реплика или этот сервер после рестарта
async function stop(timeoutMs = 10000) {
  stopping = true;
  clearInterval(timer);
  timer = null;
  await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
}

// Ошибка, при которой повтор не поможет (неверная настройка, 4xx)
const permanent = (message) => Object.assign(new Error(message), { permanent: true });

// Уборка: выполненные — через 7 дней, упавшие — через 30
async function cleanup() {
  await pool.query("DELETE FROM jobs WHERE (status='done' AND finished_at < now() - interval '7 days') OR (status='failed' AND finished_at < now() - interval '30 days')");
}

// Для администратора: сводка и упавшие задачи
async function overview() {
  const [byStatus, failed] = await Promise.all([
    pool.query("SELECT kind, status, count(*)::int AS n, min(run_at) AS oldest FROM jobs WHERE status <> 'done' OR finished_at > now() - interval '1 day' GROUP BY kind, status"),
    pool.query("SELECT id, kind, payload, attempts, last_error, finished_at, created_at FROM jobs WHERE status='failed' ORDER BY finished_at DESC LIMIT 50"),
  ]);
  const title = (k) => handlers.get(k)?.title || k;
  return {
    kinds: [...handlers.entries()].map(([kind, h]) => ({ kind, title: h.title, every: schedules.get(kind) || null })),
    counts: byStatus.rows.map((r) => ({ kind: r.kind, title: title(r.kind), status: r.status, count: r.n, oldest: r.oldest ? r.oldest.getTime() : null })),
    failed: failed.rows.map((j) => ({
      id: Number(j.id), kind: j.kind, title: title(j.kind), payload: j.payload, attempts: j.attempts, error: j.last_error,
      finished: j.finished_at ? j.finished_at.getTime() : null, created: j.created_at.getTime(),
    })),
  };
}

async function retry(id) {
  const { rowCount } = await pool.query(
    "UPDATE jobs SET status='queued', run_at=now(), attempts=0, last_error=NULL, finished_at=NULL WHERE id=$1 AND status='failed'", [id]
  );
  if (rowCount) setImmediate(tick);
  return rowCount === 1;
}

module.exports = { define, enqueue, every, start, stop, permanent, cleanup, overview, retry, stats, tick };
