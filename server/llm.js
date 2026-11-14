// Языковая модель для подсказок в формах. В поставку модель не входит: администратор подключает
// облачный сервис или свою модель в разделе «Настройки» → «Языковая модель» (таблица llm_providers).
//   anthropic — Anthropic Claude (официальный SDK @anthropic-ai/sdk);
//   yandexgpt — YandexGPT (Yandex Cloud Foundation Models);
//   gigachat  — GigaChat (Сбер), токен доступа получается по ключу авторизации;
//   openai    — любой OpenAI-совместимый API: OpenAI, OpenRouter, DeepSeek и т. п., а также своя модель
//               на собственном сервере (vLLM, Ollama, LM Studio, llama.cpp server, LocalAI).
// Без активного подключения функции с моделью выключены, остальное приложение работает как обычно.
// Для старых установок: если подключений в базе нет, а в .env задан LLM_URL — используется он (OpenAI-совместимый).
// Ответ модели — только подсказка: сохраняет его человек, сервер сам ничего по нему не меняет.
const crypto = require("crypto");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk").default;
const { pool } = require("./db");
const secrets = require("./secrets");
const { broadcast } = require("./live");
const { wrap, str, num, HttpError } = require("./util");

const KINDS = ["openai", "anthropic", "yandexgpt", "gigachat"];
const MAX_QUEUE = Number(process.env.LLM_MAX_QUEUE || 20);
// Защита от слишком длинного запроса: длинные поля (стектрейсы, логи) обрезает вызывающий код
const MAX_PROMPT_CHARS = Number(process.env.LLM_MAX_PROMPT_CHARS || 12000);
// LLM_ALLOW_CLOUD=false — разрешены только свои модели (OpenAI-совместимый сервер внутри периметра):
// тексты багов и кейсов не уйдут во внешние сервисы
const ALLOW_CLOUD = process.env.LLM_ALLOW_CLOUD !== "false";

// Значения по умолчанию для каждого типа подключения
const DEFAULTS = {
  anthropic: { baseUrl: "", model: "claude-opus-5-5" },
  yandexgpt: { baseUrl: "https://llm.api.cloud.yandex.net", model: "yandexgpt/latest" },
  gigachat: { baseUrl: "https://gigachat.devices.sberbank.ru/api/v1", model: "GigaChat" },
  openai: { baseUrl: "", model: "" },
};
// Модели Claude, для которых включён серверный fallback при отказе (stop_reason "refusal")
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

class LlmError extends HttpError {
  constructor(status, message) {
    super(status, message);
    this.name = "LlmError";
  }
}

// ---------- активное подключение ----------
// Кэш на несколько секунд: при нескольких репликах смена подключения доходит до всех без перезапуска
let cache = { at: 0, provider: null };
const CACHE_MS = 10000;

function envProvider() {
  const url = (process.env.LLM_URL || "").trim();
  if (!url) return null;
  return {
    id: null, name: "Из .env (LLM_URL)", kind: "openai", base_url: url, model: process.env.LLM_MODEL || "",
    secret: process.env.LLM_API_KEY || "", settings: { selfHosted: true, timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 120000), concurrency: 1 },
  };
}

async function active() {
  if (Date.now() - cache.at < CACHE_MS) return cache.provider;
  const { rows } = await pool.query("SELECT * FROM llm_providers WHERE active LIMIT 1");
  const p = rows[0] ? { ...rows[0], secret: secrets.decrypt(rows[0].secret_enc) } : envProvider();
  cache = { at: Date.now(), provider: p && (ALLOW_CLOUD || isSelfHosted(p)) ? p : null };
  return cache.provider;
}
const invalidate = () => (cache = { at: 0, provider: null });
const isSelfHosted = (p) => p.kind === "openai" && p.settings?.selfHosted === true;

// ---------- очередь запросов (на подключение) ----------
const queues = new Map();
function queueFor(p) {
  const key = p.id ?? "env";
  const limit = Math.max(1, Math.min(32, Number(p.settings?.concurrency) || (isSelfHosted(p) ? 1 : 4)));
  let q = queues.get(key);
  if (!q || q.limit !== limit) {
    q = { limit, active: q?.active || 0, waiting: q?.waiting || [] };
    queues.set(key, q);
  }
  return q;
}
async function acquire(q) {
  if (q.active < q.limit) return void q.active++;
  if (q.waiting.length >= MAX_QUEUE) throw new LlmError(503, "Модель занята другими запросами. Повторите через минуту");
  await new Promise((resolve) => q.waiting.push(resolve));
}
function release(q) {
  const next = q.waiting.shift();
  if (next) next();
  else q.active--;
}

