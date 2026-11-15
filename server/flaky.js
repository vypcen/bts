// Автоматическое определение нестабильных (flaky) автотестов.
// Смотрим последние FLAKY_WINDOW завершённых запусков каждого теста и ищем три признака:
//  1. тест прошёл не с первой попытки (ретрай) — прямое доказательство нестабильности;
//  2. на одной и той же сборке тест и проходил, и падал — код не менялся, а результат разный;
//  3. частые смены результата «прошёл ↔ упал» (flip rate). Сломали → починили — это два перехода и регресс, а не flaky:
//     по сменам результата тест нестабилен с трёх переходов.
// Пропущенные тесты не учитываются. Результат пишется в auto_tests (flaky_score, flaky_since, flaky_reason);
// о тесте, который только что стал нестабильным, уходит событие test.flaky.
const { pool } = require("./db");
const events = require("./events");

const WINDOW = Number(process.env.FLAKY_WINDOW || 20);
const MIN_RUNS = Number(process.env.FLAKY_MIN_RUNS || 4);
const THRESHOLD = Number(process.env.FLAKY_THRESHOLD || 0.3);

const bad = (s) => s === "failed" || s === "broken";

// history — результаты от старых к новым: [{status, flaky, build}]
function score(history) {
  const h = history.filter((r) => r.status !== "skipped");
  if (!h.length) return { score: 0, flaky: false, reason: "" };
  const retried = h.filter((r) => r.flaky).length;
  let flips = 0;
  for (let i = 1; i < h.length; i++) if (bad(h[i].status) !== bad(h[i - 1].status)) flips++;
  const byBuild = new Map();
  for (const r of h) {
    if (!r.build) continue;
    const s = byBuild.get(r.build) || new Set();
    s.add(bad(r.status));
    byBuild.set(r.build, s);
  }
  const mixedBuilds = [...byBuild.values()].filter((s) => s.size > 1).length;
  // доля смен результата учитывается, только когда истории достаточно: по двум запускам одна смена — это 100%, что ничего не значит
  const flipRate = h.length >= MIN_RUNS ? flips / (h.length - 1) : 0;
  const value = Math.min(1, flipRate + retried / h.length + (mixedBuilds ? 0.3 : 0));
  const reasons = [];
  if (retried) reasons.push(`прошёл с повторной попытки: ${retried} раз из ${h.length}`);
  if (mixedBuilds) reasons.push(`разный результат на одной сборке: ${mixedBuilds}`);
  if (flips >= 3) reasons.push(`смен результата: ${flips} за ${h.length} запусков`);
  // по флипам выносим вердикт, только когда истории достаточно; ретрай и одна сборка — достаточно и одного случая
  const flaky = retried > 0 || mixedBuilds > 0 || (h.length >= MIN_RUNS && flips >= 3 && value >= THRESHOLD);
  return { score: Math.round(value * 100) / 100, flaky, reason: flaky ? reasons.join("; ") : "" };
}

// Пересчитать тесты (по умолчанию — все тесты проекта). Возвращает список тех, кто только что стал нестабильным
async function recompute(key, testIds = null) {
  const { rows } = await pool.query(
    `SELECT t.id, t.suite, t.name, t.flaky_since,
       ARRAY(SELECT json_build_object('status', ar.status, 'flaky', ar.flaky, 'build', r.build)
             FROM auto_results ar JOIN auto_runs r ON r.id=ar.run_id
             WHERE ar.test_id=t.id AND r.state='finished' ORDER BY r.num DESC LIMIT $3) AS history
     FROM auto_tests t WHERE t.project_key=$1 AND ($2::int[] IS NULL OR t.id = ANY($2::int[]))`,
    [key, testIds, WINDOW]
  );
  const fresh = [];
  for (const t of rows) {
    const s = score(t.history.reverse());
    await pool.query(
      `UPDATE auto_tests SET flaky_score=$1, flaky_reason=$2,
         flaky_since = CASE WHEN $3 THEN COALESCE(flaky_since, now()) ELSE NULL END WHERE id=$4`,
      [s.score, s.reason, s.flaky, t.id]
    );
    if (s.flaky && !t.flaky_since) fresh.push({ id: t.id, suite: t.suite, name: t.name, score: s.score, reason: s.reason });
  }
  for (const test of fresh) events.emit(key, "test.flaky", { test }, null);
  return fresh;
}

module.exports = { score, recompute, WINDOW };
