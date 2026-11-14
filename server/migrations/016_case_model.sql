-- Модель тест-кейса: структурные шаги, результат по шагам в прогоне, теги, пользовательские поля.

-- ---------- структурные шаги ----------
-- step_list: [{"action": "...", "expected": "...", "data": "..."}]. Колонка steps остаётся: в ней действия шагов по
-- строкам (поиск, CSV, языковая модель, старые клиенты API). У чек-листа step_list пуст — пункты в steps, как раньше
ALTER TABLE test_cases ADD COLUMN step_list JSONB NOT NULL DEFAULT '[]';
ALTER TABLE test_case_versions ADD COLUMN step_list JSONB NOT NULL DEFAULT '[]';

UPDATE test_cases SET step_list = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('action', l, 'expected', '', 'data', '') ORDER BY n)
  FROM unnest(string_to_array(steps, E'\n')) WITH ORDINALITY AS t(l, n) WHERE btrim(l) <> ''
), '[]') WHERE kind = 'case';
UPDATE test_case_versions v SET step_list = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('action', l, 'expected', '', 'data', '') ORDER BY n)
  FROM unnest(string_to_array(v.steps, E'\n')) WITH ORDINALITY AS t(l, n) WHERE btrim(l) <> ''
), '[]') WHERE v.kind = 'case';

-- ---------- теги ----------
ALTER TABLE test_cases ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE test_case_versions ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE bugs ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX test_cases_tags_idx ON test_cases USING gin (tags);
CREATE INDEX bugs_tags_idx ON bugs USING gin (tags);

-- ---------- пользовательские поля ----------
CREATE TABLE custom_fields (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  entity      TEXT NOT NULL CHECK (entity IN ('case', 'bug', 'run')),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  type        TEXT NOT NULL CHECK (type IN ('text', 'textarea', 'number', 'date', 'select', 'multiselect', 'user', 'url', 'checkbox')),
  options     JSONB NOT NULL DEFAULT '[]',     -- варианты для select / multiselect
  required    BOOLEAN NOT NULL DEFAULT false,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_key, entity, name)
);
-- Значения: {"<id поля>": значение}. Удалённое поле просто перестаёт показываться
ALTER TABLE test_cases ADD COLUMN fields JSONB NOT NULL DEFAULT '{}';
ALTER TABLE test_case_versions ADD COLUMN fields JSONB NOT NULL DEFAULT '{}';
ALTER TABLE bugs ADD COLUMN fields JSONB NOT NULL DEFAULT '{}';
ALTER TABLE test_runs ADD COLUMN fields JSONB NOT NULL DEFAULT '{}';
CREATE INDEX test_cases_fields_idx ON test_cases USING gin (fields jsonb_path_ops);
CREATE INDEX bugs_fields_idx ON bugs USING gin (fields jsonb_path_ops);

-- ---------- результат по шагам в прогоне ----------
-- {"<номер шага с 0>": {"result": "failed", "actual": "что произошло"}}
ALTER TABLE run_results ADD COLUMN step_results JSONB NOT NULL DEFAULT '{}';
-- вложение к шагу результата (скриншот упавшего шага)
ALTER TABLE attachments ADD COLUMN step_index INTEGER;

-- ---------- версии: шаги, теги и поля тоже входят в содержимое ----------
CREATE OR REPLACE FUNCTION test_case_bump_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.kind, NEW.title, NEW.priority, NEW.status, NEW.preconditions, NEW.steps, NEW.expected, NEW.step_list, NEW.tags, NEW.fields)
     IS DISTINCT FROM (OLD.kind, OLD.title, OLD.priority, OLD.status, OLD.preconditions, OLD.steps, OLD.expected, OLD.step_list, OLD.tags, OLD.fields) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION test_case_save_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.version <> OLD.version THEN
    INSERT INTO test_case_versions(case_id, version, kind, title, priority, status, preconditions, steps, expected, step_list, tags, fields, changed_by, changed_at)
    VALUES (NEW.id, NEW.version, NEW.kind, NEW.title, NEW.priority, NEW.status, NEW.preconditions, NEW.steps, NEW.expected, NEW.step_list, NEW.tags, NEW.fields,
            NEW.updated_by, NEW.updated_at)
    ON CONFLICT (case_id, version) DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