// ---------- JSON ----------
// Схема ответа для моделей без structured outputs — словами в системной инструкции
const schemaHint = (schema) => `Ответь только JSON-объектом без пояснений и без markdown, строго по схеме: ${JSON.stringify(schema)}`;
const parseJson = (text) => {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(t);
  } catch {
    // модель могла окружить объект текстом — берём первый {...}
    const m = /\{[\s\S]*\}/.exec(t);
    if (m) try { return JSON.parse(m[0]); } catch {}
    throw new LlmError(502, "Модель ответила в неверном формате. Повторите запрос");
  }
};
// Structured outputs Claude требуют additionalProperties: false у каждого объекта
function strictSchema(s) {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(strictSchema);
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictSchema(pv)])) : strictSchema(v);
  if (out.type === "object" && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}
const withSystemHint = (messages, hint) =>
  messages[0]?.role === "system"
    ? [{ ...messages[0], content: `${messages[0].content}\n\n${hint}` }, ...messages.slice(1)]
    : [{ role: "system", content: hint }, ...messages];

const timeoutOf = (p) => Math.max(5000, Number(p.settings?.timeoutMs) || 120000);
async function http(p, url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutOf(p)) });
  } catch (e) {
    if (e.name === "TimeoutError") throw new LlmError(504, "Модель не ответила вовремя. Попробуйте текст покороче");
    console.error(`[llm] ${p.kind}: ${e.cause?.code || e.message}`);
    throw new LlmError(503, `Нет связи с сервисом модели (${p.name})`);
  }
}
async function failed(p, res) {
  const body = await res.text().catch(() => "");
  console.error(`[llm] ${p.kind} ${res.status}: ${body.slice(0, 500)}`);
  if (res.status === 401 || res.status === 403) return new LlmError(502, "Сервис модели отклонил ключ доступа. Проверьте настройки подключения");
  if (res.status === 404) return new LlmError(502, `Модель «${p.model}» не найдена у провайдера`);
  if (res.status === 429) return new LlmError(503, "Превышен лимит запросов к сервису модели. Повторите позже");
  return new LlmError(502, `Сервис модели вернул ошибку ${res.status}. Подробности в логах`);
}

