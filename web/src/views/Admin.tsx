// Администрирование: журнал аудита и удалённые проекты (корзина проектов)
import { useEffect, useState } from "react";
import { api } from "../api";
import { useLoad, useStore } from "../store";
import { Confirm, Empty, fmt, Modal } from "../ui";

interface AuditEntry { id: number; at: number; actor: string; ip: string; action: string; title: string; project: string | null; target: string; details: Record<string, unknown> }
interface AuditPage { items: AuditEntry[]; next: string | null; actions: Record<string, string>; retentionDays: number }

export function AuditLog() {
  const [f, setF] = useState({ actor: "", action: "", project: "", from: "", to: "" });
  const [before, setBefore] = useState<string[]>([]); // стек курсоров для «назад»
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
  const cursor = before[before.length - 1];
  const url = `/api/admin/audit?limit=100&${qs}${cursor ? `&before=${cursor}` : ""}`;
  const { value, error } = useLoad<AuditPage>(url);
  const set = (k: keyof typeof f, v: string) => {
    setF({ ...f, [k]: v });
    setBefore([]);
  };
  return (
    <section className="card">
      <p className="muted small" style={{ marginTop: 0 }}>
        Входы и неудачные попытки, роли и доступы, удаления и восстановления, интеграции, токены, выгрузки. Записи не меняются и хранятся{" "}
        {value?.retentionDays ?? 365} дней.
      </p>
      <div className="filters" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <input className="input" style={{ width: 150 }} placeholder="Пользователь" value={f.actor} onChange={(e) => set("actor", e.target.value)} aria-label="Пользователь" />
        <select className="input" style={{ width: 260 }} value={f.action} onChange={(e) => set("action", e.target.value)} aria-label="Действие">
          <option value="">Все действия</option>
          {Object.entries(value?.actions || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input mono" style={{ width: 90 }} placeholder="Проект" value={f.project} onChange={(e) => set("project", e.target.value.toUpperCase())} aria-label="Проект" />
        <label className="small muted">с <input className="input" type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></label>
        <label className="small muted">по <input className="input" type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></label>
        <a className="btn" href={`/api/admin/audit.csv?${qs}`} download>Выгрузить CSV</a>
      </div>
      {error && <div className="banner">{error}</div>}
      {!value ? (
        <div className="skel">Загружаем журнал…</div>
      ) : !value.items.length ? (
        <Empty title="Записей нет">Попробуйте изменить фильтры.</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Проект</th><th>Цель</th><th>IP</th></tr></thead>
            <tbody>
              {value.items.map((e) => (
                <tr key={e.id} title={JSON.stringify(e.details)}>
                  <td className="small muted" style={{ whiteSpace: "nowrap" }}>{fmt(e.at)}</td>
                  <td className="small">{e.actor || <span className="muted">система</span>}</td>
                  <td className="small">{e.title}</td>
                  <td className="mono small">{e.project || ""}</td>
                  <td className="mono small">{e.target}</td>
                  <td className="mono small muted">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="acts" style={{ justifyContent: "flex-start" }}>
        <button className="btn" disabled={!before.length} onClick={() => setBefore(before.slice(0, -1))}>← Новее</button>
        <button className="btn" disabled={!value?.next} onClick={() => value?.next && setBefore([...before, value.next])}>Старше →</button>
      </div>
    </section>
  );
}

interface DeletedProject { key: string; name: string; deletedBy: string | null; deleted: number; purgeAt: number }

export function DeletedProjects() {
  const { value, error } = useLoad<{ items: DeletedProject[]; days: number }>("/api/admin/trash/projects");
  const { write, reload } = useStore();
  const [purge, setPurge] = useState<DeletedProject | null>(null);
  const [typed, setTyped] = useState("");
  const [restoring, setRestoring] = useState<DeletedProject | null>(null);
  if (error) return <div className="banner">{error}</div>;
  if (!value) return <div className="skel">Загружаем…</div>;
  return (
    <section className="card">
      <p className="muted small" style={{ marginTop: 0 }}>
        Удалённый проект не виден никому, но все его данные и файлы сохраняются {value.days} дней. Восстановление возвращает проект со всеми
        участниками.
      </p>
      {!value.items.length ? (
        <Empty title="Удалённых проектов нет" />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Ключ</th><th>Название</th><th>Удалил</th><th>Когда</th><th>Удалится навсегда</th><th /></tr></thead>
            <tbody>
              {value.items.map((p) => (
                <tr key={p.key}>
                  <td className="mono">{p.key}</td>
                  <td>{p.name}</td>
                  <td className="small">{p.deletedBy || "—"}</td>
                  <td className="small muted">{fmt(p.deleted)}</td>
                  <td className="small muted">{fmt(p.purgeAt)}</td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <button className="btn sm" onClick={() => setRestoring(p)}>Восстановить</button>{" "}
                    <button className="btn sm danger" onClick={() => { setTyped(""); setPurge(p); }}>Удалить навсегда</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {restoring && (
        <Confirm title={`Восстановить проект ${restoring.key}?`} text="Проект снова появится у всех участников." action="Восстановить"
          onClose={() => setRestoring(null)}
          onYes={async () => {
            if (await write(() => api("POST", `/api/admin/projects/${restoring.key}/restore`), "Проект восстановлен")) await reload();
            setRestoring(null);
          }} />
      )}
      {purge && (
        <Modal onClose={() => setPurge(null)}>
          <h2>Удалить {purge.key} навсегда?</h2>
          <p className="muted" style={{ margin: 0 }}>Кейсы, прогоны, баги, автотесты и все вложения проекта удалятся без возможности восстановления.</p>
          <div className="field">
            <label htmlFor="purge-key">Введите ключ проекта: <b className="mono">{purge.key}</b></label>
            <input className="input mono" id="purge-key" value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} autoFocus autoComplete="off" />
          </div>
          <div className="acts">
            <button className="btn" onClick={() => setPurge(null)}>Отмена</button>
            <button className="btn danger solid" disabled={typed !== purge.key}
              onClick={async () => {
                await write(() => api("DELETE", `/api/admin/projects/${purge.key}`, { confirm: purge.key }), "Проект удалён навсегда");
                setPurge(null);
              }}>Удалить навсегда</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

interface System {
  version: string; commit: string | null; built: string | null; node: string; postgres: string;
  migrations: { count: number; last: string | null; lastAt: number | null };
  history: { version: string; commit: string | null; since: number; last: number }[];
}

interface LicenseState {
  edition: string; status: "none" | "active" | "grace" | "expired" | "invalid" | "wrong-host"; notice: string | null;
  full: number | null; view: number | null; source: "db" | "env" | null;
  license: { id: string; customer: string; issued: string | null; expires: string | null; perpetual?: boolean; host: string | null; test: boolean } | null;
  seats: { full: { used: number; limit: number | null }; view: { used: number; limit: number | null } };
}

const EDITIONS: Record<string, string> = { community: "Бесплатная", team: "Команда", enterprise: "Корпоративная", trial: "Пилот" };
const STATUS: Record<LicenseState["status"], string> = {
  none: "ключ не введён", active: "действует", grace: "пилот закончился, льготный период", expired: "пилот закончился", invalid: "ключ не принят", "wrong-host": "ключ для другого адреса",
};

// Лицензия: условия ключа, занятые места, ввод нового ключа
function LicenseCard() {
  const [state, setState] = useState<LicenseState | null>(null);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { toast, setMe, me } = useStore();
  const apply = (s: LicenseState) => {
    setState(s);
    if (me) setMe({ ...me, licenseNotice: s.notice });
  };
  useEffect(() => {
    api<LicenseState>("GET", "/api/admin/license").then(setState, (e) => setError(e.message));
  }, []);
  if (error) return <div className="banner">{error}</div>;
  if (!state) return <div className="skel">Загружаем лицензию…</div>;
  const l = state.license;
  const seat = (s: { used: number; limit: number | null }) => `${s.used}${s.limit !== null ? ` из ${s.limit}` : " (без ограничений)"}`;
  const rows: [string, string][] = [
    ["Редакция", `${EDITIONS[state.edition] || state.edition}${l?.test ? " (тестовый ключ)" : ""}`],
    ["Статус", STATUS[state.status]],
    ...(l ? ([["Владелец", l.customer], ["Номер", l.id], ["Срок", l.expires ? `пилот до ${l.expires}` : "бессрочно, обновления включены"], ...(l.host ? [["Адрес", l.host]] : [])] as [string, string][]) : []),
    ["Полные места (админы, тестировщики)", seat(state.seats.full)],
    ["Просмотровые места (разработчики, наблюдатели)", seat(state.seats.view)],
  ];
  async function save() {
    try {
      apply(await api<LicenseState>("PUT", "/api/admin/license", { key }));
      setKey("");
      setEditing(false);
      toast("Лицензия применена");
    } catch (e: any) {
      toast(e.message);
    }
  }
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Лицензия</h3>
      {state.notice && <div className="banner" style={{ marginBottom: 12 }}>{state.notice}</div>}
      <table className="tbl">
        <tbody>{rows.map(([k, v]) => <tr key={k}><td className="muted small" style={{ width: 280 }}>{k}</td><td className="small">{v}</td></tr>)}</tbody>
      </table>
      {state.status === "none" && (
        <p className="muted small">
          Без ключа работает бесплатная редакция: до {state.full} полных мест, просмотровых — без ограничений. Пользователей сверх лимита никто не
          отключает, нельзя только выдать новые полные роли.
        </p>
      )}
      {editing ? (
        <div className="view-block">
          <textarea className="input mono" rows={4} placeholder="TB1.…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Лицензионный ключ" />
          <div className="acts" style={{ justifyContent: "flex-start" }}>
            <button className="btn primary" disabled={!key.trim()} onClick={save}>Применить</button>
            <button className="btn" onClick={() => setEditing(false)}>Отмена</button>
          </div>
        </div>
      ) : (
        <div className="acts" style={{ justifyContent: "flex-start" }}>
          <button className="btn primary" onClick={() => setEditing(true)}>{l ? "Заменить ключ" : "Ввести ключ"}</button>
          {state.source === "db" && <button className="btn ghost" onClick={() => setRemoving(true)}>Удалить ключ</button>}
          {state.source === "env" && <span className="muted small">Ключ задан переменной LICENSE_KEY; введённый здесь ключ заменит его.</span>}
        </div>
      )}
      {removing && (
        <Confirm
          title="Удалить лицензионный ключ?"
          text={`Начнут действовать условия бесплатной редакции${state.source === "db" ? " (или ключ из LICENSE_KEY, если он задан)" : ""}. Пользователи и данные не пострадают.`}
          action="Удалить"
          onClose={() => setRemoving(false)}
          onYes={async () => {
            setRemoving(false);
            try {
              apply(await api<LicenseState>("DELETE", "/api/admin/license", {}));
              toast("Ключ удалён");
            } catch (e: any) {
              toast(e.message);
            }
          }}
        />
      )}
    </section>
  );
}

// О системе: версия и сборка, база, история обновлений — пригодится в обращении в поддержку
export function SystemInfo() {
  return (
    <>
      <LicenseCard />
      <About />
      <JobsCard />
    </>
  );
}

interface JobsOverview {
  kinds: { kind: string; title: string; every: number | null }[];
  counts: { kind: string; title: string; status: "queued" | "running" | "done" | "failed"; count: number; oldest: number | null }[];
  failed: { id: number; kind: string; title: string; payload: any; attempts: number; error: string; finished: number | null; created: number }[];
}
const JOB_STATUS: Record<string, string> = { queued: "в очереди", running: "выполняются", done: "выполнено за сутки", failed: "упали" };

// Фоновые задачи: доставка вебхуков, задачи в трекере, синхронизация, уборка. Упавшие можно повторить
function JobsCard() {
  const [v, setV] = useState<JobsOverview | null>(null);
  const [error, setError] = useState("");
  const { toast } = useStore();
  const load = () => api<JobsOverview>("GET", "/api/admin/jobs").then(setV, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  if (error) return <div className="banner">{error}</div>;
  if (!v) return null;
  const byKind = new Map<string, Record<string, number>>();
  for (const c of v.counts) byKind.set(c.title, { ...(byKind.get(c.title) || {}), [c.status]: c.count });
  const what = (j: JobsOverview["failed"][number]) =>
    j.payload?.event ? `${j.payload.event.title || j.payload.event.event} · ${j.payload.event.project?.key || ""}` : j.payload?.key ? `${j.payload.key}-B${j.payload.num}` : "";
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Фоновые задачи</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Доставка вебхуков, задачи в трекере, синхронизация статусов и уборка выполняются в очереди: переживают перезапуск сервера и повторяются при ошибках.
      </p>
      {byKind.size > 0 ? (
        <table className="tbl">
          <tbody>
            {[...byKind.entries()].map(([title, st]) => (
              <tr key={title}>
                <td style={{ width: 280 }}>{title}</td>
                <td className="small">
                  {Object.entries(st).map(([k, n]) => <span key={k} className={k === "failed" ? "c-crit" : "muted"} style={{ marginRight: 12 }}>{JOB_STATUS[k]}: <b>{n}</b></span>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="small muted">За последние сутки задач не было.</p>}
      {v.failed.length > 0 && (
        <>
          <h3>Упавшие задачи</h3>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Задача</th><th>Ошибка</th><th>Попыток</th><th>Когда</th><th /></tr></thead>
              <tbody>
                {v.failed.map((j) => (
                  <tr key={j.id}>
                    <td className="wrap">{j.title}<div className="small muted">{what(j)}</div></td>
                    <td className="small" style={{ maxWidth: 420, wordBreak: "break-word" }}>{j.error}</td>
                    <td className="small">{j.attempts}</td>
                    <td className="small muted">{fmt(j.finished)}</td>
                    <td><button className="btn sm" onClick={async () => { try { await api("POST", `/api/admin/jobs/${j.id}/retry`, {}); toast("Задача поставлена в очередь"); setTimeout(load, 1500); } catch (e: any) { toast(e.message); } }}>Повторить</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="acts" style={{ justifyContent: "flex-start" }}><button className="btn ghost sm" onClick={load}>Обновить</button></div>
    </section>
  );
}

function About() {
  const { value, error } = useLoad<System>("/api/admin/system");
  if (error) return <div className="banner">{error}</div>;
  if (!value) return <div className="skel">Загружаем…</div>;
  const rows: [string, string][] = [
    ["Версия TestBall", value.version],
    ["Сборка", [value.commit?.slice(0, 12), value.built].filter(Boolean).join(" · ") || "—"],
    ["PostgreSQL", value.postgres],
    ["Node.js", value.node],
    ["Схема базы", `${value.migrations.count} миграций, последняя ${value.migrations.last || "—"}${value.migrations.lastAt ? ` (${fmt(value.migrations.lastAt)})` : ""}`],
  ];
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>О системе</h3>
      <table className="tbl">
        <tbody>{rows.map(([k, v]) => <tr key={k}><td className="muted small" style={{ width: 280 }}>{k}</td><td className="mono small">{v}</td></tr>)}</tbody>
      </table>
      <div className="acts" style={{ justifyContent: "flex-start" }}>
        <button className="btn" onClick={() => navigator.clipboard?.writeText(text)}>Скопировать для поддержки</button>
      </div>
      <h3>История обновлений</h3>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Версия</th><th>Впервые запущена</th><th>Последний запуск</th><th>Сборка</th></tr></thead>
          <tbody>
            {value.history.map((h) => (
              <tr key={h.version}>
                <td className="mono">{h.version}</td>
                <td className="small muted">{fmt(h.since)}</td>
                <td className="small muted">{fmt(h.last)}</td>
                <td className="mono small muted">{h.commit?.slice(0, 12) || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Как обновляться и что делать при неудачном обновлении — в docs/UPGRADE.md. Список изменений — в CHANGELOG.md.</p>
    </section>
  );
}
