-- Счётчик номеров запусков автотестов: LK-A1, LK-A2…
ALTER TABLE projects ADD COLUMN auto_seq INTEGER NOT NULL DEFAULT 0;

-- Токены для скриптов (отправка результатов автотестов). В базе только хэш, сам токен показывается один раз
CREATE TABLE api_tokens (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id);

-- Реестр автотестов проекта. Тест создаётся при первой встрече в отчёте и дальше узнаётся по test_key
CREATE TABLE auto_tests (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  test_key    TEXT NOT NULL,
  suite       TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 1000),
  file        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_key, test_key)
);

-- Запуск автотестов — отдельная «папка» с результатами
CREATE TABLE auto_runs (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  num         INTEGER NOT NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  build       TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  branch      TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','finished')),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (project_key, num)
);

-- Результат теста в запуске. broken — тест упал не на проверке, а с ошибкой (error в JUnit)
CREATE TABLE auto_results (
  id          SERIAL PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES auto_runs(id) ON DELETE CASCADE,
  test_id     INTEGER NOT NULL REFERENCES auto_tests(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('passed','failed','broken','skipped')),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  message     TEXT NOT NULL DEFAULT '',
  details     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, test_id)
);
CREATE INDEX auto_results_test_idx ON auto_results(test_id);

-- Скриншоты и логи упавших автотестов хранятся там же, где остальные вложения
ALTER TABLE attachments ADD COLUMN auto_result_id INTEGER REFERENCES auto_results(id) ON DELETE CASCADE;
ALTER TABLE attachments DROP CONSTRAINT attachments_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_owner_check CHECK (num_nonnulls(bug_id, run_result_id, auto_result_id) = 1);
CREATE INDEX attachments_auto_result_idx ON attachments(auto_result_id);
