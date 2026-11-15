-- Перезапуск упавших: новый прогон помнит, из какого он создан
ALTER TABLE test_runs ADD COLUMN rerun_of INTEGER REFERENCES test_runs(id) ON DELETE SET NULL;
