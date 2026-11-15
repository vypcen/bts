// Формат ответа GET /api/state (server/index.js)
export type CaseStatus = "draft" | "ready" | "deprecated";
export type Priority = "critical" | "high" | "medium" | "low";
export type ResultValue = "untested" | "passed" | "failed" | "blocked" | "skipped";
export type BugStatus = "new" | "in_progress" | "fixed" | "verified" | "closed" | "rejected" | "duplicate";
export type Severity = "blocker" | "critical" | "major" | "minor";
export type AutoStatus = "passed" | "failed" | "broken" | "skipped";

// Шаг автотеста (test.step) с вложенными шагами
export interface AutoStep {
  title: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error: string;
  steps: AutoStep[];
}

// tester — работает с проектами, developer — смотрит и комментирует, viewer — только смотрит (просмотровая лицензия),
// admin — ещё и пользователи с доступами
export type Role = "tester" | "developer" | "viewer" | "admin";
export type ProjectRole = "tester" | "developer" | "viewer";
// Откуда учётная запись: локальная или из каталога / SSO
export type AuthProvider = "local" | "ldap" | "oidc" | "kerberos";

export interface User {
  login: string;
  name: string;
  role: Role;
  provider?: AuthProvider;
  version?: string;
  licenseNotice?: string | null;
  // что нужно сделать до начала работы: сменить пароль или включить 2FA
  pending?: "password" | "2fa" | null;
  twoFactor?: boolean;
  passwordPolicy?: string;
}

export interface Project {
  id: string;
  name: string;
  desc: string;
  createdBy: string | null;
  created: number;
  members: string[]; // логины участников; админы видят проект и без этого
  memberRoles: Record<string, ProjectRole>; // роли участников в этом проекте (если отличаются от глобальной)
  myRole: Role; // действующая роль текущего пользователя в проекте
  stats: ProjectStats; // сводка для карточки проекта (считает сервер)
}

export interface ProjectStats {
  cases: number;
  runs: number;
  bugs: number;
  openBugs: number;
  last: Record<ResultValue, number>; // последние результаты активных кейсов
}

// Папка тест-кейсов; parent: null — в корне проекта
export interface CaseFolder {
  id: number;
  pid: string;
  parent: number | null;
  name: string;
}

// checklist — чек-лист: вместо предусловий, шагов и ожидаемого результата — пункты (в steps, по одному в строке)
export type CaseKind = "case" | "checklist";

export interface TestCase {
  id: string;
  pid: string;
  num: number;
  kind: CaseKind;
  checked: Record<string, { by: string; at: string }>; // пункты чек-листа, отмеченные выполненными (без прогона)
  folder: number | null; // null — в корне проекта
  title: string;
  priority: Priority;
  status: CaseStatus;
  pre: string;
  steps: string; // действия шагов по строкам (у чек-листа — пункты)
  expected: string;
  stepList: Step[]; // структурные шаги тест-кейса; у чек-листа пусто
  tags: string[];
  fields: FieldValues; // пользовательские поля: {id поля: значение}
  createdBy: string | null;
  updatedBy: string | null;
  created: number;
  updated: number;
  version: number; // номер текущей версии содержимого
  automated: boolean; // есть связанный автотест
  // В состоянии проекта у тест-кейса нет текстов (pre, steps, expected): light — нужно взять кейс целиком (useFullCase)
  light?: boolean;
  stepCount?: number; // число шагов, когда текстов нет
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
  planNum: number | null; // прогон создан из тест-плана
  planLocked: boolean; // план заблокирован: состав зафиксирован, удалить прогон нельзя
  counts: Record<ResultValue, number>; // сколько кейсов прогона в каждом результате
  fields: FieldValues;
  rerunOf?: number | null; // номер прогона, из упавших кейсов которого создан этот
}

export interface Step {
  action: string;
  expected: string;
  data: string; // тестовые данные шага
}

export interface StepResult {
  result: ResultValue;
  actual: string; // что произошло на самом деле
}

export type FieldValue = string | number | boolean | string[];
export type FieldValues = Record<string, FieldValue>;
export type FieldType = "text" | "textarea" | "number" | "date" | "select" | "multiselect" | "user" | "url" | "checkbox";
export interface CustomField {
  id: number;
  entity: "case" | "bug" | "run";
  name: string;
  type: FieldType;
  options: string[];
  required: boolean;
  position: number;
}

