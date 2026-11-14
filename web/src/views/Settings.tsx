import { useState, type FormEvent } from "react";
import { api } from "../api";
import { href } from "../router";
import { useLoad, useStore } from "../store";
import type { LlmKind, LlmProvider } from "../types";
import { Confirm, Empty, fmt, Modal, Pill } from "../ui";

const URL = "/api/admin/llm";

// Готовые варианты подключения: тип + адрес и модель по умолчанию. Всё можно поменять в форме
const PRESETS: { id: string; label: string; kind: LlmKind; baseUrl: string; model: string; selfHosted?: boolean; hint: string; keyLabel: string; keyOptional?: boolean }[] = [
  { id: "self", label: "Своя модель (свой сервер)", kind: "openai", baseUrl: "http://llm.company.local:8000/v1", model: "", selfHosted: true,
    hint: "Модель, развёрнутая у вас: vLLM, Ollama, LM Studio, llama.cpp server, LocalAI — любой сервер с OpenAI-совместимым API (/v1/chat/completions). Тексты не покидают вашу сеть.",
    keyLabel: "Ключ API (если сервер его требует)", keyOptional: true },
  { id: "anthropic", label: "Anthropic Claude", kind: "anthropic", baseUrl: "", model: "claude-opus-5-5",
    hint: "Облачный сервис Anthropic. Ключ — в консоли Anthropic (console.anthropic.com → API Keys).", keyLabel: "Ключ API Anthropic" },
  { id: "yandexgpt", label: "YandexGPT", kind: "yandexgpt", baseUrl: "https://llm.api.cloud.yandex.net", model: "yandexgpt/latest",
    hint: "Yandex Cloud Foundation Models. Нужны API-ключ сервисного аккаунта с ролью ai.languageModels.user и идентификатор каталога.", keyLabel: "API-ключ (или IAM-токен)" },
  { id: "gigachat", label: "GigaChat", kind: "gigachat", baseUrl: "https://gigachat.devices.sberbank.ru/api/v1", model: "GigaChat",
    hint: "Сервис Сбера. Нужен ключ авторизации из личного кабинета разработчика. Серверу приложения нужен сертификат НУЦ Минцифры (NODE_EXTRA_CA_CERTS, см. README).", keyLabel: "Ключ авторизации (Authorization key)" },
  { id: "openai", label: "Другой облачный (OpenAI-совместимый API)", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "",
    hint: "OpenAI, OpenRouter, DeepSeek, Mistral и другие сервисы с OpenAI-совместимым API: укажите их адрес и имя модели.", keyLabel: "Ключ API" },
];
const KIND_LABEL: Record<LlmKind, string> = { openai: "OpenAI-совместимый", anthropic: "Anthropic", yandexgpt: "YandexGPT", gigachat: "GigaChat" };

