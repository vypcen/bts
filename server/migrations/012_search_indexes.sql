-- Серверный поиск (русская морфология) и индексы под запросы больших проектов.

-- Поиск по кейсам: название важнее шагов
ALTER TABLE test_cases ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('russian', coalesce(preconditions, '') || ' ' || coalesce(steps, '') || ' ' || coalesce(expected, '')), 'B')
) STORED;
CREATE INDEX test_cases_search_idx ON test_cases USING gin (search);

ALTER TABLE bugs ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('russian', coalesce(steps, '') || ' ' || coalesce(actual, '') || ' ' || coalesce(expected, '') || ' ' || coalesce(environment, '')), 'B')
) STORED;
CREATE INDEX bugs_search_idx ON bugs USING gin (search);

ALTER TABLE auto_tests ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(suite, '') || ' ' || coalesce(name, '') || ' ' || coalesce(file, ''))
) STORED;
CREATE INDEX auto_tests_search_idx ON auto_tests USING gin (search);

-- последний результат кейса, история кейса, «что было в прошлый раз»
CREATE INDEX run_results_case_executed_idx ON run_results (case_id, executed_at DESC) WHERE result <> 'untested';
CREATE INDEX run_results_run_idx ON run_results (run_id, result);
-- списки багов с фильтрами и ссылки багов на результаты
CREATE INDEX bugs_project_status_idx ON bugs (project_key, status, num);
CREATE INDEX bugs_result_idx ON bugs (run_result_id) WHERE run_result_id IS NOT NULL;
-- списки кейсов по папкам и статусам
CREATE INDEX test_cases_project_status_idx ON test_cases (project_key, status, num);
-- результаты автотестов по запуску (страница запуска, сводка в состоянии)
CREATE INDEX auto_results_run_idx ON auto_results (run_id, status);
