-- Комментарии к багам и тест-кейсам. Оставлять их могут все участники проекта, в том числе разработчики
CREATE TABLE comments (
  id         SERIAL PRIMARY KEY,
  bug_id     INTEGER REFERENCES bugs(id) ON DELETE CASCADE,
  case_id    INTEGER REFERENCES test_cases(id) ON DELETE CASCADE,
  author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at  TIMESTAMPTZ,
  CONSTRAINT comments_owner_check CHECK (num_nonnulls(bug_id, case_id) = 1)
);
CREATE INDEX comments_bug_idx ON comments(bug_id);
CREATE INDEX comments_case_idx ON comments(case_id);
