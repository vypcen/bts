-- Конфигурации и матрица прогонов (E-02): справочник (браузер, ОС, устройство, стенд), конфигурация прогона,
-- пачка прогонов одного плана на разные конфигурации
CREATE TABLE config_groups (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  name        TEXT NOT NULL,              -- «Браузер»
  options     JSONB NOT NULL DEFAULT '[]', -- ["Chrome", "Firefox"]
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX config_groups_name ON config_groups(project_key, lower(name));

ALTER TABLE test_runs ADD COLUMN config JSONB;           -- {"Браузер": "Chrome", "ОС": "Windows"}
ALTER TABLE test_runs ADD COLUMN config_batch UUID;      -- прогоны, созданные вместе на разные конфигурации
CREATE INDEX test_runs_batch ON test_runs(config_batch) WHERE config_batch IS NOT NULL;
