// Импорт данных, выгруженных из прошлой (облачной) версии приложения.
// Запуск: docker compose exec app node scripts/import.js import/export.json
// Повторный запуск безопасен: существующие пользователи, проекты и кейсы пропускаются.
const fs = require("fs");
const path = require("path");
const { pool, tx } = require("../server/db");
const { waitForDb, migrate } = require("../server/migrate");

const file = process.argv[2] || path.join(__dirname, "..", "import", "export.json");

(async () => {
  if (!fs.existsSync(file)) throw new Error(`Файл ${file} не найден`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  await waitForDb();
  await migrate();
  const stats = { users: 0, projects: 0, cases: 0, results: 0 };
  await tx(async (db) => {
    const ids = {};
    for (const a of data.accounts || []) {
      const hash = a.hash && a.salt ? `pbkdf2$${a.iter || 150000}$${a.salt}$${a.hash}` : null;
      if (!hash || !/^[a-z0-9._-]{3,32}$/.test(a._id)) continue;
      const r = await db.query(
        `INSERT INTO users(login, name, password_hash, created_at) VALUES ($1,$2,$3,to_timestamp($4/1000.0))
         ON CONFLICT (login) DO NOTHING RETURNING id`,
        [a._id, a.name || a._id, hash, a.created || Date.now()]
      );
      if (r.rows[0]) stats.users++;
    }
    for (const r of (await db.query("SELECT id, login FROM users")).rows) ids[r.login] = r.id;

    for (const p of data.projects || []) {
      if (!p.name || !/^[A-Z]{2,6}$/.test(p._id)) continue;
      const r = await db.query(
        `INSERT INTO projects(key, name, description, seq, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0)) ON CONFLICT (key) DO NOTHING RETURNING key`,
        [p._id, p.name, p.desc || "", p.seq || 0, ids[p.createdBy] || null, p.created || Date.now()]
      );
      if (r.rows[0]) stats.projects++;
    }
    // В прошлой версии «Пройден/Упал/Заблокирован» хранились в кейсе. Теперь это результаты прогона:
    // кейс получает статус «Готов», а результат попадает в прогон «Импортированные результаты».
    const legacy = {};
    for (const c of data.cases || []) {
      const result = ["passed", "failed", "blocked"].includes(c.status) ? c.status : null;
      const r = await db.query(
        `INSERT INTO test_cases(project_key, num, title, priority, status, preconditions, steps, expected,
           created_by, updated_by, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11/1000.0),to_timestamp($12/1000.0)
         WHERE EXISTS (SELECT 1 FROM projects WHERE key=$1)
         ON CONFLICT (project_key, num) DO NOTHING RETURNING id`,
        [c.pid, c.num, c.title, c.priority, result ? "ready" : c.status, c.pre || "", c.steps || "", c.expected || "",
         ids[c.createdBy] || null, ids[c.updatedBy] || null, c.created || Date.now(), c.updated || c.created || Date.now()]
      );
      if (!r.rows[0]) continue;
      stats.cases++;
      if (result) (legacy[c.pid] ||= []).push({ caseId: r.rows[0].id, result, by: ids[c.updatedBy] || null, at: c.updated || c.created || Date.now() });
    }
    for (const [pid, list] of Object.entries(legacy)) {
      const seq = await db.query("UPDATE projects SET run_seq=run_seq+1 WHERE key=$1 RETURNING run_seq", [pid]);
      const run = await db.query(
        "INSERT INTO test_runs(project_key, num, title, state, closed_at) VALUES ($1,$2,'Импортированные результаты','closed',now()) RETURNING id",
        [pid, seq.rows[0].run_seq]
      );
      for (const x of list) {
        await db.query(
          "INSERT INTO run_results(run_id, case_id, result, executed_by, executed_at) VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0))",
          [run.rows[0].id, x.caseId, x.result, x.by, x.at]
        );
        stats.results++;
      }
    }
    // счётчик номеров не должен отставать от уже существующих кейсов
    await db.query(`UPDATE projects p SET seq = GREATEST(p.seq, COALESCE((SELECT max(num) FROM test_cases t WHERE t.project_key=p.key),0))`);
  });
  console.log(`[import] добавлено: пользователей ${stats.users}, проектов ${stats.projects}, тест-кейсов ${stats.cases}, результатов прогонов ${stats.results}`);
  await pool.end();
})().catch((e) => {
  console.error("[import] Ошибка:", e.message);
  process.exit(1);
});
