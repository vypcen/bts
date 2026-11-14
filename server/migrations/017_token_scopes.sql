-- Права токена: results — только отправка результатов автотестов (как раньше), read — чтение, write — изменения.
-- Действующие права = права токена ∩ права владельца в проекте
ALTER TABLE api_tokens ADD COLUMN scopes TEXT[] NOT NULL DEFAULT '{results}';
ALTER TABLE api_tokens ADD COLUMN expires_at TIMESTAMPTZ;
