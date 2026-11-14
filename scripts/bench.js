#!/usr/bin/env node
// Замер ключевых запросов интерфейса на большом проекте (после scripts/loadgen.js).
//   node scripts/bench.js --url=http://localhost:3000 --login=admin --password=... --key=BIG --n=20
// Печатает p50 / p95 / max и размер ответа. Цель для стенда 50 тыс. кейсов / 1 млн результатов: p95 < 300 мс, кроме
// полного состояния проекта (оно грузится один раз при открытии проекта).
const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const URL_ = arg("url", "http://localhost:3000");
const KEY = arg("key", "BIG");
const N = Number(arg("n", 20));

async function main() {
  const login = await fetch(`${URL_}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: arg("login", "admin"), password: arg("password", "") }),
  });
  if (!login.ok) throw new Error(`Вход: ${login.status}`);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const st = await (await fetch(`${URL_}/api/projects/${KEY}/state`, { headers: { cookie } })).json();
  const lastRun = Math.max(...st.runs.map((r) => r.num));
  const someCase = st.cases[Math.floor(st.cases.length / 2)].num;
  const checks = [
    ["общее состояние", "/api/state"],
    ["состояние проекта", `/api/projects/${KEY}/state`],
    ["результаты прогона", `/api/projects/${KEY}/runs/${lastRun}/results`],
    ["история кейса", `/api/projects/${KEY}/cases/${someCase}/history`],
    ["список кейсов, страница", `/api/projects/${KEY}/cases?limit=100&priority=high&count=1`],
    ["поиск кейсов", `/api/projects/${KEY}/cases?q=${encodeURIComponent("оплата картой")}&limit=50`],
    ["глобальный поиск", `/api/search?q=${encodeURIComponent("восстановление")}`],
    ["список багов", `/api/projects/${KEY}/bugs?status=new&limit=100`],
    ["аналитика 30 дней", `/api/projects/${KEY}/analytics?days=30`],
  ];
  console.log(`проект ${KEY}: ${st.cases.length} кейсов, ${st.runs.length} прогонов, ${st.bugs.length} багов, ${st.autoruns.length} запусков\n`);
  for (const [label, path] of checks) {
    const times = [];
    let bytes = 0;
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      const r = await fetch(URL_ + path, { headers: { cookie } });
      const body = await r.arrayBuffer();
      times.push(performance.now() - t);
      bytes = body.byteLength;
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
    }
    times.sort((a, b) => a - b);
    const p = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(0);
    console.log(`${label.padEnd(26)} p50 ${p(0.5).padStart(5)} мс  p95 ${p(0.95).padStart(5)} мс  max ${p(1).padStart(5)} мс  ${(bytes / 1024).toFixed(0).padStart(6)} КБ`);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