export interface Result {
  id: number;
  pid: string;
  runNum: number;
  caseNum: number;
  result: ResultValue;
  comment: string;
  items: Record<string, ResultValue>; // отметки пунктов чек-листа по их тексту; у тест-кейса пусто
  executedBy: string | null;
  executed: number | null;
  assignee: string | null; // кому назначен кейс в прогоне
  caseVersion: number | null; // какая версия кейса проверялась
  steps: Record<string, StepResult>; // результаты шагов тест-кейса: {номер шага с 0: …}
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
  external: { key: string; url: string; status: string } | null; // задача во внешнем трекере
  tags: string[];
  fields: FieldValues;
}

export interface Attachment {
  id: string;
  pid: string;
  bugNum: number | null;
  resultId: number | null;
  autoResultId?: number | null;
  step?: number | null; // вложение к шагу результата
  name: string;
  mime: string;
  size: number;
  uploadedBy: string | null;
  created: number;
}

// Комментарий к багу (bugNum) или к тест-кейсу (caseNum)
export interface Comment {
  id: number;
  pid: string;
  bugNum: number | null;
  caseNum: number | null;
  author: string | null; // null — автора удалили
  text: string;
  created: number;
  edited: number | null;
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
  scope: string; // какие проекты Playwright запускались
  url: string; // адрес тестируемого приложения
  // queued — запущен из TestBall в CI и ждёт начала; failed — CI не принял запуск
  state: "queued" | "running" | "finished" | "failed";
  createdBy: string | null;
  created: number;
  finished: number | null;
  durationMs: number;
  counts: Record<AutoStatus, number>;
  flaky: number; // сколько тестов прошли не с первой попытки
  params: Record<string, string>; // параметры запуска из CI
  ciUrl: string;
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
  steps: AutoStep[];
  prev: { status: AutoStatus; runNum: number } | null;
  retries: number;
  flaky: boolean; // прошёл не с первой попытки
  quarantined: boolean;
  unstable: boolean; // тест признан нестабильным
}

// Ответ GET /api/projects/:key/autotests
export interface AutoTest {
  id: number;
  suite: string;
  name: string;
  file: string;
  steps: { title: string; steps: AutoTest["steps"] }[]; // из последнего прохождения без падения
  created: number;
  history: { status: AutoStatus; runNum: number; flaky: boolean }[];
  flaky: { score: number; reason: string; since: number } | null; // определено сервером
  flakyScore: number;
  quarantined: boolean;
  caseNum: number | null; // связанный ручной кейс
}

export interface PlanSummary {
  id: string;
  pid: string;
  num: number;
  title: string;
  mode: "static" | "dynamic";
  locked: boolean;
}

// GET /api/state — общее: проекты, пользователи, планы
export interface MetaState {
  projects: Project[];
  plans: PlanSummary[];
  users: Record<string, { name: string; role: Role }>;
}

// GET /api/projects/:key/state — данные одного проекта. results — последний результат каждого кейса
// и результаты, на которые ссылаются баги; результаты прогона целиком — GET …/runs/:num/results
export interface ProjectState {
  pid: string;
  customFields: CustomField[];
  plans: PlanSummary[];
  cases: TestCase[];
  folders: CaseFolder[];
  runs: Run[];
  results: Result[];
  bugs: Bug[];
  attachments: Attachment[];
  autoruns: AutoRun[];
  comments: Comment[];
}

export interface RunResults {
  results: Result[];
  previous: Result[]; // результат каждого кейса в ближайшем более раннем прогоне, где его проверяли
  attachments: Attachment[];
}

// Что видят экраны: общее состояние и данные открытого проекта (вне проекта списки пустые)
export interface State {
  projects: Project[];
  plans: PlanSummary[];
  cases: TestCase[];
  folders: CaseFolder[];
  runs: Run[];
  results: Result[];
  bugs: Bug[];
  attachments: Attachment[];
  autoruns: AutoRun[];
  comments: Comment[];
  users: Record<string, { name: string; role: Role }>;
  customFields: CustomField[]; // пользовательские поля открытого проекта
}

// GET /api/llm/status: показывать ли в интерфейсе функции с языковой моделью
export interface LlmStatus {
  enabled: boolean;
  model: string | null;
  ready: boolean;
  provider?: string;
  kind?: LlmKind;
  external?: boolean; // тексты уходят во внешний сервис
  error?: string;
}

