// Релизы и майлстоуны (E-01): список релизов со спринтами, страница готовности релиза, привязка прогонов, планов и багов
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { BUG_STATUSES, find, isOpenBug } from "../labels";
import { go, href } from "../router";
import { useCan, useData, useLoad, useStore } from "../store";
import type { Project, Release, ReleaseDetail, ReleaseStatus, ResultValue } from "../types";
import type { Tone } from "../labels";
import { Confirm, Empty, Modal, Pill, ResultBar, Sev, Who } from "../ui";

const url = (pid: string) => `/api/projects/${encodeURIComponent(pid)}/releases`;
export const RELEASE_STATUSES: { key: ReleaseStatus; label: string; tone: Tone }[] = [
  { key: "planned", label: "Запланирован", tone: "neutral" },
  { key: "active", label: "Идёт", tone: "info" },
  { key: "released", label: "Выпущен", tone: "ok" },
  { key: "cancelled", label: "Отменён", tone: "neutral" },
];
const statusOf = (s: ReleaseStatus) => RELEASE_STATUSES.find((x) => x.key === s)!;
const dmy = (d: string | null) => (d ? d.split("-").reverse().join(".") : "");
const daysLeft = (due: string | null) => (due ? Math.ceil((Date.parse(due + "T23:59:59") - Date.now()) / 86400000) : null);

export function useReleases(pid: string): Release[] {
  return useLoad<{ items: Release[] }>(url(pid)).value?.items || [];
}

// Выбор релиза в формах прогона, плана и бага: спринты показаны внутри релизов
export function ReleaseSelect({ pid, value, onChange, id = "f-release" }: { pid: string; value: string; onChange: (v: string) => void; id?: string }) {
  const list = useReleases(pid).filter((r) => r.status !== "cancelled" || String(r.num) === value);
  if (!list.length && !value) return null;
  const tops = list.filter((r) => !r.parent);
  return (
    <div className="field">
      <label htmlFor={id}>Релиз</label>
      <select className="input" id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Без релиза</option>
        {tops.map((r) => [
          <option key={r.num} value={r.num}>{r.name}{r.due ? ` · до ${dmy(r.due)}` : ""}</option>,
          ...list.filter((s) => s.parent === r.num).map((s) => <option key={s.num} value={s.num}>   └ {s.name}</option>),
        ])}
      </select>
    </div>
  );
}

// Метка релиза в списках
export function ReleaseTag({ pid, num, list }: { pid: string; num?: number | null; list: Release[] }) {
  if (!num) return null;
  const r = list.find((x) => x.num === num);
  return <a className="chip" href={href("p", pid, "releases", num)} title="Релиз">{r ? r.name : `V${num}`}</a>;
}

