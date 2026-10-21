import type { Result, ResultValue, State } from "./types";

// Последний выполненный результат каждого кейса проекта (по времени выполнения)
export function lastResults(data: State, pid: string): Map<number, Result> {
  const out = new Map<number, Result>();
  for (const r of data.results) {
    if (r.pid !== pid || r.result === "untested" || !r.executed) continue;
    const cur = out.get(r.caseNum);
    if (!cur || r.executed > (cur.executed || 0)) out.set(r.caseNum, r);
  }
  return out;
}

// Результат кейса в ближайшем более раннем прогоне, где его проверяли: «что было в прошлый раз»
export function previousResults(data: State, pid: string, runNum: number): Map<number, Result> {
  const out = new Map<number, Result>();
  for (const r of data.results) {
    if (r.pid !== pid || r.runNum >= runNum || r.result === "untested") continue;
    const cur = out.get(r.caseNum);
    if (!cur || r.runNum > cur.runNum) out.set(r.caseNum, r);
  }
  return out;
}

export function countResults(list: { result: ResultValue }[]) {
  const c: Record<ResultValue, number> = { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const r of list) c[r.result]++;
  return c;
}

export const runResults = (data: State, pid: string, runNum: number) =>
  data.results.filter((r) => r.pid === pid && r.runNum === runNum);
