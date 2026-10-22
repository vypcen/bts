import type { CaseFolder, Result, ResultValue, State } from "./types";

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

// Кому можно назначить баг в проекте: участникам и админам (сервер проверяет то же самое)
export const assigneesOf = (data: State, pid: string) => {
  const members = new Set(data.projects.find((p) => p.id === pid)?.members || []);
  return Object.keys(data.users).filter((u) => members.has(u) || data.users[u].role === "admin");
};

// Сколько элементов списка приходится на каждый ключ (null-ключи не считаются)
export function countBy<T>(list: T[], key: (x: T) => number | null): Map<number, number> {
  const out = new Map<number, number>();
  for (const x of list) {
    const k = key(x);
    if (k !== null) out.set(k, (out.get(k) || 0) + 1);
  }
  return out;
}

// Дерево папок проекта: папки в порядке обхода (родитель, затем его подпапки по алфавиту) с глубиной
export interface FolderNode { f: CaseFolder; depth: number }
export function folderTree(data: State, pid: string): FolderNode[] {
  const kids = new Map<number | null, CaseFolder[]>();
  for (const f of data.folders) {
    if (f.pid !== pid) continue;
    const list = kids.get(f.parent) || [];
    list.push(f);
    kids.set(f.parent, list);
  }
  const out: FolderNode[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const f of (kids.get(parent) || []).sort((a, b) => a.name.localeCompare(b.name, "ru"))) {
      out.push({ f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// Папка и все её подпапки
export function withSubfolders(data: State, id: number): Set<number> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of data.folders) if (f.parent !== null && out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

// «Оплата / Карты / 3DS»
export function folderPath(data: State, id: number | null): string {
  const parts: string[] = [];
  for (let f = data.folders.find((x) => x.id === id); f && parts.length < 50; f = data.folders.find((x) => x.id === f!.parent)) parts.unshift(f.name);
  return parts.join(" / ");
}

export const runResults = (data: State, pid: string, runNum: number) =>
  data.results.filter((r) => r.pid === pid && r.runNum === runNum);
