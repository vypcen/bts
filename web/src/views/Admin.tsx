// Администрирование: журнал аудита и удалённые проекты (корзина проектов)
import { useState } from "react";
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

// О системе: версия и сборка, база, история обновлений — пригодится в обращении в поддержку
export function SystemInfo() {
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
    <section className="card">
      <table className="tbl">
        <tbody>{rows.map(([k, v]) => <tr key={k}><td className="muted small" style={{ width: 200 }}>{k}</td><td className="mono small">{v}</td></tr>)}</tbody>
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
