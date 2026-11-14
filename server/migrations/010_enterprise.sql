-- Корпоративные возможности: единый вход, роли в проекте, версии кейсов, тест-планы, распределение,
-- вебхуки, трекеры задач, запуски CI, нестабильные автотесты, история статусов багов.

-- ---------- пользователи из внешних источников (LDAP/AD, Kerberos, OpenID Connect) ----------
-- Логин из AD/IdP бывает длиннее и с «@» (UPN, e-mail)
ALTER TABLE users DROP CONSTRAINT users_login_check;
ALTER TABLE users ADD CONSTRAINT users_login_check CHECK (login ~ '^[a-z0-9._@-]{2,64}$');
-- у пользователя из каталога нет локального пароля
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local', 'ldap', 'oidc', 'kerberos'));
ALTER TABLE users ADD COLUMN external_id TEXT;
ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;
CREATE UNIQUE INDEX users_external_idx ON users(auth_provider, external_id) WHERE external_id IS NOT NULL;

-- viewer — просмотровая лицензия: только чтение, без комментариев
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('tester', 'developer', 'viewer', 'admin'));

-- Роль в конкретном проекте. NULL — действует глобальная роль пользователя
ALTER TABLE project_members ADD COLUMN role TEXT CHECK (role IN ('tester', 'developer', 'viewer'));

-- Одноразовые состояния входа через OpenID Connect (state, nonce, PKCE). В базе, а не в памяти:
-- ответ IdP может прийти на другую реплику приложения
CREATE TABLE auth_states (
  state      TEXT PRIMARY KEY,
  nonce      TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  return_to  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ключ шифрования секретов интеграций, если APP_SECRET не задан. Один на все реплики
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Токен для скриптов можно ограничить одним проектом (рекомендуется для CI)
ALTER TABLE api_tokens ADD COLUMN project_key TEXT REFERENCES projects(key) ON DELETE CASCADE;

-- ---------- версии тест-кейсов ----------
ALTER TABLE test_cases ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE test_case_versions (
  case_id       INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  priority      TEXT NOT NULL,
  status        TEXT NOT NULL,
  preconditions TEXT NOT NULL,
  steps         TEXT NOT NULL,
  expected      TEXT NOT NULL,
  changed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, version)
);

-- Версия растёт при изменении содержимого (не папки и не отметок чек-листа).
-- Триггер ловит все пути изменения: API, импорт CSV, импорт проекта
CREATE FUNCTION test_case_bump_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.kind, NEW.title, NEW.priority, NEW.status, NEW.preconditions, NEW.steps, NEW.expected)
     IS DISTINCT FROM (OLD.kind, OLD.title, OLD.priority, OLD.status, OLD.preconditions, OLD.steps, OLD.expected) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION test_case_save_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.version <> OLD.version THEN
    INSERT INTO test_case_versions(case_id, version, kind, title, priority, status, preconditions, steps, expected, changed_by, changed_at)
    VALUES (NEW.id, NEW.version, NEW.kind, NEW.title, NEW.priority, NEW.status, NEW.preconditions, NEW.steps, NEW.expected,
            NEW.updated_by, NEW.updated_at)
    ON CONFLICT (case_id, version) DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER test_cases_bump BEFORE UPDATE ON test_cases FOR EACH ROW EXECUTE FUNCTION test_case_bump_version();
CREATE TRIGGER test_cases_save AFTER INSERT OR UPDATE ON test_cases FOR EACH ROW EXECUTE FUNCTION test_case_save_version();

INSERT INTO test_case_versions(case_id, version, kind, title, priority, status, preconditions, steps, expected, changed_by, changed_at)
SELECT id, 1, kind, title, priority, status, preconditions, steps, expected, updated_by, updated_at FROM test_cases;

-- ---------- тест-планы ----------
ALTER TABLE projects ADD COLUMN plan_seq INTEGER NOT NULL DEFAULT 0;

