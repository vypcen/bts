import { useState, type FormEvent, type ReactNode } from "react";
import { FieldsSettings } from "./FieldsSettings";
import { api, paths } from "../api";
import { SEVERITIES } from "../labels";
import { useCanEdit, useLoad, useStore } from "../store";
import type { CiJob, CiParam, Project, Severity, Tracker, TrackerKind, Webhook, WebhookDelivery } from "../types";
import { Confirm, fmt, Modal, Pill } from "../ui";

// Настройки интеграций проекта: вебхуки, трекер задач, задачи CI, перенос проекта
export function IntegrationsTab({ project }: { project: Project }) {
  const canEdit = useCanEdit();
  if (!canEdit) return <div className="banner">Настройки интеграций доступны тестировщикам и администраторам проекта.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <FieldsSettings pid={project.id} />
      <Webhooks pid={project.id} />
      <TrackerSection pid={project.id} />
      <CiJobs pid={project.id} />
      <ExportSection pid={project.id} />
    </div>
  );
}

function Section({ title, hint, action, children }: { title: string; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="head" style={{ marginBottom: 0 }}>
        <div><h2 style={{ fontSize: 18 }}>{title}</h2><p className="muted small" style={{ margin: "4px 0 0" }}>{hint}</p></div>
        <div className="spacer" />
        {action}
      </div>
      {children}
    </section>
  );
}

// ---------- вебхуки ----------
const linesToMap = (text: string, sep: string) =>
  Object.fromEntries(text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(sep);
    return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));

