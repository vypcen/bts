// Нагрузочный сценарий k6: N виртуальных тестировщиков работают в большом проекте.
//   k6 run -e URL=http://localhost:3000 -e LOGIN=admin -e PASSWORD=... -e KEY=BIG -e VUS=50 load/k6.js
// Пороги: 95% запросов быстрее 300 мс (кроме полного состояния проекта — 2 с), ошибок меньше 1%.
import http from "k6/http";
import { check, sleep } from "k6";

const URL = __ENV.URL || "http://localhost:3000";
const KEY = __ENV.KEY || "BIG";

export const options = {
  vus: Number(__ENV.VUS || 50),
  duration: __ENV.DURATION || "2m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:light}": ["p(95)<300"],
    "http_req_duration{kind:state}": ["p(95)<2000"],
  },
};

export function setup() {
  const r = http.post(`${URL}/api/auth/login`, JSON.stringify({ login: __ENV.LOGIN, password: __ENV.PASSWORD }), { headers: { "Content-Type": "application/json" } });
  const cookie = r.headers["Set-Cookie"].split(";")[0];
  const st = http.get(`${URL}/api/projects/${KEY}/state`, { headers: { Cookie: cookie } }).json();
  const run = st.runs.find((x) => x.state === "open") || st.runs[st.runs.length - 1];
  return { cookie, run: run.num, cases: st.cases.slice(0, 2000).map((c) => c.num) };
}

export default function (ctx) {
  const h = { headers: { Cookie: ctx.cookie, "Content-Type": "application/json" } };
  const light = { ...h, tags: { kind: "light" } };
  // открыть прогон и отметить случайный кейс
  check(http.get(`${URL}/api/projects/${KEY}/runs/${ctx.run}/results`, light), { "прогон": (r) => r.status === 200 });
  const c = ctx.cases[Math.floor(Math.random() * ctx.cases.length)];
  check(http.patch(`${URL}/api/projects/${KEY}/runs/${ctx.run}/results/${c}`, JSON.stringify({ result: Math.random() < 0.9 ? "passed" : "failed" }), light), { "отметка": (r) => r.status === 200 || r.status === 409 });
  check(http.get(`${URL}/api/projects/${KEY}/cases?q=${encodeURIComponent("оплата")}&limit=50`, light), { "поиск": (r) => r.status === 200 });
  check(http.get(`${URL}/api/projects/${KEY}/cases/${c}/history`, light), { "история": (r) => r.status === 200 });
  // изредка — полное состояние проекта (так делает браузер после чужих изменений)
  if (Math.random() < 0.1) check(http.get(`${URL}/api/projects/${KEY}/state`, { ...h, tags: { kind: "state" } }), { "состояние": (r) => r.status === 200 });
  sleep(1);
}
