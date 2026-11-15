-- Релизы и майлстоуны (E-01): релизы со спринтами, привязка планов, прогонов и багов, готовность релиза
ALTER TABLE projects ADD COLUMN release_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE releases (
  id          SERIAL PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  num         INTEGER NOT NULL,
  parent_id   INTEGER REFERENCES releases(id) ON DELETE CASCADE,   -- спринт внутри релиза
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','released','cancelled')),
  starts_on   DATE,
  due_on      DATE,
  released_at TIMESTAMPTZ,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_key, num)
);
CREATE UNIQUE INDEX releases_name ON releases(project_key, lower(name));

ALTER TABLE test_plans ADD COLUMN release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL;
ALTER TABLE test_runs  ADD COLUMN release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL;
ALTER TABLE bugs       ADD COLUMN release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL;
CREATE INDEX test_runs_release ON test_runs(release_id) WHERE release_id IS NOT NULL;
CREATE INDEX bugs_release ON bugs(release_id) WHERE release_id IS NOT NULL;

-- прогон по плану или перезапуск наследует релиз; баг из прогона — релиз прогона
CREATE FUNCTION run_inherit_release() RETURNS trigger AS $$
BEGIN
  IF NEW.release_id IS NULL AND NEW.plan_id IS NOT NULL THEN
    SELECT release_id INTO NEW.release_id FROM test_plans WHERE id = NEW.plan_id;
  END IF;
  IF NEW.release_id IS NULL AND NEW.rerun_of IS NOT NULL THEN
    SELECT release_id INTO NEW.release_id FROM test_runs WHERE id = NEW.rerun_of;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER test_runs_release BEFORE INSERT ON test_runs FOR EACH ROW EXECUTE FUNCTION run_inherit_release();

CREATE FUNCTION bug_inherit_release() RETURNS trigger AS $$
BEGIN
  IF NEW.release_id IS NULL AND NEW.run_result_id IS NOT NULL THEN
    SELECT t.release_id INTO NEW.release_id FROM run_results rr JOIN test_runs t ON t.id = rr.run_id WHERE rr.id = NEW.run_result_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bugs_release BEFORE INSERT ON bugs FOR EACH ROW EXECUTE FUNCTION bug_inherit_release();