// ---------- адаптеры ----------
// Каждый: (provider, messages, {json, schema, temperature, maxTokens}) → {text, usage: {in, out}}
const ADAPTERS = {
  // OpenAI-совместимые API и свои модели
  async openai(p, messages, o) {
    const base = p.base_url.replace(/\/+$/, "");
    if (!base) throw new LlmError(503, "У подключения не задан адрес сервиса");
    // jsonMode: schema — structured outputs; object — json_object; prompt — только инструкция
    let mode = !o.json ? "none" : o.schema ? p.settings?.jsonMode || "schema" : "object";
    if (mode === "schema" && !o.schema) mode = "object";
    const send = (m) => http(p, `${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(p.secret ? { Authorization: `Bearer ${p.secret}` } : {}) },
      body: JSON.stringify({
        model: p.model, temperature: o.temperature, max_tokens: o.maxTokens, stream: false,
        messages: m === "prompt" && o.schema ? withSystemHint(messages, schemaHint(o.schema)) : messages,
        ...(m === "schema" && { response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: o.schema } } }),
        ...(m === "object" && { response_format: { type: "json_object" } }),
      }),
    });
    let res = await send(mode);
    // не все серверы понимают response_format — повторяем с инструкцией в тексте
    if (res.status === 400 && mode !== "none" && mode !== "prompt") {
      await res.text().catch(() => "");
      res = await send("prompt");
    }
    if (!res.ok) throw await failed(p, res);
    const data = await res.json();
    return { text: String(data.choices?.[0]?.message?.content || ""), usage: { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens } };
  },

  // Anthropic Claude: официальный SDK, structured outputs, серверный fallback при отказе
  async anthropic(p, messages, o) {
    const client = clients.anthropic(p);
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const params = {
      model: p.model,
      // часть бюджета уходит на рассуждения модели: маленький max_tokens обрезал бы ответ
      max_tokens: Math.max(o.maxTokens || 0, 16000),
      ...(system && { system }),
      messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
      output_config: {
        effort: p.settings?.effort || "low",
        ...(o.schema && { format: { type: "json_schema", schema: strictSchema(o.schema) } }),
      },
    };
    let msg;
    try {
      msg = FALLBACK_MODELS.has(p.model)
        ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : await client.messages.create(params);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new LlmError(502, "Anthropic отклонил ключ API. Проверьте настройки подключения");
      }
      if (e instanceof Anthropic.NotFoundError) throw new LlmError(502, `Модель «${p.model}» не найдена в Anthropic`);
      if (e instanceof Anthropic.RateLimitError) throw new LlmError(503, "Превышен лимит запросов к Anthropic. Повторите позже");
      if (e instanceof Anthropic.BadRequestError) {
        console.error("[llm] anthropic 400:", e.message);
        throw new LlmError(502, "Anthropic не принял запрос. Подробности в логах");
      }
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new LlmError(504, "Модель не ответила вовремя. Попробуйте текст покороче");
      if (e instanceof Anthropic.APIConnectionError) throw new LlmError(503, "Нет связи с Anthropic");
      if (e instanceof Anthropic.APIError) {
        console.error(`[llm] anthropic ${e.status}:`, e.message);
        throw new LlmError(502, `Anthropic вернул ошибку ${e.status ?? ""}. Подробности в логах`);
      }
      throw e;
    }
    if (msg.stop_reason === "refusal") throw new LlmError(422, "Модель отказалась обработать этот текст");
    if (msg.stop_reason === "max_tokens") throw new LlmError(502, "Ответ модели не поместился в лимит. Сократите текст");
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return { text, usage: { in: msg.usage?.input_tokens, out: msg.usage?.output_tokens } };
  },

  // YandexGPT: Foundation Models API, авторизация API-ключом или IAM-токеном
  async yandexgpt(p, messages, o) {
    const folder = p.settings?.folderId;
    if (!folder) throw new LlmError(503, "Для YandexGPT укажите идентификатор каталога (folderId)");
    const base = (p.base_url || DEFAULTS.yandexgpt.baseUrl).replace(/\/+$/, "");
    const auth = p.settings?.authType === "iam" ? `Bearer ${p.secret}` : `Api-Key ${p.secret}`;
    const list = o.schema ? withSystemHint(messages, schemaHint(o.schema)) : messages;
    const res = await http(p, `${base}/foundationModels/v1/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, "x-folder-id": folder },
      body: JSON.stringify({
        modelUri: p.model.startsWith("gpt://") ? p.model : `gpt://${folder}/${p.model}`,
        completionOptions: { stream: false, temperature: o.temperature, maxTokens: String(o.maxTokens) },
        messages: list.map((m) => ({ role: m.role, text: m.content })),
      }),
    });
    if (!res.ok) throw await failed(p, res);
    const data = await res.json();
    const r = data.result || {};
    return { text: String(r.alternatives?.[0]?.message?.text || ""), usage: { in: r.usage?.inputTextTokens, out: r.usage?.completionTokens } };
  },

  // GigaChat: ключ авторизации → токен доступа (живёт ~30 минут), дальше API, похожий на OpenAI
  async gigachat(p, messages, o) {
    const token = await clients.gigachatToken(p);
    const base = (p.base_url || DEFAULTS.gigachat.baseUrl).replace(/\/+$/, "");
    const res = await http(p, `${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: p.model, temperature: o.temperature, max_tokens: o.maxTokens, stream: false,
        messages: o.schema ? withSystemHint(messages, schemaHint(o.schema)) : messages,
      }),
    });
    if (res.status === 401) clients.dropGigachat(p);
    if (!res.ok) throw await failed(p, res);
    const data = await res.json();
    return { text: String(data.choices?.[0]?.message?.content || ""), usage: { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens } };
  },
};

// Клиенты и токены — по подключению; пересоздаются, когда меняются ключ или адрес
const clients = {
  _anthropic: new Map(),
  anthropic(p) {
    const sig = crypto.createHash("sha256").update(`${p.secret}|${p.base_url}|${timeoutOf(p)}`).digest("hex");
    const cur = this._anthropic.get(p.id);
    if (cur?.sig === sig) return cur.client;
    const client = new Anthropic({ apiKey: p.secret, ...(p.base_url ? { baseURL: p.base_url } : {}), timeout: timeoutOf(p), maxRetries: 2 });
    this._anthropic.set(p.id, { sig, client });
    return client;
  },
  _giga: new Map(),
  async gigachatToken(p) {
    const cur = this._giga.get(p.id);
    if (cur && cur.secret === p.secret && cur.expires - Date.now() > 60000) return cur.token;
    const url = p.settings?.authUrl || "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
    const res = await http(p, url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", RqUID: crypto.randomUUID(), Authorization: `Basic ${p.secret}` },
      body: new URLSearchParams({ scope: p.settings?.scope || "GIGACHAT_API_PERS" }),
    });
    if (!res.ok) throw await failed(p, res);
    const data = await res.json();
    this._giga.set(p.id, { secret: p.secret, token: data.access_token, expires: Number(data.expires_at) || Date.now() + 25 * 60000 });
    return data.access_token;
  },
  dropGigachat(p) {
    this._giga.delete(p.id);
  },
};

// ---------- запрос к модели ----------
// messages: [{ role: "system" | "user" | "assistant", content }]
// opts.json — ответ JSON-объектом, вернуть разобранным; opts.schema — JSON Schema ответа
async function chat(messages, { json = false, schema = null, temperature = 0.2, maxTokens = 1024 } = {}, provider = null) {
  if (schema) json = true;
  const p = provider || (await active());
  if (!p) throw new LlmError(503, "Языковая модель не подключена. Администратор подключает её в разделе «Настройки»");
  const size = messages.reduce((n, m) => n + m.content.length, 0);
  if (size > MAX_PROMPT_CHARS) throw new LlmError(413, `Слишком длинный текст для модели (больше ${MAX_PROMPT_CHARS} символов)`);

  const q = queueFor(p);
  await acquire(q);
  const started = Date.now();
  try {
    const { text, usage } = await ADAPTERS[p.kind](p, messages, { json, schema, temperature, maxTokens });
    // в лог только объём и время: тексты багов и кейсов могут быть закрытыми
    console.log(`[llm] ${p.kind}/${p.model}: ${usage.in ?? "?"}+${usage.out ?? "?"} токенов за ${Date.now() - started} мс`);
    // рассуждающие модели (qwen3, deepseek-r1) пишут ход мысли в <think> — пользователю он не нужен
    const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return json ? parseJson(clean) : clean;
  } finally {
    release(q);
  }
}

// Для интерфейса: показывать ли кнопки с моделью. Сервис не опрашивается на каждое открытие формы —
// доступность проверяет администратор кнопкой «Проверить»
async function status() {
  const p = await active();
  if (!p) return { enabled: false, ready: false, model: null };
  return { enabled: true, ready: true, model: p.model, provider: p.name, kind: p.kind, external: !isSelfHosted(p) };
}

// ---------- API ----------
// /api/llm/status — всем вошедшим
const router = express.Router();
router.get("/status", wrap(async (_req, res) => {
  res.json(await status());
}));

// /api/admin/llm — подключения, только администратор
const adminRouter = express.Router();

function readProvider(body, cur = null) {
  const kind = str(body.kind, 20) || cur?.kind;
  if (!KINDS.includes(kind)) return { error: `Тип подключения: ${KINDS.join(", ")}` };
  const s = body.settings && typeof body.settings === "object" ? body.settings : cur?.settings || {};
  const p = {
    name: str(body.name, 100),
    kind,
    base_url: str(body.baseUrl ?? cur?.base_url ?? "", 500).replace(/\/+$/, ""),
    model: str(body.model ?? cur?.model ?? "", 200) || DEFAULTS[kind].model,
    settings: {
      selfHosted: kind === "openai" && s.selfHosted === true,
      concurrency: Math.max(1, Math.min(32, Number(s.concurrency) || 0)) || undefined,
      timeoutMs: Math.max(5000, Math.min(600000, Number(s.timeoutMs) || 0)) || undefined,
      jsonMode: ["schema", "object", "prompt"].includes(s.jsonMode) ? s.jsonMode : undefined,
      effort: ["low", "medium", "high", "xhigh", "max"].includes(s.effort) ? s.effort : undefined,
      folderId: str(s.folderId, 100) || undefined,
      authType: s.authType === "iam" ? "iam" : undefined,
      scope: ["GIGACHAT_API_PERS", "GIGACHAT_API_B2B", "GIGACHAT_API_CORP"].includes(s.scope) ? s.scope : undefined,
      authUrl: /^https:\/\//.test(s.authUrl || "") ? str(s.authUrl, 300) : undefined,
    },
  };
  if (!p.name) return { error: "Укажите название подключения" };
  if (!p.model) return { error: "Укажите модель" };
  if (kind === "openai" && !/^https?:\/\//.test(p.base_url)) return { error: "Укажите адрес OpenAI-совместимого API, например http://llm.company.local:8000/v1" };
  if (p.base_url && !/^https?:\/\//.test(p.base_url)) return { error: "Адрес должен начинаться с http:// или https://" };
  if (kind === "yandexgpt" && !p.settings.folderId) return { error: "Для YandexGPT укажите идентификатор каталога Yandex Cloud" };
  if (!ALLOW_CLOUD && !(kind === "openai" && p.settings.selfHosted)) {
    return { error: "Облачные сервисы запрещены настройкой LLM_ALLOW_CLOUD=false: подключите свою модель" };
  }
  return { p };
}

const toProvider = (r) => ({
  id: r.id, name: r.name, kind: r.kind, baseUrl: r.base_url, model: r.model, settings: r.settings, active: r.active,
  hasKey: Boolean(r.secret_enc), selfHosted: isSelfHosted(r), updated: r.updated_at.getTime(),
});

adminRouter.get("/", wrap(async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM llm_providers ORDER BY id");
  const env = envProvider();
  res.json({
    providers: rows.map(toProvider),
    // подключение из .env — только для показа: действует, пока в базе нет активного
    env: env ? { baseUrl: env.base_url, model: env.model } : null,
    allowCloud: ALLOW_CLOUD,
    defaults: DEFAULTS,
  });
}));

adminRouter.post("/", wrap(async (req, res) => {
  const { p, error } = readProvider(req.body);
  if (error) return res.status(400).json({ error });
  const key = str(req.body.apiKey, 4000);
  if (!key && p.kind !== "openai") return res.status(400).json({ error: "Укажите ключ доступа" });
  const { rows } = await pool.query(
    "INSERT INTO llm_providers(name, kind, base_url, model, secret_enc, settings, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [p.name, p.kind, p.base_url, p.model, secrets.encrypt(key), p.settings, req.user.id]
  );
  invalidate();
  broadcast("llm");
  res.status(201).json({ id: rows[0].id });
}));

adminRouter.patch("/:id", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM llm_providers WHERE id=$1", [num(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: "Подключение не найдено" });
  const { p, error } = readProvider({ name: rows[0].name, ...req.body }, rows[0]);
  if (error) return res.status(400).json({ error });
  // ключ: не прислали — прежний
  const secret = req.body.apiKey === undefined ? rows[0].secret_enc : secrets.encrypt(str(req.body.apiKey, 4000));
  await pool.query(
    "UPDATE llm_providers SET name=$1, kind=$2, base_url=$3, model=$4, settings=$5, secret_enc=$6, updated_at=now() WHERE id=$7",
    [p.name, p.kind, p.base_url, p.model, p.settings, secret, rows[0].id]
  );
  invalidate();
  broadcast("llm");
  res.json({ ok: true });
}));

adminRouter.delete("/:id", wrap(async (req, res) => {
  const r = await pool.query("DELETE FROM llm_providers WHERE id=$1", [num(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Подключение не найдено" });
  invalidate();
  broadcast("llm");
  res.json({ ok: true });
}));

// Сделать активным (одно на всю установку) или выключить: {"active": true | false}
adminRouter.post("/:id/active", wrap(async (req, res) => {
  const id = num(req.params.id);
  const { rows } = await pool.query("SELECT * FROM llm_providers WHERE id=$1", [id]);
  if (!rows[0]) return res.status(404).json({ error: "Подключение не найдено" });
  if (req.body.active === true && !ALLOW_CLOUD && !isSelfHosted(rows[0])) {
    return res.status(409).json({ error: "Облачные сервисы запрещены настройкой LLM_ALLOW_CLOUD=false" });
  }
  await pool.query("UPDATE llm_providers SET active=false WHERE active");
  if (req.body.active === true) await pool.query("UPDATE llm_providers SET active=true WHERE id=$1", [id]);
  invalidate();
  broadcast("llm");
  res.json({ ok: true });
}));

// Проверить подключение настоящим коротким запросом. Ответ модели и время — сразу в ответе
adminRouter.post("/:id/test", wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM llm_providers WHERE id=$1", [num(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: "Подключение не найдено" });
  const p = { ...rows[0], secret: secrets.decrypt(rows[0].secret_enc) };
  const started = Date.now();
  const out = await chat(
    [{ role: "system", content: "Отвечай кратко." }, { role: "user", content: 'Ответь JSON-объектом {"ok": true, "model": "<твоё название>"}' }],
    { schema: { type: "object", properties: { ok: { type: "boolean" }, model: { type: "string" } }, required: ["ok", "model"] }, maxTokens: 200 },
    p
  );
  res.json({ ok: out?.ok === true, answer: out, durationMs: Date.now() - started });
}));

module.exports = { LlmError, chat, status, router, adminRouter, KINDS, DEFAULTS, strictSchema, parseJson };
