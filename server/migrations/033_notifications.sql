-- Уведомления (I-01, I-02, I-03): в приложении и на почту, подписки на баги и кейсы, @упоминания
CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_key TEXT REFERENCES projects(key) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- assigned, mention, status, comment, review, run
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  link        TEXT NOT NULL DEFAULT '', -- маршрут интерфейса: p/LK/bugs/3
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

-- кто следит за багом или кейсом: автор, исполнитель, комментаторы — сами; любой — кнопкой «Следить»
CREATE TABLE watches (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bug_id    INTEGER REFERENCES bugs(id) ON DELETE CASCADE,
  case_id   INTEGER REFERENCES test_cases(id) ON DELETE CASCADE,
  muted     BOOLEAN NOT NULL DEFAULT false,   -- отписался: автоподписка больше не возвращает
  CHECK ((bug_id IS NULL) <> (case_id IS NULL))
);
CREATE UNIQUE INDEX watches_bug ON watches(user_id, bug_id) WHERE bug_id IS NOT NULL;
CREATE UNIQUE INDEX watches_case ON watches(user_id, case_id) WHERE case_id IS NOT NULL;

-- настройки: {"email": true, "off": ["comment"]} — какие виды не присылать
ALTER TABLE users ADD COLUMN notify_prefs JSONB NOT NULL DEFAULT '{}';
