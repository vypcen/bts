-- Последний выполненный результат кейса хранится прямо в кейсе: сводки проектов, состояние проекта, фильтр
-- «последний результат» в планах и аналитика читают одну строку, а не ищут максимум среди миллиона результатов.
-- Поддерживается триггером на run_results при любом изменении результата.
ALTER TABLE test_cases ADD COLUMN last_result_id INTEGER REFERENCES run_results(id) ON DELETE SET NULL;
ALTER TABLE test_cases ADD COLUMN last_result TEXT NOT NULL DEFAULT 'untested';

CREATE FUNCTION test_case_refresh_last(cid INTEGER) RETURNS void AS $$
  UPDATE test_cases c SET last_result_id = l.id, last_result = COALESCE(l.result, 'untested')
  FROM (SELECT NULL::int AS dummy) d
  LEFT JOIN LATERAL (
    SELECT rr.id, rr.result FROM run_results rr
    WHERE rr.case_id = cid AND rr.result <> 'untested' AND rr.executed_at IS NOT NULL
    ORDER BY rr.executed_at DESC, rr.id DESC LIMIT 1
  ) l ON true
  WHERE c.id = cid AND (c.last_result_id IS DISTINCT FROM l.id OR c.last_result IS DISTINCT FROM COALESCE(l.result, 'untested'));
$$ LANGUAGE sql;

CREATE FUNCTION run_results_last_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM test_case_refresh_last(OLD.case_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.result = 'untested' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.result IS NOT DISTINCT FROM OLD.result AND NEW.executed_at IS NOT DISTINCT FROM OLD.executed_at THEN
    RETURN NEW;
  END IF;
  PERFORM test_case_refresh_last(NEW.case_id);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER run_results_last AFTER INSERT OR UPDATE OR DELETE ON run_results
  FOR EACH ROW EXECUTE FUNCTION run_results_last_trigger();

-- заполнить для уже существующих данных одним запросом
UPDATE test_cases c SET last_result_id = l.id, last_result = l.result
FROM (
  SELECT DISTINCT ON (case_id) case_id, id, result FROM run_results
  WHERE result <> 'untested' AND executed_at IS NOT NULL
  ORDER BY case_id, executed_at DESC, id DESC
) l WHERE l.case_id = c.id;

CREATE INDEX test_cases_project_last_idx ON test_cases (project_key, last_result);
