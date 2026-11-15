-- Предрасчитанная аналитика проекта (server/analytics.js): готовый ответ по периоду, пересчёт в фоне
CREATE TABLE analytics_cache (
  project_key  TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE ON UPDATE CASCADE,
  days         INTEGER NOT NULL,
  data         JSONB NOT NULL,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  compute_ms   INTEGER NOT NULL DEFAULT 0,
  -- когда последний раз открывали: фоновый пересчёт — только для тех, кто смотрит аналитику
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_key, days)
);