export type LlmKind = "openai" | "anthropic" | "yandexgpt" | "gigachat";
// Подключение к модели (GET /api/admin/llm)
export interface LlmProvider {
  id: number;
  name: string;
  kind: LlmKind;
  baseUrl: string;
  model: string;
  settings: { selfHosted?: boolean; concurrency?: number; timeoutMs?: number; jsonMode?: string; effort?: string; folderId?: string; authType?: string; scope?: string; authUrl?: string };
  active: boolean;
  hasKey: boolean;
  selfHosted: boolean;
  updated: number;
}

// ---------- тест-планы (GET /api/projects/:key/plans) ----------
export interface PlanFilter {
  folders: number[];
  root: boolean;
  priorities: Priority[];
  statuses: CaseStatus[];
  kinds: CaseKind[];
  text: string;
  automated: "any" | "yes" | "no";
  lastResults: ResultValue[];
  tags?: string[]; // кейсы с любым из тегов
}

export interface Plan {
  num: number;
  id: string;
  title: string;
  description: string;
  mode: "static" | "dynamic";
  filter: PlanFilter;
  locked: boolean;
  lockedBy: string | null;
  lockedAt: number | null;
  createdBy: string | null;
  created: number;
  updated: number;
  caseCount: number;
  runs: number;
}

export interface PlanCase {
  num: number;
  version: number;
  currentVersion: number;
  kind: CaseKind;
  title: string;
  priority: Priority;
  status: CaseStatus;
}

// Версия тест-кейса (GET /cases/:num/versions)
export interface CaseVersion {
  version: number;
  kind: CaseKind;
  title: string;
  priority: Priority;
  status: CaseStatus;
  pre: string;
  steps: string;
  expected: string;
  stepList: Step[];
  tags: string[];
  fields: FieldValues;
  changedBy: string | null;
  changed: number;
}

// ---------- интеграции ----------
export interface Webhook {
  id: number;
  name: string;
  url: string;
  method: "POST" | "PUT" | "PATCH" | "GET";
  events: string[];
  headers: Record<string, string>;
  body: string;
  filter: Record<string, string[]>;
  active: boolean;
  hasSecret: boolean;
  created: number;
  last: { at: number; status: number | null; error: string } | null;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  attempt: number;
  status: number | null;
  error: string;
  durationMs: number;
  request: string;
  response: string;
  at: number;
}

export type TrackerKind = "jira" | "youtrack" | "gitlab" | "github" | "redmine";
export interface Tracker {
  kind: TrackerKind;
  baseUrl: string;
  projectRef: string;
  login: string;
  hasToken: boolean;
  settings: { issueType?: string; labels: string[]; autoCreate: boolean; autoCreateSeverities: Severity[]; closeToFixed: boolean; trackerId?: string };
}

export interface CiParam {
  name: string;
  label: string;
  default: string;
  options: string[];
  required: boolean;
}
export interface CiJob {
  id: number;
  name: string;
  kind: "gitlab" | "github" | "jenkins" | "generic";
  baseUrl: string;
  target: string;
  ref: string;
  login: string;
  params: CiParam[];
  hasToken: boolean;
  created: number;
}

// ---------- аналитика (GET /api/projects/:key/analytics) ----------
export interface Analytics {
  days: number;
  // предрасчёт: когда посчитано и идёт ли пересчёт в фоне
  computedAt?: number;
  refreshing?: boolean;
  cases: { total: number; ready: number; draft: number; deprecated: number; checklists: number; automated: number; changed: number };
  coverage: { executed: number; executedPct: number | null; automatedPct: number | null };
  execution: { day: string; result: ResultValue; n: number }[];
  runs: { num: number; title: string; state: string; created: number; counts: Record<Exclude<ResultValue, never>, number>; total: number; passRate: number | null }[];
  bugs: { open: { severity: Severity; status: BugStatus; n: number }[]; flow: { day: string; created: number; resolved: number }[] };
  auto: {
    runs: { num: number; title: string; branch: string; created: number; total: number; counts: Record<AutoStatus, number>; flaky: number; durationMs: number; passRate: number | null }[];
    lastPassRate: number | null;
    topFailing: { id: number; suite: string; name: string; fails: number; runs: number }[];
    flaky: { id: number; suite: string; name: string; score: number; reason: string; quarantined: boolean; since: number }[];
  };
  workload: { login: string; todo: number; done: number }[];
}
