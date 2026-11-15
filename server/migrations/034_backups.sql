-- M-04: резервные копии, созданные из интерфейса, по расписанию или CronJob в Kubernetes
CREATE TABLE backups (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,                 -- имя файла: testball-20261115-030000.tar
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  trigger      TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','schedule','cron')),
  target       TEXT NOT NULL DEFAULT 'local' CHECK (target IN ('local','s3')),
  size         BIGINT,
  manifest     JSONB,                                -- версия, миграция, число строк, контрольные суммы
  verify       JSONB,                                -- результат последней проверки восстановления
  error        TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX backups_started_idx ON backups(started_at DESC);
