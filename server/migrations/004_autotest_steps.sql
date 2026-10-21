-- Что именно запускали (проекты Playwright) и адрес тестируемого приложения
ALTER TABLE auto_runs ADD COLUMN scope TEXT NOT NULL DEFAULT '';
ALTER TABLE auto_runs ADD COLUMN app_url TEXT NOT NULL DEFAULT '';

-- Шаги теста (test.step): дерево [{title, status, durationMs, error, steps: [...]}]
ALTER TABLE auto_results ADD COLUMN steps JSONB NOT NULL DEFAULT '[]';
-- В реестре — шаги из последнего прохождения без падения: [{title, steps: [...]}]
ALTER TABLE auto_tests ADD COLUMN steps JSONB NOT NULL DEFAULT '[]';