export function ReleasesTab({ project, openNum }: { project: Project; openNum?: number }) {
  const p = project.id;
  const canEdit = useCan("plans.edit");
  const list = useReleases(p);
  const [editing, setEditing] = useState<Release | "new" | null>(null);
  if (openNum !== undefined) return <ReleasePage pid={p} num={openNum} />;
  const tops = list.filter((r) => !r.parent);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        Релиз собирает тест-планы, прогоны и баги одной версии. Внутри релиза можно завести спринты. На странице релиза видно, готов ли он к выпуску.
      </p>
      <div className="toolbar">
        <div className="spacer" />
        {canEdit && <button className="btn primary" onClick={() => setEditing("new")}>+ Релиз</button>}
      </div>
      {!tops.length ? <Empty title="Релизов пока нет">Заведите релиз, чтобы следить за готовностью версии: прогресс прогонов, упавшие кейсы, открытые баги.</Empty> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>ID</th><th>Релиз</th><th>Статус</th><th>Сроки</th><th>Проверено</th><th>Прогонов</th><th>Открытых багов</th></tr></thead>
            <tbody>
              {tops.flatMap((r) => [r, ...list.filter((s) => s.parent === r.num)]).map((r) => {
                const st = statusOf(r.status);
                const left = r.status === "planned" || r.status === "active" ? daysLeft(r.due) : null;
                const c = r.cases;
                return (
                  <tr key={r.num} style={{ cursor: "pointer" }} onClick={() => go("p", p, "releases", r.num)}>
                    <td className="id">{r.ref}</td>
                    <td className="title" style={r.parent ? { paddingLeft: 32 } : undefined}>{r.parent ? "└ " : ""}{r.name}</td>
                    <td><Pill tone={st.tone} label={st.label} sm /></td>
                    <td className="small nowrap">
                      {r.starts || r.due ? `${dmy(r.starts)}${r.starts && r.due ? " — " : ""}${dmy(r.due)}` : <span className="muted">—</span>}
                      {left !== null && <div className={left < 0 ? "" : "muted"} style={left < 0 ? { color: "var(--crit)" } : undefined}>{left < 0 ? `просрочен на ${-left} дн.` : `осталось ${left} дн.`}</div>}
                    </td>
                    <td className="small">{c && c.total ? `${c.done}/${c.total} · пройдено ${c.passed}` : <span className="muted">—</span>}</td>
                    <td>{r.runs || <span className="muted">—</span>}</td>
                    <td>{r.openBugs || <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ReleaseModal pid={p} release={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ReleaseModal({ pid, release, parent, onClose }: { pid: string; release: Omit<Release, "runs" | "cases" | "openBugs"> | null; parent?: number; onClose: () => void }) {
  const { write } = useStore();
  const [f, setF] = useState({
    name: release?.name || "", description: release?.description || "", status: release?.status || ("planned" as ReleaseStatus),
    starts: release?.starts || "", due: release?.due || "",
  });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const sprint = Boolean(parent || release?.parent);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.name.trim()) return setErr(sprint ? "Укажите название спринта" : "Укажите название релиза");
    const body = { ...f, name: f.name.trim(), starts: f.starts || null, due: f.due || null, ...(parent ? { parent } : {}) };
    let num = release?.num || 0;
    const ok = await write(async () => {
      if (release) await api("PATCH", `${url(pid)}/${release.num}`, body);
      else num = (await api<{ num: number }>("POST", url(pid), body)).num;
    }, release ? "Сохранено" : sprint ? "Спринт создан" : "Релиз создан");
    if (ok) {
      onClose();
      if (!release && !parent) go("p", pid, "releases", num);
    }
  }
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <h2>{release ? (sprint ? "Спринт" : "Релиз") : sprint ? "Новый спринт" : "Новый релиз"}</h2>
        <div className="field"><label htmlFor="rl-name">Название *</label>
          <input className="input" id="rl-name" value={f.name} onChange={set("name")} placeholder={sprint ? "Например: Спринт 14" : "Например: 2.5 — новая корзина"} autoFocus /></div>
        <div className="row2">
          <div className="field"><label htmlFor="rl-starts">Начало</label><input className="input" id="rl-starts" type="date" value={f.starts} onChange={set("starts")} /></div>
          <div className="field"><label htmlFor="rl-due">Срок</label><input className="input" id="rl-due" type="date" value={f.due} onChange={set("due")} /></div>
        </div>
        <div className="field"><label htmlFor="rl-status">Статус</label>
          <select className="input" id="rl-status" value={f.status} onChange={set("status")}>{RELEASE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
        <div className="field"><label htmlFor="rl-desc">Описание</label><textarea className="input" id="rl-desc" rows={3} value={f.description} onChange={set("description")} /></div>
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary">{release ? "Сохранить" : "Создать"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ReleasePage({ pid, num }: { pid: string; num: number }) {
  const canEdit = useCan("plans.edit");
  const { write } = useStore();
  const { value: r, error } = useLoad<ReleaseDetail>(`${url(pid)}/${num}`);
  const [editing, setEditing] = useState(false);
  const [sprint, setSprint] = useState(false);
  const [linking, setLinking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const back = <a href={href("p", pid, "releases")} className="small">← Все релизы</a>;
  if (error) return <>{back}<Empty title="Релиз не найден" /></>;
  if (!r) return <>{back}<p className="muted">Загрузка…</p></>;
  const st = statusOf(r.status);
  const left = r.status === "planned" || r.status === "active" ? daysLeft(r.due) : null;
  const counts = r.cases.counts;
  return (
    <>
      {back}
      <div className="head" style={{ marginTop: 8 }}>
        <div>
          <span className="label">{r.ref}{r.parent ? " · спринт" : ""}</span>
          <h2 style={{ margin: "2px 0" }}>{r.name}</h2>
          <div className="small muted" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Pill tone={st.tone} label={st.label} sm />
            {(r.starts || r.due) && <span>{dmy(r.starts)}{r.starts && r.due ? " — " : ""}{dmy(r.due)}</span>}
            {left !== null && <span style={left < 0 ? { color: "var(--crit)", fontWeight: 600 } : undefined}>{left < 0 ? `просрочен на ${-left} дн.` : `осталось ${left} дн.`}</span>}
            {r.released && <span>выпущен {new Date(r.released).toLocaleDateString("ru-RU")}</span>}
          </div>
          {r.description && <p style={{ whiteSpace: "pre-wrap" }}>{r.description}</p>}
        </div>
        <div className="spacer" />
        {canEdit && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setLinking(true)}>Привязать…</button>
            {!r.parent && <button className="btn" onClick={() => setSprint(true)}>+ Спринт</button>}
            <button className="btn" onClick={() => setEditing(true)}>Изменить</button>
            <button className="btn ghost" style={{ color: "var(--crit)" }} onClick={() => setDeleting(true)}>Удалить</button>
          </div>
        )}
      </div>

      <section className={`card readiness ${r.ready ? "ok" : "bad"}`}>
        <h3 style={{ margin: 0 }}>{r.ready ? "✓ Готов к выпуску" : "Не готов к выпуску"}</h3>
        {r.ready ? <p className="small muted" style={{ margin: "4px 0 0" }}>Все кейсы проверены и пройдены, блокирующих и критичных багов нет.</p> : (
          <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{r.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        )}
      </section>

      <div className="kpis">
        <div className="kpi"><span className="v">{r.cases.progress}%</span><span className="l">кейсов проверено ({r.cases.done} из {r.cases.total})</span></div>
        <div className="kpi"><span className="v">{r.cases.passRate}%</span><span className="l">проверенных пройдено</span></div>
        <div className="kpi"><span className="v">{r.bugs.open}</span><span className="l">открытых багов{r.bugs.severe ? `, из них критичных ${r.bugs.severe}` : ""}</span></div>
        <div className="kpi"><span className="v">{r.runs.length}</span><span className="l">прогонов</span></div>
      </div>
      {r.cases.total > 0 && <ResultBar counts={counts} title="Последний результат каждого кейса в прогонах релиза" />}

      {r.sprints.length > 0 && (
        <section>
          <h3>Спринты</h3>
          <div className="history">
            {r.sprints.map((s) => (
              <div key={s.num}>
                <a className="chip" href={href("p", pid, "releases", s.num)}>{s.ref}</a>
                <span style={{ flex: 1 }}>{s.name}</span>
                <span className="small muted">{dmy(s.starts)}{s.starts && s.due ? " — " : ""}{dmy(s.due)}</span>
                <Pill tone={statusOf(s.status).tone} label={statusOf(s.status).label} sm />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3>Тест-планы</h3>
        {!r.plans.length ? <p className="muted small">Нет. Привяжите план — прогоны по нему сами попадут в релиз.</p> : (
          <div className="history">
            {r.plans.map((x) => (
              <div key={x.num}><a className="chip" href={href("p", pid, "plans", x.num)}>{pid}-P{x.num}</a><span style={{ flex: 1 }}>{x.title}</span>
                <span className="small muted">{x.mode === "dynamic" ? "Динамический" : "Статический"}{x.locked ? " · заблокирован" : ""}</span></div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3>Прогоны</h3>
        {!r.runs.length ? <p className="muted small">Нет. Выберите релиз при создании прогона или привяжите существующий.</p> : (
          <div className="history">
            {r.runs.map((x) => {
              const c = { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, ...x.counts } as Record<ResultValue, number>;
              const total = Object.values(c).reduce((a, b) => a + b, 0);
              return (
                <div key={x.num}>
                  <a className="chip" href={href("p", pid, "runs", x.num)}>{pid}-R{x.num}</a>
                  <span style={{ flex: 1, minWidth: 140 }}>{x.title}{x.build ? <span className="muted small"> · {x.build}</span> : null}</span>
                  <span className="small muted">{total - c.untested}/{total}{c.failed ? ` · упало ${c.failed}` : ""}</span>
                  <Pill tone={x.state === "open" ? "info" : "neutral"} label={x.state === "open" ? "Идёт" : "Закрыт"} sm />
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h3>Баги</h3>
        {!r.bugs.list.length ? <p className="muted small">Нет. Баги из прогонов релиза попадают сюда сами.</p> : (
          <div className="history">
            {r.bugs.list.map((b) => {
              const s = find(BUG_STATUSES, b.status);
              return (
                <div key={b.num} style={isOpenBug(b.status) ? undefined : { opacity: 0.6 }}>
                  <a className="chip" href={href("p", pid, "bugs", b.num)}>{pid}-B{b.num}</a>
                  <span style={{ flex: 1, minWidth: 140 }}>{b.title}</span>
                  <Sev s={b.severity} />
                  <Pill tone={s.tone} label={s.label} sm />
                  {b.assignee && <Who login={b.assignee} />}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {editing && <ReleaseModal pid={pid} release={r} onClose={() => setEditing(false)} />}
      {sprint && <ReleaseModal pid={pid} release={null} parent={r.num} onClose={() => setSprint(false)} />}
      {linking && <LinkModal pid={pid} release={r} onClose={() => setLinking(false)} />}
      {deleting && (
        <Confirm title={`Удалить ${r.parent ? "спринт" : "релиз"} «${r.name}»?`}
          text={`Прогоны, планы и баги останутся, только отвяжутся${r.sprints.length ? `. Спринты релиза (${r.sprints.length}) тоже удалятся` : ""}.`}
          action="Удалить" onClose={() => setDeleting(false)}
          onYes={async () => { setDeleting(false); if (await write(() => api("DELETE", `${url(pid)}/${r.num}`), "Удалено")) go("p", pid, "releases"); }} />
      )}
    </>
  );
}

// Привязать к релизу прогоны, планы и баги проекта (отмеченное — в релизе)
function LinkModal({ pid, release, onClose }: { pid: string; release: ReleaseDetail; onClose: () => void }) {
  const data = useData();
  const { write } = useStore();
  const [kind, setKind] = useState<"runs" | "plans" | "bugs">("runs");
  const items = kind === "runs" ? data.runs.filter((x) => x.pid === pid).map((x) => ({ num: x.num, ref: x.id, title: x.title, rel: x.release }))
    : kind === "plans" ? data.plans.filter((x) => x.pid === pid).map((x) => ({ num: x.num, ref: x.id, title: x.title, rel: x.release }))
    : data.bugs.filter((x) => x.pid === pid).map((x) => ({ num: x.num, ref: x.id, title: x.title, rel: x.release }));
  const [checked, setChecked] = useState<Record<string, Set<number>>>({});
  const sel = checked[kind] ?? new Set(items.filter((x) => x.rel === release.num).map((x) => x.num));
  const toggle = (n: number) => { const s = new Set(sel); s.has(n) ? s.delete(n) : s.add(n); setChecked({ ...checked, [kind]: s }); };
  async function save() {
    const ok = await write(async () => {
      for (const [k, s] of Object.entries(checked)) {
        const all = k === "runs" ? data.runs : k === "plans" ? data.plans : data.bugs;
        const had = all.filter((x) => x.pid === pid && x.release === release.num).map((x) => x.num);
        const add = [...s].filter((n) => !had.includes(n));
        const del = had.filter((n) => !s.has(n));
        if (add.length) await api("POST", `${url(pid)}/${release.num}/link`, { [k]: add });
        if (del.length) await api("POST", `${url(pid)}/${release.num}/link`, { [k]: del, linked: false });
      }
    }, "Привязки сохранены");
    if (ok) onClose();
  }
  return (
    <Modal onClose={onClose} wide>
      <h2>Привязать к «{release.name}»</h2>
      <div className="seg" role="tablist" style={{ marginBottom: 8 }}>
        {([["runs", "Прогоны"], ["plans", "Тест-планы"], ["bugs", "Баги"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>
        ))}
      </div>
      {!items.length ? <p className="muted">В проекте пока нет.</p> : (
        <div className="done-list" style={{ maxHeight: 360, overflow: "auto" }}>
          {items.map((x) => (
            <label key={x.num}>
              <input type="checkbox" checked={sel.has(x.num)} onChange={() => toggle(x.num)} /> <span className="mono small">{x.ref}</span> <span>{x.title}</span>
              {x.rel && x.rel !== release.num && <span className="muted small"> · сейчас в другом релизе</span>}
            </label>
          ))}
        </div>
      )}
      <div className="acts">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={save} disabled={!Object.keys(checked).length}>Сохранить</button>
      </div>
    </Modal>
  );
}
