-- История версий, запускавшихся на этой базе: когда обновились и с какой версии.
-- Сервер не стартует на базе, которую уже обновила более новая версия (защита от случайного отката образа)
CREATE TABLE app_versions (
  version TEXT PRIMARY KEY,
  first_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  commit TEXT
);
