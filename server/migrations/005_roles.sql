-- Роли: tester — работает с проектами, developer — только смотрит, admin — всё, плюс пользователи и доступы
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'developer' CHECK (role IN ('tester','developer','admin'));
ALTER TABLE users ADD COLUMN blocked BOOLEAN NOT NULL DEFAULT false;

-- До ролей все могли всё: существующим пользователям сохраняем эти права, самый первый становится админом
UPDATE users SET role='tester';
UPDATE users SET role='admin' WHERE id=(SELECT id FROM users ORDER BY created_at, id LIMIT 1);

-- Участники проекта. Кого здесь нет, тот проект не видит (кроме админов)
CREATE TABLE project_members (
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_key, user_id)
);
CREATE INDEX project_members_user_idx ON project_members(user_id);

-- и доступ ко всем проектам, которые уже есть
INSERT INTO project_members(project_key, user_id) SELECT p.key, u.id FROM projects p CROSS JOIN users u;
