-- Ревью и согласование тест-кейсов: статус «На ревью», заявки на ревью, режим проекта «готов только после ревью»
ALTER TABLE test_cases DROP CONSTRAINT test_cases_status_check;
ALTER TABLE test_cases ADD CONSTRAINT test_cases_status_check CHECK (status IN ('draft','review','ready','deprecated'));
ALTER TABLE projects ADD COLUMN review_required BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE case_reviews (
  id             SERIAL PRIMARY KEY,
  case_id        INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  case_version   INTEGER NOT NULL,
  requested_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL — любой с правом ревью
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','changes','cancelled')),
  request_comment TEXT NOT NULL DEFAULT '',
  comment        TEXT NOT NULL DEFAULT '',
  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ
);
CREATE INDEX case_reviews_case ON case_reviews(case_id, created_at DESC);
CREATE INDEX case_reviews_pending ON case_reviews(reviewer_id) WHERE status = 'pending';
