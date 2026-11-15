-- Очередь фоновых задач (server/jobs.js)
CREATE TABLE jobs (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  locked_until TIMESTAMPTZ,
  worker       TEXT,
  dedupe_key   TEXT,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
-- выборка следующей задачи и зависших (сервер упал посреди выполнения)
CREATE INDEX jobs_queued ON jobs(run_at) WHERE status = 'queued';
CREATE INDEX jobs_running ON jobs(locked_until) WHERE status = 'running';
CREATE INDEX jobs_finished ON jobs(finished_at) WHERE status IN ('done','failed');
-- одна и та же задача (key) не ставится дважды, пока первая не выполнена
CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE status IN ('queued','running');

-- Расписание периодических задач: какая реплика первой сдвинула next_run_at, та и ставит задачу
CREATE TABLE job_schedule (
  kind        TEXT PRIMARY KEY,
  next_run_at TIMESTAMPTZ NOT NULL
);
