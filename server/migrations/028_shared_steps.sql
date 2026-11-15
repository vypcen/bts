-- Общие шаги: именованный блок шагов проекта, который вставляется в кейсы ссылкой {"shared": id}.
-- При чтении ссылка раскрывается функцией expand_steps; правка блока сразу видна во всех кейсах
ALTER TABLE projects ADD COLUMN shared_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE shared_steps (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE ON UPDATE CASCADE,
  num         INTEGER NOT NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  step_list   JSONB NOT NULL DEFAULT '[]',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_key, num)
);

-- Раскрыть ссылки на общие шаги. Шаги блока получают поля shared (id блока) и sharedTitle — по ним интерфейс
-- показывает, откуда шаг; ссылка на удалённый блок просто пропадает
CREATE FUNCTION expand_steps(list jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(x.step ORDER BY x.o1, x.o2), '[]'::jsonb) FROM (
    SELECT e.ord AS o1, s.ord AS o2,
           s.step || jsonb_build_object('shared', ss.id, 'sharedTitle', ss.title) AS step
      FROM jsonb_array_elements(COALESCE(list, '[]'::jsonb)) WITH ORDINALITY e(v, ord)
      JOIN shared_steps ss ON jsonb_typeof(e.v) = 'object' AND e.v ? 'shared' AND ss.id = (e.v->>'shared')::int
      CROSS JOIN LATERAL jsonb_array_elements(ss.step_list) WITH ORDINALITY s(step, ord)
    UNION ALL
    SELECT e.ord, 0, e.v
      FROM jsonb_array_elements(COALESCE(list, '[]'::jsonb)) WITH ORDINALITY e(v, ord)
      WHERE NOT (jsonb_typeof(e.v) = 'object' AND e.v ? 'shared')
  ) x
$$;

-- где используется блок: индекс по ссылкам не нужен, кейсов с общими шагами немного; поиск — по containment
CREATE INDEX test_cases_step_list_gin ON test_cases USING gin (step_list jsonb_path_ops);