-- static — список кейсов выбран вручную; dynamic — кейсы подбираются по фильтру в момент использования.
-- locked — план зафиксирован: состав и версии кейсов заморожены, менять и удалять план нельзя
CREATE TABLE test_plans (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  num         INTEGER NOT NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description TEXT NOT NULL DEFAULT '',
  mode        TEXT NOT NULL DEFAULT 'static' CHECK (mode IN ('static', 'dynamic')),
  filter      JSONB NOT NULL DEFAULT '{}',
  locked      BOOLEAN NOT NULL DEFAULT false,
  locked_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locked_at   TIMESTAMPTZ,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_key, num)
);

-- Кейсы статического плана. У заблокированного плана здесь снимок состава (и для динамического) с версиями
CREATE TABLE plan_cases (
  plan_id      INTEGER NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  case_id      INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  case_version INTEGER,
  PRIMARY KEY (plan_id, case_id)
);
CREATE INDEX plan_cases_case_idx ON plan_cases(case_id);

ALTER TABLE test_runs ADD COLUMN plan_id INTEGER REFERENCES test_plans(id) ON DELETE SET NULL;

-- ---------- результаты в прогоне: исполнитель и проверенная версия кейса ----------
ALTER TABLE run_results ADD COLUMN assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE run_results ADD COLUMN case_version INTEGER;
CREATE INDEX run_results_assignee_idx ON run_results(assignee_id);
UPDATE run_results rr SET case_version = c.version FROM test_cases c WHERE c.id = rr.case_id;

-- Версия запоминается при добавлении кейса в прогон и обновляется, когда кейс проверяют заново:
-- в прогоне видно, какой именно текст проверялся
CREATE FUNCTION run_result_case_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.case_version IS NULL THEN
      SELECT version INTO NEW.case_version FROM test_cases WHERE id = NEW.case_id;
    END IF;
  ELSIF NEW.result IS DISTINCT FROM OLD.result AND NEW.result <> 'untested'
        AND NOT EXISTS (SELECT 1 FROM test_runs r JOIN test_plans p ON p.id = r.plan_id WHERE r.id = NEW.run_id AND p.locked) THEN
    SELECT version INTO NEW.case_version FROM test_cases WHERE id = NEW.case_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER run_results_version BEFORE INSERT OR UPDATE ON run_results FOR EACH ROW EXECUTE FUNCTION run_result_case_version();