export function Settings() {
  const { me, write, toast, liveError } = useStore();
  const { value, error } = useLoad<{ providers: LlmProvider[]; env: { baseUrl: string; model: string } | null; allowCloud: boolean }>(URL);
  const [editing, setEditing] = useState<LlmProvider | "new" | null>(null);
  const [del, setDel] = useState<LlmProvider | null>(null);
  const [testing, setTesting] = useState<number | null>(null);

  if (me?.role !== "admin") {
    return <main className="wrap"><div className="banner">Раздел доступен только администраторам.</div><a href={href()}>← К проектам</a></main>;
  }
  const list = value?.providers || [];
  const active = list.find((p) => p.active);

  async function test(p: LlmProvider) {
    setTesting(p.id);
    try {
      const r = await api<{ ok: boolean; durationMs: number; answer: unknown }>("POST", `${URL}/${p.id}/test`, {});
      toast(r.ok ? `Модель отвечает: ${(r.durationMs / 1000).toFixed(1)} с` : `Модель ответила, но не по формату: ${JSON.stringify(r.answer).slice(0, 80)}`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setTesting(null);
    }
  }

  return (
    <main className="wrap">
      {liveError && <div className="banner">{liveError}</div>}
      <div className="head">
        <div>
          <h1>Языковая модель</h1>
          <p className="muted">
            Модель помогает составлять баг-репорты и тест-кейсы и разбирать падения автотестов. В поставку она не входит:
            подключите облачный сервис или свою модель. Активным может быть одно подключение.
          </p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEditing("new")}>+ Подключение</button>
      </div>
      {value && !value.allowCloud && <div className="banner">Облачные сервисы запрещены настройкой сервера LLM_ALLOW_CLOUD=false — доступны только свои модели.</div>}
      {value && !active && value.env && (
        <div className="linkbox small">Сейчас действует подключение из .env: <span className="mono">{value.env.baseUrl}</span> {value.env.model && <>· модель <span className="mono">{value.env.model}</span></>}. Активное подключение из списка ниже его заменит.</div>
      )}
      {active && !active.selfHosted && (
        <div className="linkbox small">
          Тексты из форм (баги, кейсы, ошибки автотестов) отправляются во внешний сервис «{active.name}». Убедитесь, что это допустимо для ваших данных.
        </div>
      )}
      {error && !value && <div className="banner">Не удалось загрузить подключения: {error}</div>}
      {!value ? <div className="skel">Загружаем…</div> : !list.length ? (
        <Empty title="Модель не подключена">Кнопки модели в формах скрыты, пока нет активного подключения.
          <button className="btn primary" onClick={() => setEditing("new")}>+ Подключение</button></Empty>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Подключение</th><th style={{ width: 200 }}>Тип</th><th style={{ width: 150 }}>Состояние</th><th style={{ width: 340 }} /></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td className="title">{p.name}
                    <div className="muted small mono" style={{ fontWeight: 400, overflowWrap: "anywhere" }}>{p.model}{p.baseUrl && ` · ${p.baseUrl}`}</div>
                  </td>
                  <td className="small">{KIND_LABEL[p.kind]}{p.selfHosted ? <span className="tag" style={{ marginLeft: 6 }}>своя</span> : <span className="tag info" style={{ marginLeft: 6 }}>облако</span>}</td>
                  <td>{p.active ? <Pill tone="ok" label="Активно" sm /> : <Pill tone="neutral" label="Выключено" sm />}</td>
                  <td className="actions">
                    <button className="btn sm" disabled={testing === p.id} onClick={() => test(p)}>{testing === p.id ? "Проверяем…" : "Проверить"}</button>
                    {p.active
                      ? <button className="btn sm" onClick={() => write(() => api("POST", `${URL}/${p.id}/active`, { active: false }), "Модель выключена")}>Выключить</button>
                      : <button className="btn sm primary" onClick={() => write(() => api("POST", `${URL}/${p.id}/active`, { active: true }), `Активно: ${p.name}`)}>Сделать активным</button>}
                    <button className="btn sm" onClick={() => setEditing(p)}>Изменить</button>
                    <button className="btn ghost sm" style={{ color: "var(--crit)" }} onClick={() => setDel(p)}>Удалить</button>
                    <div className="muted small">изменено {fmt(p.updated)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ProviderEditor provider={editing === "new" ? undefined : editing} allowCloud={value?.allowCloud ?? true} onClose={() => setEditing(null)} />}
      {del && <Confirm title={`Удалить подключение «${del.name}»?`} text={del.active ? "Оно активно: функции с моделью выключатся." : "Ключ доступа будет удалён."}
        onClose={() => setDel(null)} onYes={async () => { const p = del; setDel(null); await write(() => api("DELETE", `${URL}/${p.id}`, {}), "Подключение удалено"); }} />}
    </main>
  );
}

function ProviderEditor({ provider, allowCloud, onClose }: { provider?: LlmProvider; allowCloud: boolean; onClose: () => void }) {
  const { write } = useStore();
  const presets = PRESETS.filter((x) => allowCloud || x.selfHosted);
  const initial = provider
    ? PRESETS.find((x) => x.kind === provider.kind && Boolean(x.selfHosted) === provider.selfHosted) || PRESETS[0]
    : presets[0];
  const [preset, setPreset] = useState(initial.id);
  const def = PRESETS.find((x) => x.id === preset)!;
  const s = provider?.settings || {};
  const [f, setF] = useState({
    name: provider?.name || initial.label, baseUrl: provider?.baseUrl ?? initial.baseUrl, model: provider?.model ?? initial.model, apiKey: "",
    folderId: s.folderId || "", authType: s.authType || "api-key", scope: s.scope || "GIGACHAT_API_PERS", effort: s.effort || "low",
    jsonMode: s.jsonMode || "schema", concurrency: String(s.concurrency || ""), timeoutMs: String(s.timeoutMs ? s.timeoutMs / 1000 : ""),
  });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const pick = (id: string) => {
    const x = PRESETS.find((p) => p.id === id)!;
    setPreset(id);
    setF({ ...f, name: provider ? f.name : x.label, baseUrl: x.baseUrl, model: x.model });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name: f.name, kind: def.kind, baseUrl: f.baseUrl, model: f.model,
      settings: {
        selfHosted: Boolean(def.selfHosted), folderId: f.folderId, authType: f.authType === "iam" ? "iam" : undefined, scope: f.scope,
        effort: f.effort, jsonMode: f.jsonMode, concurrency: Number(f.concurrency) || undefined, timeoutMs: Number(f.timeoutMs) ? Number(f.timeoutMs) * 1000 : undefined,
      },
    };
    if (f.apiKey || !provider) body.apiKey = f.apiKey;
    try {
      await (provider ? api("PATCH", `${URL}/${provider.id}`, body) : api("POST", URL, body));
    } catch (x: any) {
      return setErr(x.message);
    }
    await write(async () => {}, "Подключение сохранено");
    onClose();
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>{provider ? "Подключение к модели" : "Новое подключение"}</h2>
        <div className="field"><label htmlFor="m-preset">Что подключаем</label>
          <select id="m-preset" className="input" value={preset} onChange={(e) => pick(e.target.value)}>
            {presets.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>{def.hint}</span></div>
        <div className="field"><label htmlFor="m-name">Название *</label><input id="m-name" className="input" value={f.name} onChange={set("name")} /></div>
        {def.kind !== "anthropic" && (
          <div className="field"><label htmlFor="m-url">Адрес API{def.kind === "openai" ? " *" : ""}</label>
            <input id="m-url" className="input mono" value={f.baseUrl} onChange={set("baseUrl")} placeholder={def.baseUrl} />
            {def.selfHosted && <span className="muted" style={{ fontSize: 12 }}>Ollama: http://адрес:11434/v1 · vLLM: http://адрес:8000/v1 · LM Studio: http://адрес:1234/v1</span>}</div>
        )}
        <div className="field"><label htmlFor="m-model">Модель *</label>
          <input id="m-model" className="input mono" value={f.model} onChange={set("model")} placeholder={def.selfHosted ? "qwen2.5:7b-instruct" : def.model || "имя модели у провайдера"} />
          {def.kind === "yandexgpt" && <span className="muted" style={{ fontSize: 12 }}>yandexgpt/latest, yandexgpt-lite/latest или полный URI gpt://…</span>}</div>
        <div className="field"><label htmlFor="m-key">{def.keyLabel}{provider?.hasKey && " (задан — пусто, чтобы не менять)"}</label>
          <input id="m-key" className="input mono" type="password" autoComplete="off" value={f.apiKey} onChange={set("apiKey")} /></div>
        {def.kind === "yandexgpt" && (
          <div className="row2">
            <div className="field"><label htmlFor="m-folder">Идентификатор каталога *</label><input id="m-folder" className="input mono" value={f.folderId} onChange={set("folderId")} placeholder="b1g…" /></div>
            <div className="field"><label htmlFor="m-auth">Тип ключа</label>
              <select id="m-auth" className="input" value={f.authType} onChange={set("authType")}><option value="api-key">API-ключ</option><option value="iam">IAM-токен</option></select></div>
          </div>
        )}
        {def.kind === "gigachat" && (
          <div className="field"><label htmlFor="m-scope">Версия API (scope)</label>
            <select id="m-scope" className="input" value={f.scope} onChange={set("scope")}>
              <option value="GIGACHAT_API_PERS">Физические лица (GIGACHAT_API_PERS)</option>
              <option value="GIGACHAT_API_B2B">ИП и юрлица, предоплата (GIGACHAT_API_B2B)</option>
              <option value="GIGACHAT_API_CORP">ИП и юрлица, постоплата (GIGACHAT_API_CORP)</option>
            </select></div>
        )}
        {def.kind === "anthropic" && (
          <div className="field"><label htmlFor="m-effort">Глубина рассуждений (effort)</label>
            <select id="m-effort" className="input" value={f.effort} onChange={set("effort")}>
              <option value="low">low — быстро и дёшево, хватает для черновиков</option>
              <option value="medium">medium</option>
              <option value="high">high — тщательнее, дольше и дороже</option>
            </select></div>
        )}
        <details>
          <summary className="small muted" style={{ cursor: "pointer" }}>Дополнительно</summary>
          <div className="row2" style={{ marginTop: 8 }}>
            <div className="field"><label htmlFor="m-conc">Запросов одновременно</label>
              <input id="m-conc" className="input mono" inputMode="numeric" value={f.concurrency} onChange={set("concurrency")} placeholder={def.selfHosted ? "1" : "4"} /></div>
            <div className="field"><label htmlFor="m-timeout">Ждать ответ, секунд</label>
              <input id="m-timeout" className="input mono" inputMode="numeric" value={f.timeoutMs} onChange={set("timeoutMs")} placeholder="120" /></div>
          </div>
          {def.kind === "openai" && (
            <div className="field"><label htmlFor="m-json">Формат ответа</label>
              <select id="m-json" className="input" value={f.jsonMode} onChange={set("jsonMode")}>
                <option value="schema">JSON по схеме (structured outputs) — vLLM, Ollama 0.5+, OpenAI</option>
                <option value="object">JSON-объект (json_object)</option>
                <option value="prompt">Только инструкцией в запросе — для серверов без response_format</option>
              </select>
              <span className="muted" style={{ fontSize: 12 }}>Если сервер не поймёт формат, TestBall сам повторит запрос с инструкцией в тексте.</span></div>
          )}
        </details>
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}
