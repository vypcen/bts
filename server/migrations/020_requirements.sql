-- Требования и трассировка: требование ↔ тест-кейсы ↔ результаты и баги.
-- ext_ref/url — ключ и ссылка во внешней системе (Jira, Confluence, ТЗ), чтобы требования не дублировались вручную
ALTER TABLE projects ADD COLUMN req_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE requirements (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE ON UPDATE CASCADE,
  num         INTEGER NOT NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','implemented','obsolete')),
  priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  ext_ref     TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  tags        TEXT[] NOT NULL DEFAULT '{}',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_key, num)
);
CREATE INDEX requirements_ext_ref ON requirements(project_key, ext_ref) WHERE ext_ref <> '';

CREATE TABLE requirement_cases (
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  case_id        INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  PRIMARY KEY (requirement_id, case_id)
);
CREATE INDEX requirement_cases_case ON requirement_cases(case_id);
