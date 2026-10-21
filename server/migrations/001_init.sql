-- Пользователи приложения
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE CHECK (login ~ '^[a-z0-9._-]{3,32}$'),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сессии входа: в базе хранится только хэш токена из cookie
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- Проекты. key — короткий ключ для ID тест-кейсов (LK → LK-1, LK-2)
CREATE TABLE projects (
  key         TEXT PRIMARY KEY CHECK (key ~ '^[A-Z]{2,6}$'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  seq         INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Тест-кейсы
CREATE TABLE test_cases (
  id            SERIAL PRIMARY KEY,
  project_key   TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  num           INTEGER NOT NULL,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  priority      TEXT NOT NULL CHECK (priority IN ('critical','high','medium','low')),
  status        TEXT NOT NULL CHECK (status IN ('draft','ready','passed','failed','blocked')),
  preconditions TEXT NOT NULL DEFAULT '',
  steps         TEXT NOT NULL DEFAULT '',
  expected      TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_key, num)
);
CREATE INDEX test_cases_project_idx ON test_cases(project_key);
