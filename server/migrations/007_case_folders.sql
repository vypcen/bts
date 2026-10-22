-- Папки тест-кейсов: дерево внутри проекта. Кейс лежит в одной папке или в корне (folder_id = NULL)
CREATE TABLE case_folders (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES case_folders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- в одной папке не бывает двух подпапок с одинаковым названием, в корне тоже
  CONSTRAINT case_folders_name_key UNIQUE NULLS NOT DISTINCT (project_key, parent_id, name)
);
CREATE INDEX case_folders_parent_idx ON case_folders(parent_id);

-- ON DELETE SET NULL — страховка: при удалении папки через API кейсы переезжают в родительскую (server/folders.js)
ALTER TABLE test_cases ADD COLUMN folder_id INTEGER REFERENCES case_folders(id) ON DELETE SET NULL;
CREATE INDEX test_cases_folder_idx ON test_cases(folder_id);
