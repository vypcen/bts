// Применяет SQL-миграции из server/migrations по порядку, каждую один раз.
const fs = require("fs");
const path = require("path");
const { pool, tx } = require("./db");
const version = require("./version");

const DIR = path.join(__dirname, "migrations");

// Номер блокировки PostgreSQL: в Kubernetes несколько реплик стартуют одновременно,
// миграции применяет та, что первой взяла блокировку, остальные ждут и видят их уже применёнными
const LOCK_ID = 7_204_311;

async function migrate() {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await lock.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await lock.query("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    await checkNotNewer(lock, done, files);
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(DIR, f), "utf8");
      await tx(async (c) => {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
      });
      console.log(`[migrate] применена ${f}`);
    }
    await lock.query(
      `INSERT INTO app_versions(version, commit) VALUES ($1,$2)
       ON CONFLICT (version) DO UPDATE SET last_started_at=now(), commit=COALESCE(EXCLUDED.commit, app_versions.commit)`,
      [version.VERSION, version.COMMIT]
    );
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    lock.release();
  }
}

// Откат на старый образ после обновления опасен: старый код не знает новых таблиц и колонок и может испортить данные.
// Поэтому сервер не стартует, если в базе есть миграции, которых нет в этой версии, или её уже запускала более новая
// версия. Вернуться назад можно только восстановлением резервной копии, снятой до обновления (docs/UPGRADE.md).
// ALLOW_DOWNGRADE=1 отключает проверку — только если вы точно знаете, что делаете
async function checkNotNewer(c, done, files) {
  if (process.env.ALLOW_DOWNGRADE === "1") return;
  const known = new Set(files);
  const unknown = [...done].filter((f) => !known.has(f)).sort();
  let newer = null;
  if (done.has("018_app_versions.sql")) {
    const { rows } = await c.query("SELECT version FROM app_versions");
    newer = rows.map((r) => r.version).filter((v) => version.compare(v, version.VERSION) > 0).sort(version.compare).pop() || null;
  }
  if (unknown.length || newer) {
    throw new Error(
      `База уже обновлена более новой версией TestBall${newer ? ` (${newer})` : ""}, а запускается ${version.VERSION}` +
        (unknown.length ? `; неизвестные этой версии миграции: ${unknown.join(", ")}` : "") +
        ". Запустите версию не ниже той, что работала с базой, или восстановите резервную копию, снятую до обновления (docs/UPGRADE.md)."
    );
  }
}

async function waitForDb(attempts = 30) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (e) {
      console.log(`[db] база ещё не готова (${i}/${attempts}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Не удалось подключиться к PostgreSQL. Проверьте DATABASE_URL и что контейнер db запущен.");
}

module.exports = { migrate, waitForDb };

if (require.main === module) {
  waitForDb()
    .then(migrate)
    .then(() => pool.end())
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
