-- Параметры и data-driven кейсы (D-06): наборы данных проекта, параметры кейса, итерации в прогоне
ALTER TABLE projects ADD COLUMN dataset_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE datasets (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  num         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  columns     JSONB NOT NULL DEFAULT '[]',   -- ["email", "password"]
  rows        JSONB NOT NULL DEFAULT '[]',   -- [{"name": "Админ", "values": {"email": "…", "password": "…"}}]
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_key, num)
);
CREATE UNIQUE INDEX datasets_name ON datasets(project_key, lower(name));

-- у кейса: своя таблица параметров или ссылка на набор данных проекта (что-то одно)
ALTER TABLE test_cases ADD COLUMN params JSONB;
ALTER TABLE test_cases ADD COLUMN dataset_id INTEGER REFERENCES datasets(id) ON DELETE SET NULL;

-- в результате прогона: снимок наборов на момент добавления кейса в прогон и результаты по каждому набору
ALTER TABLE run_results ADD COLUMN iterations JSONB;      -- [{"name", "values"}] или NULL — кейс без параметров
ALTER TABLE run_results ADD COLUMN iter_results JSONB NOT NULL DEFAULT '{}';  -- {"0": {"result", "steps": {...}}}

-- снимок делается сам при любом добавлении кейса в прогон (создание, план, перезапуск, добавление кейсов)
CREATE FUNCTION run_result_iterations() RETURNS trigger AS $$
BEGIN
  IF NEW.iterations IS NULL THEN
    SELECT CASE WHEN c.kind = 'case' THEN COALESCE(d.rows, c.params->'rows') END INTO NEW.iterations
    FROM test_cases c LEFT JOIN datasets d ON d.id = c.dataset_id WHERE c.id = NEW.case_id;
    IF NEW.iterations IS NOT NULL AND jsonb_array_length(NEW.iterations) = 0 THEN NEW.iterations := NULL; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER run_results_iterations BEFORE INSERT ON run_results FOR EACH ROW EXECUTE FUNCTION run_result_iterations();
