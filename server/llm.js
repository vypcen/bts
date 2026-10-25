// Локальная языковая модель. Сервер обращается к ней по OpenAI-совместимому API (/v1/chat/completions):
// так умеют Ollama, llama.cpp server, LM Studio и vLLM, поэтому модель можно сменить без правки кода.
// LLM_URL пустой — функции с моделью выключены, остальное приложение работает как обычно.
// Ответ модели — только подсказка: сохраняет его человек, сервер сам ничего по нему не меняет.
const express = require("express");
const { wrap, HttpError } = require("./util");

const URL_BASE = (process.env.LLM_URL || "").replace(/\/+$/, "");
const MODEL = process.env.LLM_MODEL || "qwen2.5:3b";
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);
// Небольшая модель на CPU отвечает одному запросу за раз; остальные ждут в очереди
const CONCURRENCY = Math.max(1, Number(process.env.LLM_CONCURRENCY || 1));
const MAX_QUEUE = Number(process.env.LLM_MAX_QUEUE || 10);
// Защита от переполнения контекста модели: длинные поля (стектрейсы, логи) обрезает вызывающий код
const MAX_PROMPT_CHARS = Number(process.env.LLM_MAX_PROMPT_CHARS || 12000);

class LlmError extends HttpError {
  constructor(status, message) {
    super(status, message);
    this.name = "LlmError";
  }
}

const enabled = () => Boolean(URL_BASE);

// ---------- очередь запросов ----------
let active = 0;
const waiting = [];

async function acquire() {
  if (active < CONCURRENCY) {
    active++;
    return;
  }
  if (waiting.length >= MAX_QUEUE) throw new LlmError(503, "Модель занята другими запросами. Повторите через минуту");
  await new Promise((resolve) => waiting.push(resolve));
}

function release() {
  // слот сразу переходит следующему в очереди, счётчик не меняется
  const next = waiting.shift();
  if (next) next();
  else active--;
}

// ---------- запрос к модели ----------
// messages: [{ role: "system" | "user" | "assistant", content }]
// opts.json — попросить ответ JSON-объектом и вернуть его разобранным.
// opts.schema — JSON Schema ответа: модель не сможет пропустить поле или повторить ключ (structured outputs)
async function chat(messages, { json = false, schema = null, temperature = 0.2, maxTokens = 1024 } = {}) {
  if (schema) json = true;
  if (!enabled()) throw new LlmError(503, "Локальная модель не подключена. Задайте LLM_URL в .env");
  const size = messages.reduce((n, m) => n + m.content.length, 0);
  if (size > MAX_PROMPT_CHARS) throw new LlmError(413, `Слишком длинный текст для модели (больше ${MAX_PROMPT_CHARS} символов)`);

  await acquire();
  const started = Date.now();
  try {
    let res;
    try {
      res = await fetch(`${URL_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY || "local"}` },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
          ...(json && {
            response_format: schema
              ? { type: "json_schema", json_schema: { name: "answer", strict: true, schema } }
              : { type: "json_object" },
          }),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (e.name === "TimeoutError") throw new LlmError(504, "Модель не ответила вовремя. Попробуйте текст покороче");
      throw new LlmError(503, "Нет связи с локальной моделью. Проверьте, что сервис запущен");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[llm] ${res.status}: ${body.slice(0, 500)}`);
      if (res.status === 404) throw new LlmError(503, `Модель ${MODEL} не загружена. Скачайте её (см. README)`);
      throw new LlmError(502, "Локальная модель вернула ошибку. Подробности в логах");
    }
    const data = await res.json();
    // рассуждающие модели (qwen3, deepseek-r1) пишут ход мысли в <think> — пользователю он не нужен
    const text = String(data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    // в лог только объём и время: тексты багов и кейсов могут быть закрытыми
    const u = data.usage || {};
    console.log(`[llm] ${MODEL}: ${u.prompt_tokens ?? "?"}+${u.completion_tokens ?? "?"} токенов за ${Date.now() - started} мс`);
    if (!json) return text;
    try {
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      throw new LlmError(502, "Модель ответила в неверном формате. Повторите запрос");
    }
  } finally {
    release();
  }
}

// Модель доступна и скачана. Для интерфейса: показывать ли кнопки с моделью
async function status() {
  if (!enabled()) return { enabled: false, model: null, ready: false };
  try {
    const res = await fetch(`${URL_BASE}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { enabled: true, model: MODEL, ready: false, error: `Сервис модели ответил ${res.status}` };
    const ids = ((await res.json()).data || []).map((m) => m.id);
    // Ollama добавляет к имени без тега «:latest»
    const ready = ids.includes(MODEL) || ids.includes(`${MODEL}:latest`);
    return { enabled: true, model: MODEL, ready, ...(!ready && { error: `Модель ${MODEL} не скачана` }) };
  } catch {
    return { enabled: true, model: MODEL, ready: false, error: "Нет связи с сервисом модели" };
  }
}

// Монтируется на /api/llm. Сюда же добавлять маршруты функций с моделью
const router = express.Router();

router.get("/status", wrap(async (_req, res) => {
  res.json(await status());
}));

module.exports = { LlmError, enabled, chat, status, router };