-- ---------- история статусов багов (аналитика, вебхуки) ----------
CREATE TABLE bug_status_log (
  id         BIGSERIAL PRIMARY KEY,
  bug_id     INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status  TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bug_status_log_bug_idx ON bug_status_log(bug_id);
CREATE INDEX bug_status_log_at_idx ON bug_status_log(changed_at);
INSERT INTO bug_status_log(bug_id, from_status, to_status, changed_by, changed_at)
SELECT id, NULL, 'new', created_by, created_at FROM bugs;
INSERT INTO bug_status_log(bug_id, from_status, to_status, changed_by, changed_at)
SELECT id, 'new', status, updated_by, updated_at FROM bugs WHERE status <> 'new';

-- ---------- интеграции: трекеры задач ----------
CREATE TABLE trackers (
  id           SERIAL PRIMARY KEY,
  project_key  TEXT NOT NULL UNIQUE REFERENCES projects(key) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('jira', 'youtrack', 'gitlab', 'github', 'redmine')),
  base_url     TEXT NOT NULL,
  project_ref  TEXT NOT NULL,                 -- ключ проекта Jira, id YouTrack/GitLab/Redmine, owner/repo GitHub
  login        TEXT NOT NULL DEFAULT '',      -- для Jira (e-mail / логин при Basic-авторизации)
  secret_enc   TEXT NOT NULL DEFAULT '',      -- токен, зашифрован (server/secrets.js)
  settings     JSONB NOT NULL DEFAULT '{}',   -- {issueType, labels, closeStatuses}
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE bugs ADD COLUMN external_key TEXT;
ALTER TABLE bugs ADD COLUMN external_url TEXT;
ALTER TABLE bugs ADD COLUMN external_status TEXT;
ALTER TABLE bugs ADD COLUMN external_synced_at TIMESTAMPTZ;

-- ---------- вебхуки ----------
CREATE TABLE webhooks (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  url         TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2000),  -- шаблон
  method      TEXT NOT NULL DEFAULT 'POST' CHECK (method IN ('POST', 'PUT', 'PATCH', 'GET')),
  events      TEXT[] NOT NULL,
  headers     JSONB NOT NULL DEFAULT '{}',                          -- значения — шаблоны
  body        TEXT NOT NULL DEFAULT '',                              -- шаблон; пусто — JSON события целиком
  filter      JSONB NOT NULL DEFAULT '{}',                           -- {severity: [...], status: [...]}
  secret_enc  TEXT NOT NULL DEFAULT '',                              -- для подписи X-TestBall-Signature
  active      BOOLEAN NOT NULL DEFAULT true,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_project_idx ON webhooks(project_key);

CREATE TABLE webhook_deliveries (
  id          BIGSERIAL PRIMARY KEY,
  webhook_id  INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  attempt     INTEGER NOT NULL DEFAULT 1,
  status      INTEGER,                    -- HTTP-код ответа; NULL — не дошло
  error       TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  request     TEXT NOT NULL DEFAULT '',
  response    TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries(webhook_id, created_at DESC);

-- ---------- запуск автотестов в CI с параметрами ----------
CREATE TABLE ci_jobs (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind        TEXT NOT NULL CHECK (kind IN ('gitlab', 'github', 'jenkins', 'generic')),
  base_url    TEXT NOT NULL DEFAULT '',
  target      TEXT NOT NULL DEFAULT '',   -- GitLab: id проекта; GitHub: owner/repo/workflow.yml; Jenkins: путь задачи
  ref         TEXT NOT NULL DEFAULT 'main',
  login       TEXT NOT NULL DEFAULT '',   -- Jenkins: пользователь для API-токена
  secret_enc  TEXT NOT NULL DEFAULT '',
  params      JSONB NOT NULL DEFAULT '[]', -- [{name, label, default, options: [...]}]
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ci_jobs_project_idx ON ci_jobs(project_key);

ALTER TABLE auto_runs DROP CONSTRAINT auto_runs_state_check;
ALTER TABLE auto_runs ADD CONSTRAINT auto_runs_state_check CHECK (state IN ('queued', 'running', 'finished', 'failed'));
ALTER TABLE auto_runs ADD COLUMN params JSONB NOT NULL DEFAULT '{}';
ALTER TABLE auto_runs ADD COLUMN ci_job_id INTEGER REFERENCES ci_jobs(id) ON DELETE SET NULL;
ALTER TABLE auto_runs ADD COLUMN ci_url TEXT NOT NULL DEFAULT '';

-- ---------- нестабильные автотесты ----------
ALTER TABLE auto_results ADD COLUMN retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0);
-- прошёл не с первой попытки
ALTER TABLE auto_results ADD COLUMN flaky BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE auto_tests ADD COLUMN flaky_score REAL NOT NULL DEFAULT 0;
ALTER TABLE auto_tests ADD COLUMN flaky_since TIMESTAMPTZ;
ALTER TABLE auto_tests ADD COLUMN flaky_reason TEXT NOT NULL DEFAULT '';
-- в карантине падение теста не считается проблемой запуска
ALTER TABLE auto_tests ADD COLUMN quarantined BOOLEAN NOT NULL DEFAULT false;
-- связь автотеста с ручным кейсом: покрытие автоматизацией
ALTER TABLE auto_tests ADD COLUMN case_id INTEGER REFERENCES test_cases(id) ON DELETE SET NULL;
CREATE INDEX auto_runs_project_idx ON auto_runs(project_key, num);
