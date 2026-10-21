-- Отдельные счётчики номеров: LK-R1 — прогоны, LK-B1 — баги
ALTER TABLE projects
  ADD COLUMN run_seq INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN bug_seq INTEGER NOT NULL DEFAULT 0;

-- Тест-прогон: набор кейсов, проверяемый на конкретной сборке
CREATE TABLE test_runs (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  num         INTEGER NOT NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  build       TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ,
  UNIQUE (project_key, num)
);

-- Результат кейса в прогоне
CREATE TABLE run_results (
  id          SERIAL PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  case_id     INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  result      TEXT NOT NULL DEFAULT 'untested' CHECK (result IN ('untested','passed','failed','blocked','skipped')),
  comment     TEXT NOT NULL DEFAULT '',
  executed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  executed_at TIMESTAMPTZ,
  UNIQUE (run_id, case_id)
);
CREATE INDEX run_results_case_idx ON run_results(case_id);

-- Баг-репорты
CREATE TABLE bugs (
  id            SERIAL PRIMARY KEY,
  project_key   TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  num           INTEGER NOT NULL,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','in_progress','fixed','verified','closed','rejected','duplicate')),
  severity      TEXT NOT NULL CHECK (severity IN ('blocker','critical','major','minor')),
  assignee_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  environment   TEXT NOT NULL DEFAULT '',
  steps         TEXT NOT NULL DEFAULT '',
  actual        TEXT NOT NULL DEFAULT '',
  expected      TEXT NOT NULL DEFAULT '',
  case_id       INTEGER REFERENCES test_cases(id) ON DELETE SET NULL,
  run_result_id INTEGER REFERENCES run_results(id) ON DELETE SET NULL,
  duplicate_of  INTEGER REFERENCES bugs(id) ON DELETE SET NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_key, num)
);
CREATE INDEX bugs_project_idx ON bugs(project_key);
CREATE INDEX bugs_case_idx ON bugs(case_id);

-- Вложения: сам файл лежит на диске под именем id, здесь только метаданные.
-- Принадлежит либо багу, либо результату в прогоне.
CREATE TABLE attachments (
  id            UUID PRIMARY KEY,
  bug_id        INTEGER REFERENCES bugs(id) ON DELETE CASCADE,
  run_result_id INTEGER REFERENCES run_results(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL CHECK (size >= 0),
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(bug_id, run_result_id) = 1)
);
CREATE INDEX attachments_bug_idx ON attachments(bug_id);
CREATE INDEX attachments_result_idx ON attachments(run_result_id);

-- Статусы «Пройден/Упал/Заблокирован» раньше хранились в самом кейсе.
-- Переносим их в закрытый прогон, чтобы результаты не потерялись.
INSERT INTO test_runs(project_key, num, title, state, created_at, closed_at)
SELECT p.key, 1, 'Результаты до появления прогонов', 'closed', now(), now()
FROM projects p
WHERE EXISTS (SELECT 1 FROM test_cases c WHERE c.project_key = p.key AND c.status IN ('passed','failed','blocked'));

UPDATE projects p SET run_seq = 1 WHERE EXISTS (SELECT 1 FROM test_runs r WHERE r.project_key = p.key);

INSERT INTO run_results(run_id, case_id, result, executed_by, executed_at)
SELECT r.id, c.id, c.status, c.updated_by, c.updated_at
FROM test_cases c JOIN test_runs r ON r.project_key = c.project_key
WHERE c.status IN ('passed','failed','blocked');

-- У кейса остаётся только статус готовности
ALTER TABLE test_cases DROP CONSTRAINT test_cases_status_check;
UPDATE test_cases SET status = 'ready' WHERE status IN ('passed','failed','blocked');
ALTER TABLE test_cases ADD CONSTRAINT test_cases_status_check CHECK (status IN ('draft','ready','deprecated'));
