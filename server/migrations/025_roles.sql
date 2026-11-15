-- Пользовательские роли с набором разрешений (server/roles.js). Ключ роли хранится в users.role и project_members.role
-- рядом со встроенными (admin, tester, developer, viewer), поэтому прежние ограничения CHECK снимаются —
-- допустимость роли проверяет приложение
CREATE TABLE roles (
  key         TEXT PRIMARY KEY CHECK (key ~ '^r_[a-z0-9_]{2,40}$'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT[] NOT NULL DEFAULT '{}',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- названия уникальны без учёта регистра
CREATE UNIQUE INDEX roles_name ON roles(lower(name));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
