// Формат ответа GET /api/state (server/index.js)
export type CaseStatus = "draft" | "ready" | "deprecated";
export type Priority = "critical" | "high" | "medium" | "low";
export type ResultValue = "untested" | "passed" | "failed" | "blocked" | "skipped";
export type BugStatus = "new" | "in_progress" | "fixed" | "verified" | "closed" | "rejected" | "duplicate";
export type Severity = "blocker" | "critical" | "major" | "minor";

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
  name: string;
  mime: string;
  size: number;
  uploadedBy: string | null;
  created: number;
}

export interface State {
  projects: Project[];
  cases: TestCase[];
  runs: Run[];
  results: Result[];
  bugs: Bug[];
  attachments: Attachment[];
  users: Record<string, { name: string }>;
}
