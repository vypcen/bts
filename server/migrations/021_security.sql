-- Политики паролей и сессий, двухфакторная аутентификация (server/security.js)
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
-- секрет TOTP зашифрован ключом APP_SECRET; pending — выдан, но ещё не подтверждён кодом
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending TEXT;
ALTER TABLE users ADD COLUMN totp_enabled_at TIMESTAMPTZ;
-- последний принятый шаг TOTP: один код нельзя использовать дважды
ALTER TABLE users ADD COLUMN totp_last_step BIGINT;

CREATE TABLE user_recovery_codes (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   TIMESTAMPTZ
);
CREATE INDEX user_recovery_codes_user ON user_recovery_codes(user_id);

CREATE TABLE password_history (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_history_user ON password_history(user_id, created_at DESC);

-- сессии: откуда и когда последний раз (список «Активные сессии», тайм-аут неактивности)
ALTER TABLE sessions ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
