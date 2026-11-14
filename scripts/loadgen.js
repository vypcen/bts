#!/usr/bin/env node
// Генератор нагрузочных данных: большой проект прямо в базе (SQL, без API — миллионы строк за минуты).
//   DATABASE_URL=... node scripts/loadgen.js --key=BIG --cases=50000 --runs=20 --bugs=10000 --autoruns=500 --tests=2000
// Создаёт проект с папками, кейсами (с шагами), прогонами по всем кейсам с результатами, багами и запусками автотестов.
// Пользователь-владелец — первый админ базы. Только для стендов: в рабочую базу не запускать.
const { Pool } = require("pg");

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : def;
};
const KEY = String(arg("key", "BIG")).toUpperCase();
const CASES = Number(arg("cases", 50000));
const RUNS = Number(arg("runs", 20));
const BUGS = Number(arg("bugs", 10000));
const AUTORUNS = Number(arg("autoruns", 500));
const TESTS = Number(arg("tests", 2000));
const FOLDERS = Number(arg("folders", 200));

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Задайте DATABASE_URL");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const t0 = Date.now();
  const step = async (label, sql, params = []) => {
    const t = Date.now();
    const r = await db.query(sql, params);
    console.log(`${label}: ${r.rowCount ?? ""} за ${((Date.now() - t) / 1000).toFixed(1)} с`);
  };
  const { rows: admins } = await db.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (!admins[0]) throw new Error("В базе нет администратора: сначала зарегистрируйте первого пользователя");
  const uid = admins[0].id;

  await step("проект", "INSERT INTO projects(key, name, description, created_by) VALUES ($1, $2, 'Нагрузочный стенд', $3)", [KEY, `Нагрузка ${KEY}`, uid]);
  await db.query("INSERT INTO project_members(project_key, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [KEY, uid]);
  await step("папки", `INSERT INTO case_folders(project_key, name, parent_id)
    SELECT $1, 'Раздел ' || g, NULL FROM generate_series(1, $2) g`, [KEY, FOLDERS]);
  await step("кейсы", `INSERT INTO test_cases(project_key, num, kind, folder_id, title, priority, status, preconditions, steps, expected, created_by, updated_by)
    SELECT $1, g, CASE WHEN g % 10 = 0 THEN 'checklist' ELSE 'case' END,
      (SELECT id FROM case_folders WHERE project_key=$1 ORDER BY id OFFSET (g % $3) LIMIT 1),
      (ARRAY['Оплата картой','Вход по паролю','Восстановление доступа','Корзина','Профиль пользователя','Поиск товара','Доставка','Уведомления'])[1 + g % 8] || ' — сценарий ' || g,
      (ARRAY['critical','high','medium','low'])[1 + g % 4], CASE WHEN g % 50 = 0 THEN 'deprecated' WHEN g % 7 = 0 THEN 'draft' ELSE 'ready' END,
      'Пользователь авторизован', 'Открыть раздел' || chr(10) || 'Заполнить форму' || chr(10) || 'Нажать «Сохранить»' || chr(10) || 'Проверить уведомление',
      'Данные сохранены, показано уведомление', $2, $2
    FROM generate_series(1, $4) g`, [KEY, uid, FOLDERS, CASES]);
  await db.query("UPDATE projects SET seq=$2 WHERE key=$1", [KEY, CASES]);

  await step("прогоны", `INSERT INTO test_runs(project_key, num, title, build, environment, state, created_by, created_at, closed_at)
    SELECT $1, g, 'Регресс ' || g, '2.' || g || '.0', 'RC', CASE WHEN g = $2 THEN 'open' ELSE 'closed' END, $3,
      now() - (($2 - g) || ' days')::interval, CASE WHEN g = $2 THEN NULL ELSE now() - (($2 - g) || ' days')::interval + interval '1 day' END
    FROM generate_series(1, $2) g`, [KEY, RUNS, uid]);
  await db.query("UPDATE projects SET run_seq=$2 WHERE key=$1", [KEY, RUNS]);
  await step("результаты прогонов", `INSERT INTO run_results(run_id, case_id, result, executed_by, executed_at, case_version)
    SELECT r.id, c.id,
      CASE WHEN r.state = 'open' AND c.num % 3 = 0 THEN 'untested'
           WHEN (c.num * 7 + r.num) % 23 = 0 THEN 'failed' WHEN (c.num + r.num) % 41 = 0 THEN 'blocked' ELSE 'passed' END,
      CASE WHEN r.state = 'open' AND c.num % 3 = 0 THEN NULL ELSE $2::int END,
      CASE WHEN r.state = 'open' AND c.num % 3 = 0 THEN NULL ELSE r.created_at + (c.num % 600 || ' minutes')::interval END,
      1
    FROM test_runs r CROSS JOIN test_cases c WHERE r.project_key=$1 AND c.project_key=$1`, [KEY, uid]);

  await step("баги", `INSERT INTO bugs(project_key, num, title, status, severity, assignee_id, steps, actual, expected, case_id, created_by, updated_by)
    SELECT $1, g, 'Ошибка ' || g || ': ' || (ARRAY['не сохраняется форма','500 при оплате','неверный расчёт суммы','кнопка не реагирует'])[1 + g % 4],
      (ARRAY['new','in_progress','fixed','verified','closed','rejected'])[1 + g % 6], (ARRAY['blocker','critical','major','minor'])[1 + g % 4],
      CASE WHEN g % 2 = 0 THEN $2::int END, 'Открыть' || chr(10) || 'Нажать', 'Ошибка', 'Успех',
      (SELECT id FROM test_cases WHERE project_key=$1 AND num = 1 + (g * 13) % $3), $2, $2
    FROM generate_series(1, $4) g`, [KEY, uid, CASES, BUGS]);
  await db.query("UPDATE projects SET bug_seq=$2 WHERE key=$1", [KEY, BUGS]);

  await step("реестр автотестов", `INSERT INTO auto_tests(project_key, test_key, suite, name, file)
    SELECT $1, 'suite' || (g % 50) || ' › test ' || g, 'suite' || (g % 50), 'test ' || g, 'tests/s' || (g % 50) || '.spec.ts' FROM generate_series(1, $2) g`, [KEY, TESTS]);
  await step("запуски автотестов", `INSERT INTO auto_runs(project_key, num, title, build, state, created_by, created_at, finished_at)
    SELECT $1, g, 'CI ' || g, 'b' || g, 'finished', $2, now() - (($3 - g) || ' hours')::interval, now() - (($3 - g) || ' hours')::interval + interval '5 minutes'
    FROM generate_series(1, $3) g`, [KEY, uid, AUTORUNS]);
  await db.query("UPDATE projects SET auto_seq=$2 WHERE key=$1", [KEY, AUTORUNS]);
  await step("результаты автотестов", `INSERT INTO auto_results(run_id, test_id, status, duration_ms, message)
    SELECT r.id, t.id, CASE WHEN (t.id + r.num) % 37 = 0 THEN 'failed' WHEN (t.id * r.num) % 101 = 0 THEN 'broken' ELSE 'passed' END,
      100 + (t.id * 31 + r.num) % 5000, ''
    FROM auto_runs r CROSS JOIN auto_tests t WHERE r.project_key=$1 AND t.project_key=$1`, [KEY]);
  await step("ANALYZE", "ANALYZE");
  console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(0)} с. Проект ${KEY}.`);
  await db.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
