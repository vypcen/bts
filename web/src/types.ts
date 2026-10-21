// Формат ответа GET /api/state (server/index.js)
export type CaseStatus = "draft" | "ready" | "deprecated";
export type Priority = "critical" | "high" | "medium" | "low";
export type ResultValue = "untested" | "passed" | "failed" | "blocked" | "skipped";
export type BugStatus = "new" | "in_progress" | "fixed" | "verified" | "closed" | "rejected" | "duplicate";
export type Severity = "blocker" | "critical" | "major" | "minor";
export type AutoStatus = "passed" | "failed" | "broken" | "skipped";

export interface User {
  login: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  desc: string;
  createdBy: string | null;
  created: number;
}

export interface TestCase {
  id: string;
  pid: string;
  num: number;
  title: string;
  priority: Priority;
  status: CaseStatus;
  pre: string;
  steps: string;
  expected: string;
  createdBy: string | null;
  updatedBy: string | null;
  created: number;
  updated: number;
}

export interface Run {
  id: string;
  pid: string;
  num: number;
  title: string;
  build: string;
  env: string;
  state: "open" | "closed";
  createdBy: string | null;
  created: number;
  closed: number | null;
}

export interface Result {
  id: number;
  pid: string;
  runNum: number;
  caseNum: number;
  result: ResultValue;
  comment: string;
  executedBy: string | null;
  executed: number | null;
}

export interface Bug {
  id: string;
  pid: string;
  num: number;
  title: string;
  status: BugStatus;
  severity: Severity;
  assignee: string | null;
  env: string;
  steps: string;
  actual: string;
  expected: string;
  caseNum: number | null;
  runNum: number | null;
  resultId: number | null;
  duplicateOf: number | null;
  createdBy: string | null;
  updatedBy: string | null;
  created: number;
  updated: number;
}

export interface Attachment {
  id: string;
  pid: string;
  bugNum: number | null;
  resultId: number | null;
  autoResultId?: number | null;
  name: string;
  mime: string;
  size: number;
  uploadedBy: string | null;
  created: number;
}

// Запуск автотестов — «папка» с результатами. В состоянии только сводка, результаты грузятся отдельно
export interface AutoRun {
  id: string;
  pid: string;
  num: number;
  title: string;
  build: string;
  env: string;
  branch: string;
  state: "running" | "finished";
  createdBy: string | null;
  created: number;
  finished: number | null;
  durationMs: number;
  counts: Record<AutoStatus, number>;
}

// Ответ GET /api/projects/:key/autoruns/:num
export interface AutoResult {
  id: number;
  testId: number;
  suite: string;
  name: string;
  file: string;
  status: AutoStatus;
  durationMs: number;
  message: string;
  details: string;
  prev: { status: AutoStatus; runNum: number } | null;
}

// Ответ GET /api/projects/:key/autotests
export interface AutoTest {
  id: number;
  suite: string;
  name: string;
  file: string;
  created: number;
  history: { status: AutoStatus; runNum: number }[];
}

export interface State {
  projects: Project[];
  cases: TestCase[];
  runs: Run[];
  results: Result[];
  bugs: Bug[];
  attachments: Attachment[];
  autoruns: AutoRun[];
  users: Record<string, { name: string }>;
}
