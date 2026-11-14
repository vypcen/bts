-- Подключения к языковым моделям. Модель больше не входит в поставку: администратор подключает облачный сервис
-- (Anthropic Claude, YandexGPT, GigaChat, OpenAI-совместимые API) или свою модель на собственном сервере
-- (vLLM, Ollama, LM Studio, llama.cpp — по OpenAI-совместимому API). Активно одно подключение.
CREATE TABLE llm_providers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind        TEXT NOT NULL CHECK (kind IN ('openai', 'anthropic', 'yandexgpt', 'gigachat')),
  base_url    TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  secret_enc  TEXT NOT NULL DEFAULT '',     -- ключ API, зашифрован (server/secrets.js)
  -- {folderId, authType, scope, authUrl, effort, jsonMode, concurrency, timeoutMs, selfHosted}
  settings    JSONB NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT false,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- активным может быть только одно подключение
CREATE UNIQUE INDEX llm_providers_active_idx ON llm_providers ((true)) WHERE active;