function Webhooks({ pid }: { pid: string }) {
  const { write } = useStore();
  const { value } = useLoad<{ webhooks: Webhook[]; events: Record<string, string> }>(paths.webhooks(pid));
  const [editing, setEditing] = useState<Webhook | "new" | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const [del, setDel] = useState<Webhook | null>(null);
  const { toast } = useStore();
  const test = async (w: Webhook) => {
    try {
      const r = await api<{ status: number | null; error: string }>("POST", `${paths.webhook(pid, w.id)}/test`, {});
      toast(r.error ? `Ошибка: ${r.error}` : `Доставлено: HTTP ${r.status}`);
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section title="Вебхуки" hint="HTTP-запрос во внешнюю систему при событиях проекта. URL, заголовки и тело — шаблоны с подстановками вида {{bug.title}}."
      action={<button className="btn primary" onClick={() => setEditing("new")}>+ Вебхук</button>}>
      {!value ? <div className="skel">Загружаем…</div> : !value.webhooks.length ? <span className="muted small">Вебхуков нет</span> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Название</th><th>События</th><th style={{ width: 180 }}>Последняя доставка</th><th style={{ width: 280 }} /></tr></thead>
            <tbody>
              {value.webhooks.map((w) => (
                <tr key={w.id} style={w.active ? undefined : { opacity: 0.6 }}>
                  <td className="title">{w.name}<div className="muted small mono" style={{ fontWeight: 400, overflowWrap: "anywhere" }}>{w.method} {w.url}</div></td>
                  <td className="small">{w.events.map((e) => value.events[e] || e).join(", ")}</td>
                  <td className="small">{w.last ? <>{w.last.error ? <Pill tone="crit" label={w.last.error.slice(0, 40)} sm /> : <Pill tone="ok" label={`HTTP ${w.last.status}`} sm />} <span className="muted">{fmt(w.last.at)}</span></> : <span className="muted">—</span>}</td>
                  <td className="actions">
                    <button className="btn sm" onClick={() => test(w)}>Проверить</button>
                    <button className="btn sm" onClick={() => setLog(w)}>Журнал</button>
                    <button className="btn sm" onClick={() => setEditing(w)}>Изменить</button>
                    <button className="btn ghost sm" style={{ color: "var(--crit)" }} onClick={() => setDel(w)}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && value && <WebhookEditor pid={pid} hook={editing === "new" ? undefined : editing} events={value.events} onClose={() => setEditing(null)} />}
      {log && <DeliveryLog pid={pid} hook={log} onClose={() => setLog(null)} />}
      {del && <Confirm title={`Удалить вебхук «${del.name}»?`} text="Журнал доставок тоже будет удалён." onClose={() => setDel(null)}
        onYes={async () => { const w = del; setDel(null); await write(() => api("DELETE", paths.webhook(pid, w.id), {}), "Вебхук удалён"); }} />}
    </Section>
  );
}

const BODY_EXAMPLE = `{
  "text": "{{title}}: {{bug.id}} «{{bug.title | jsonstr}}» ({{bug.severity}}) {{bug.url}}",
  "author": "{{actor.name | jsonstr}}"
}`;

function WebhookEditor({ pid, hook, events, onClose }: { pid: string; hook?: Webhook; events: Record<string, string>; onClose: () => void }) {
  const { write } = useStore();
  const [f, setF] = useState({
    name: hook?.name || "", url: hook?.url || "", method: hook?.method || "POST", active: hook?.active ?? true, body: hook?.body || "",
    headers: Object.entries(hook?.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n"),
    filter: Object.entries(hook?.filter || {}).map(([k, v]) => `${k} = ${v.join(", ")}`).join("\n"),
    secret: "",
  });
  const [ev, setEv] = useState<string[]>(hook?.events || ["bug.created"]);
  const [err, setErr] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name: f.name, url: f.url, method: f.method, active: f.active, body: f.body, events: ev,
      headers: linesToMap(f.headers, ":"),
      filter: Object.fromEntries(Object.entries(linesToMap(f.filter, "=")).map(([k, v]) => [k, v.split(",").map((x) => x.trim()).filter(Boolean)])),
    };
    if (f.secret || !hook) body.secret = f.secret;
    try {
      await (hook ? api("PATCH", paths.webhook(pid, hook.id), body) : api("POST", paths.webhooks(pid), body));
    } catch (x: any) {
      return setErr(x.message);
    }
    await write(async () => {}, "Вебхук сохранён");
    onClose();
  }
  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>{hook ? "Вебхук" : "Новый вебхук"}</h2>
        <div className="row2">
          <div className="field"><label htmlFor="w-name">Название *</label><input id="w-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Чат QA" autoFocus /></div>
          <div className="field"><label htmlFor="w-active">Состояние</label>
            <select id="w-active" className="input" value={f.active ? "1" : "0"} onChange={(e) => setF({ ...f, active: e.target.value === "1" })}><option value="1">Включён</option><option value="0">Выключен</option></select></div>
        </div>
        <div className="field"><label htmlFor="w-url">URL *</label>
          <div style={{ display: "flex", gap: 8 }}>
            <select className="input" style={{ width: 100 }} aria-label="Метод" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as Webhook["method"] })}>
              {["POST", "PUT", "PATCH", "GET"].map((m) => <option key={m}>{m}</option>)}
            </select>
            <input id="w-url" className="input mono" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://chat.example.com/hooks/{{project.key | lower}}" />
          </div>
        </div>
        <div className="field"><label>События *</label>
          <div className="history" style={{ maxHeight: 180, overflow: "auto" }}>
            {Object.entries(events).map(([k, label]) => (
              <label key={k} style={{ display: "flex", gap: 8 }}>
                <input type="checkbox" checked={ev.includes(k)} onChange={() => setEv(ev.includes(k) ? ev.filter((x) => x !== k) : [...ev, k])} />
                <span>{label}</span><span className="muted mono small">{k}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="field"><label htmlFor="w-body">Тело запроса (шаблон)</label>
          <textarea id="w-body" className="input mono" rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder={BODY_EXAMPLE} />
          <span className="muted" style={{ fontSize: 12 }}>
            Пусто — JSON события целиком. Поля: event, title, at, project.key/name, actor.login/name, bug.*, run.*, case.*, autorun.*, test.*.
            Фильтры: | json, | jsonstr (внутри строки JSON), | url, | upper, | lower, | default:"…"
          </span>
        </div>
        <div className="row2">
          <div className="field"><label htmlFor="w-headers">Заголовки — по одному в строке</label>
            <textarea id="w-headers" className="input mono" rows={3} value={f.headers} onChange={(e) => setF({ ...f, headers: e.target.value })} placeholder={"Authorization: Bearer xxx\nX-Project: {{project.key}}"} /></div>
          <div className="field"><label htmlFor="w-filter">Условия — поле = значения через запятую</label>
            <textarea id="w-filter" className="input mono" rows={3} value={f.filter} onChange={(e) => setF({ ...f, filter: e.target.value })} placeholder={"bug.severity = blocker, critical\nautorun.branch = main"} /></div>
        </div>
        <div className="field"><label htmlFor="w-secret">Секрет для подписи {hook?.hasSecret && "(задан — оставьте пустым, чтобы не менять)"}</label>
          <input id="w-secret" className="input mono" type="password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} autoComplete="off" />
          <span className="muted" style={{ fontSize: 12 }}>Получатель проверит заголовок X-TestBall-Signature: sha256=HMAC(секрет, тело)</span></div>
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}

function DeliveryLog({ pid, hook, onClose }: { pid: string; hook: Webhook; onClose: () => void }) {
  const { value } = useLoad<{ deliveries: WebhookDelivery[] }>(`${paths.webhook(pid, hook.id)}/deliveries`);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Modal onClose={onClose} wide>
      <h2>Журнал: {hook.name}</h2>
      {!value ? <div className="skel">Загружаем…</div> : !value.deliveries.length ? <span className="muted">Доставок ещё не было</span> : (
        <div className="history" style={{ maxHeight: 420, overflow: "auto" }}>
          {value.deliveries.map((d) => (
            <div key={d.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
              <button type="button" className="btn ghost sm" style={{ justifyContent: "flex-start", gap: 10 }} onClick={() => setOpen(open === d.id ? null : d.id)}>
                {d.error ? <Pill tone="crit" label={d.status ? `HTTP ${d.status}` : "Ошибка"} sm /> : <Pill tone="ok" label={`HTTP ${d.status}`} sm />}
                <span className="mono small">{d.event}</span>
                {d.attempt > 1 && <span className="tag">попытка {d.attempt}</span>}
                <span className="muted small">{fmt(d.at)} · {d.durationMs} мс</span>
              </button>
              {open === d.id && (
                <>
                  {d.error && <span className="small" style={{ color: "var(--crit)" }}>{d.error}</span>}
                  <span className="label">Запрос</span><pre className="code">{d.request || "(без тела)"}</pre>
                  <span className="label">Ответ</span><pre className="code">{d.response || "(пусто)"}</pre>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="acts"><button className="btn" onClick={onClose}>Закрыть</button></div>
    </Modal>
  );
}

// ---------- трекер задач ----------
const TRACKERS: { key: TrackerKind; label: string; ref: string; refHint: string; url: string; login?: string; token: string }[] = [
  { key: "jira", label: "Jira", ref: "Ключ проекта", refHint: "PROJ", url: "https://jira.company.ru", login: "E-mail (Jira Cloud) — пусто для Server/DC с PAT", token: "API-токен / Personal Access Token" },
  { key: "youtrack", label: "YouTrack", ref: "ID проекта", refHint: "0-1", url: "https://youtrack.company.ru", token: "Постоянный токен" },
  { key: "gitlab", label: "GitLab", ref: "ID или путь проекта", refHint: "42 или group/app", url: "https://gitlab.company.ru", token: "Токен с правом api" },
  { key: "github", label: "GitHub", ref: "Репозиторий", refHint: "owner/repo", url: "https://api.github.com", token: "Fine-grained токен (Issues: read/write)" },
  { key: "redmine", label: "Redmine", ref: "Идентификатор проекта", refHint: "portal", url: "https://redmine.company.ru", token: "Ключ API" },
];

function TrackerSection({ pid }: { pid: string }) {
  const { write, toast } = useStore();
  const { value } = useLoad<{ tracker: Tracker | null }>(paths.tracker(pid));
  const [editing, setEditing] = useState(false);
  const t = value?.tracker;
  const def = TRACKERS.find((x) => x.key === t?.kind);
  const check = async () => {
    try {
      await api("POST", `${paths.tracker(pid)}/test`, {});
      toast("Трекер отвечает, доступ есть");
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section title="Трекер задач" hint="Баги TestBall можно отправлять задачами в трекер разработки; статус задачи подтягивается обратно."
      action={<button className="btn primary" onClick={() => setEditing(true)}>{t ? "Изменить" : "Подключить"}</button>}>
      {!value ? <div className="skel">Загружаем…</div> : !t ? <span className="muted small">Не подключён</span> : (
        <div className="linkbox" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <b>{def?.label}</b><span className="mono small">{t.baseUrl}</span><span className="small">проект {t.projectRef}</span>
          {t.settings.autoCreate && <span className="tag info">автосоздание задач</span>}
          {t.settings.closeToFixed && <span className="tag">закрытие → «Исправлен»</span>}
          <div className="spacer" />
          <button className="btn sm" onClick={check}>Проверить</button>
          <button className="btn ghost sm" style={{ color: "var(--crit)" }} onClick={() => write(() => api("DELETE", paths.tracker(pid), {}), "Трекер отключён")}>Отключить</button>
        </div>
      )}
      {editing && <TrackerEditor pid={pid} tracker={t || null} onClose={() => setEditing(false)} />}
    </Section>
  );
}

function TrackerEditor({ pid, tracker, onClose }: { pid: string; tracker: Tracker | null; onClose: () => void }) {
  const { write } = useStore();
  const [f, setF] = useState({
    kind: tracker?.kind || "jira" as TrackerKind, baseUrl: tracker?.baseUrl || "", projectRef: tracker?.projectRef || "", login: tracker?.login || "", token: "",
    issueType: tracker?.settings.issueType || "", labels: (tracker?.settings.labels || []).join(", "), autoCreate: tracker?.settings.autoCreate || false,
    sev: tracker?.settings.autoCreateSeverities || [] as Severity[], closeToFixed: tracker?.settings.closeToFixed ?? true,
  });
  const [err, setErr] = useState("");
  const def = TRACKERS.find((x) => x.key === f.kind)!;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      kind: f.kind, baseUrl: f.baseUrl, projectRef: f.projectRef, login: f.login,
      settings: { issueType: f.issueType, labels: f.labels.split(",").map((s) => s.trim()).filter(Boolean), autoCreate: f.autoCreate, autoCreateSeverities: f.sev, closeToFixed: f.closeToFixed },
    };
    if (f.token || !tracker) body.token = f.token;
    try {
      await api("PUT", paths.tracker(pid), body);
    } catch (x: any) {
      return setErr(x.message);
    }
    await write(async () => {}, "Трекер сохранён");
    onClose();
  }
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>Трекер задач</h2>
        <div className="field"><label htmlFor="t-kind">Система</label>
          <select id="t-kind" className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as TrackerKind })}>{TRACKERS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
        <div className="field"><label htmlFor="t-url">Адрес</label><input id="t-url" className="input mono" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder={def.url} /></div>
        <div className="field"><label htmlFor="t-ref">{def.ref}</label><input id="t-ref" className="input mono" value={f.projectRef} onChange={(e) => setF({ ...f, projectRef: e.target.value })} placeholder={def.refHint} /></div>
        {def.login && <div className="field"><label htmlFor="t-login">{def.login}</label><input id="t-login" className="input" value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} /></div>}
        <div className="field"><label htmlFor="t-token">{def.token}{tracker?.hasToken && " (задан — пусто, чтобы не менять)"}</label>
          <input id="t-token" className="input mono" type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} /></div>
        <div className="row2">
          {f.kind === "jira" && <div className="field"><label htmlFor="t-type">Тип задачи</label><input id="t-type" className="input" value={f.issueType} onChange={(e) => setF({ ...f, issueType: e.target.value })} placeholder="Bug" /></div>}
          {f.kind !== "youtrack" && f.kind !== "redmine" && <div className="field"><label htmlFor="t-labels">Метки</label><input id="t-labels" className="input" value={f.labels} onChange={(e) => setF({ ...f, labels: e.target.value })} placeholder="qa, testball" /></div>}
        </div>
        <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={f.closeToFixed} onChange={(e) => setF({ ...f, closeToFixed: e.target.checked })} /> Закрытая задача переводит баг из «В работе» в «Исправлен»</label>
        <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={f.autoCreate} onChange={(e) => setF({ ...f, autoCreate: e.target.checked })} /> Создавать задачу автоматически для новых багов</label>
        {f.autoCreate && (
          <div className="chips" style={{ gap: 6 }}>
            {SEVERITIES.map((s) => (
              <button type="button" key={s.key} className="stat" aria-pressed={f.sev.includes(s.key)}
                onClick={() => setF({ ...f, sev: f.sev.includes(s.key) ? f.sev.filter((x) => x !== s.key) : [...f.sev, s.key] })}>{s.label}</button>
            ))}
            <span className="muted small">ничего не выбрано — для всех</span>
          </div>
        )}
        <div className="err">{err}</div>
        <div className="acts"><button type="button" className="btn" onClick={onClose}>Отмена</button><button className="btn primary" type="submit">Сохранить</button></div>
      </form>
    </Modal>
  );
}

// ---------- задачи CI ----------
const CI_KINDS = [
  { key: "gitlab", label: "GitLab CI", target: "ID проекта", targetHint: "42", token: "Токен триггера (glptt-…) или токен с правом api" },
  { key: "github", label: "GitHub Actions", target: "owner/repo/workflow.yml", targetHint: "acme/app/e2e.yml", token: "Токен с правом Actions: write" },
  { key: "jenkins", label: "Jenkins", target: "Путь задачи", targetHint: "qa/e2e", token: "API-токен пользователя" },
  { key: "generic", label: "Другой (HTTP POST)", target: "Цель (необязательно)", targetHint: "", token: "Bearer-токен (необязательно)" },
] as const;

function CiJobs({ pid }: { pid: string }) {
  const { write } = useStore();
  const { value } = useLoad<{ jobs: CiJob[] }>(paths.ciJobs(pid));
  const [editing, setEditing] = useState<CiJob | "new" | null>(null);
  const [del, setDel] = useState<CiJob | null>(null);
  return (
    <Section title="Запуск автотестов в CI" hint="Задачи CI, которые можно запустить из вкладки «Автотесты» с параметрами. Номер запуска передаётся в CI как TESTBALL_RUN — результаты придут в него."
      action={<button className="btn primary" onClick={() => setEditing("new")}>+ Задача CI</button>}>
      {!value ? <div className="skel">Загружаем…</div> : !value.jobs.length ? <span className="muted small">Задач нет</span> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Название</th><th>Где</th><th>Параметры</th><th style={{ width: 180 }} /></tr></thead>
            <tbody>
              {value.jobs.map((j) => (
                <tr key={j.id}>
                  <td className="title">{j.name}</td>
                  <td className="small">{CI_KINDS.find((k) => k.key === j.kind)?.label} <span className="mono muted">{j.target} @ {j.ref}</span></td>
                  <td className="small mono">{j.params.map((p) => p.name).join(", ") || "—"}</td>
                  <td className="actions">
                    <button className="btn sm" onClick={() => setEditing(j)}>Изменить</button>
                    <button className="btn ghost sm" style={{ color: "var(--crit)" }} onClick={() => setDel(j)}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <CiJobEditor pid={pid} job={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      {del && <Confirm title={`Удалить задачу «${del.name}»?`} text="Запуски, сделанные через неё, останутся." onClose={() => setDel(null)}
        onYes={async () => { const j = del; setDel(null); await write(() => api("DELETE", paths.ciJob(pid, j.id), {}), "Задача удалена"); }} />}
    </Section>
  );
}

function CiJobEditor({ pid, job, onClose }: { pid: string; job?: CiJob; onClose: () => void }) {
  const { write } = useStore();
  const [f, setF] = useState({ name: job?.name || "", kind: job?.kind || "gitlab", baseUrl: job?.baseUrl || "", target: job?.target || "", ref: job?.ref || "main", login: job?.login || "", token: "" });
  const [params, setParams] = useState<(CiParam & { optionsText: string })[]>((job?.params || []).map((p) => ({ ...p, optionsText: p.options.join(", ") })));
  const [err, setErr] = useState("");
  const def = CI_KINDS.find((k) => k.key === f.kind)!;
  const setP = (i: number, patch: Partial<CiParam & { optionsText: string }>) => setParams(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      ...f, params: params.map((p) => ({ name: p.name, label: p.label, default: p.default, required: p.required, options: p.optionsText.split(",").map((s) => s.trim()).filter(Boolean) })),
    };
    if (!f.token && job) delete body.token;
    try {
      await (job ? api("PATCH", paths.ciJob(pid, job.id), body) : api("POST", paths.ciJobs(pid), body));
    } catch (x: any) {
      return setErr(x.message);
    }
    await write(async () => {}, "Задача CI сохранена");
    onClose();
  }
  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>{job ? "Задача CI" : "Новая задача CI"}</h2>
        <div className="row2">
          <div className="field"><label htmlFor="c-name">Название *</label><input id="c-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="E2E регресс" autoFocus /></div>
          <div className="field"><label htmlFor="c-kind">Система</label>
            <select id="c-kind" className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as CiJob["kind"] })}>{CI_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select></div>
        </div>
        <div className="row2">
          <div className="field"><label htmlFor="c-url">Адрес{f.kind === "generic" ? " для POST-запроса" : ""}</label>
            <input id="c-url" className="input mono" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder={f.kind === "github" ? "https://api.github.com" : "https://ci.company.ru"} /></div>
          <div className="field"><label htmlFor="c-target">{def.target}</label><input id="c-target" className="input mono" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} placeholder={def.targetHint} /></div>
        </div>
        <div className="row2">
          <div className="field"><label htmlFor="c-ref">Ветка / ref</label><input id="c-ref" className="input mono" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></div>
          {f.kind === "jenkins" && <div className="field"><label htmlFor="c-login">Пользователь Jenkins</label><input id="c-login" className="input" value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} /></div>}
        </div>
        <div className="field"><label htmlFor="c-token">{def.token}{job?.hasToken && " (задан — пусто, чтобы не менять)"}</label>
          <input id="c-token" className="input mono" type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} /></div>
        {f.kind === "github" && <span className="muted small">В workflow объявите input <span className="mono">testball_run</span> и передайте его в TESTBALL_RUN, а также inputs для параметров ниже.</span>}
        <div className="field">
          <label>Параметры запуска</label>
          {params.map((p, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 1fr 1.6fr auto auto", gap: 6, alignItems: "center" }}>
              <input className="input mono" aria-label="Имя" placeholder="BROWSER" value={p.name} onChange={(e) => setP(i, { name: e.target.value })} />
              <input className="input" aria-label="Подпись" placeholder="Браузер" value={p.label} onChange={(e) => setP(i, { label: e.target.value })} />
              <input className="input mono" aria-label="По умолчанию" placeholder="по умолчанию" value={p.default} onChange={(e) => setP(i, { default: e.target.value })} />
              <input className="input mono" aria-label="Варианты" placeholder="варианты через запятую" value={p.optionsText} onChange={(e) => setP(i, { optionsText: e.target.value })} />
              <label className="small" style={{ display: "flex", gap: 4 }}><input type="checkbox" checked={p.required} onChange={(e) => setP(i, { required: e.target.checked })} />обяз.</label>
              <button type="button" className="btn ghost sm" aria-label="Убрать параметр" onClick={() => setParams(params.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setParams([...params, { name: "", label: "", default: "", options: [], optionsText: "", required: false }])}>+ Параметр</button>
        </div>
        <div className="err">{err}</div>
        <div className="acts"><button type="button" className="btn" onClick={onClose}>Отмена</button><button className="btn primary" type="submit">Сохранить</button></div>
      </form>
    </Modal>
  );
}

// ---------- перенос проекта ----------
function ExportSection({ pid }: { pid: string }) {
  return (
    <Section title="Экспорт проекта" hint="Весь проект одним файлом: кейсы с историей версий, планы, прогоны, баги, комментарии, автотесты. Файл можно загрузить в другую установку TestBall (Проекты → Импорт).">
      <div className="flow">
        <a className="btn" href={paths.projectExport(pid, false)} style={{ textDecoration: "none" }}>Скачать без вложений</a>
        <a className="btn" href={paths.projectExport(pid, true)} style={{ textDecoration: "none" }}>Скачать со всеми вложениями</a>
      </div>
    </Section>
  );
}
