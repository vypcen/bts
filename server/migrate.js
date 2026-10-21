// Применяет SQL-миграции из server/migrations по порядку, каждую один раз.
const fs = require("fs");
const path = require("path");
const { pool, tx } = require("./db");

const DIR = path.join(__dirname, "migrations");

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await pool.query("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(DIR, f), "utf8");
    await tx(async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    });
    console.log(`[migrate] применена ${f}`);
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
