-- Журнал аудита и корзина.

-- Журнал аудита: кто, когда, откуда и что сделал. Пишется сервером (server/audit.js), правке не подлежит
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_login TEXT NOT NULL DEFAULT '',          -- логин сохраняется и после удаления пользователя
  ip          TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,                     -- auth.login, user.role, project.delete, case.delete…
  project_key TEXT,                              -- без внешнего ключа: запись живёт дольше проекта
  target      TEXT NOT NULL DEFAULT '',          -- LK-12, LK-B7, логин, id вебхука…
  details     JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_login, at DESC);
CREATE INDEX audit_log_project_idx ON audit_log (project_key, at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, at DESC);

-- Корзина. Проект удаляется мягко: помечается deleted_at и исчезает для всех, данные и файлы остаются.
ALTER TABLE projects ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Кейс, прогон или баг удаляются по-настоящему, а снимок строк (с результатами, комментариями, версиями, вложениями
-- и ссылками на них) кладётся сюда — из него запись восстанавливается целиком. Файлы вложений из снимков не удаляются
-- очисткой, пока снимок в корзине.
CREATE TABLE trash (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('case', 'run', 'bug')),
  num         INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  data        JSONB NOT NULL,
  files       UUID[] NOT NULL DEFAULT '{}',
  deleted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trash_project_idx ON trash (project_key, deleted_at DESC);
