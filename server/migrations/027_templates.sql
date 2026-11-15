-- Шаблоны тест-кейсов и багов проекта: заготовка формы (предусловия, шаги, ожидаемый результат, теги, поля…)
CREATE TABLE templates (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE ON UPDATE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('case', 'bug')),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  data        JSONB NOT NULL DEFAULT '{}',
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX templates_name ON templates(project_key, kind, lower(name));
-- шаблон по умолчанию — не больше одного на вид
CREATE UNIQUE INDEX templates_default ON templates(project_key, kind) WHERE is_default;
