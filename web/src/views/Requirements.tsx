// Требования и трассировка: требование ↔ тест-кейсы ↔ последние результаты ↔ баги
import { FormEvent, useMemo, useState } from "react";
import { api } from "../api";
import { go, href } from "../router";
import { useCanEdit, useData, useLoad, useStore } from "../store";
import type { Priority, Project, ResultValue } from "../types";
import { find, PRIORITIES, BUG_STATUSES, type Tone } from "../labels";
import { Confirm, Drawer, Empty, fmt, Modal, Pill, Prio, ResultPill } from "../ui";
import { TagInput, Tags } from "../casekit";

export type ReqStatus = "draft" | "approved" | "implemented" | "obsolete";
export type Coverage = "none" | "untested" | "failed" | "partial" | "passed";
export interface Requirement {
  num: number; title: string; description: string; status: ReqStatus; priority: Priority; extRef: string; url: string; tags: string[];
  createdBy: string | null; created: number; updated: number; cases: number[]; coverage: Coverage; openBugs: number;
  counts: Partial<Record<ResultValue, number>>;
}
interface RequirementFull extends Requirement {
  caseList: { num: number; title: string; priority: Priority; status: string; lastResult: ResultValue; runNum: number | null; executed: number | null }[];
  bugs: { num: number; title: string; status: string; severity: string; caseNum: number }[];
}

export const REQ_STATUSES: { key: ReqStatus; label: string; tone: Tone }[] = [
  { key: "draft", label: "Черновик", tone: "neutral" },
  { key: "approved", label: "Согласовано", tone: "info" },
  { key: "implemented", label: "Реализовано", tone: "ok" },
  { key: "obsolete", label: "Устарело", tone: "neutral" },
];
export const COVERAGE: { key: Coverage; label: string; tone: Tone; hint: string }[] = [
  { key: "none", label: "Не покрыто", tone: "warn", hint: "Нет связанных тест-кейсов" },
  { key: "untested", label: "Не проверено", tone: "neutral", hint: "Кейсы есть, но ещё не выполнялись" },
  { key: "failed", label: "Провалено", tone: "crit", hint: "Хотя бы один кейс упал или заблокирован" },
  { key: "partial", label: "Частично", tone: "info", hint: "Часть кейсов пройдена, остальные не выполнялись" },
  { key: "passed", label: "Пройдено", tone: "ok", hint: "Все кейсы пройдены" },
];
const covOf = (c: Coverage) => COVERAGE.find((x) => x.key === c)!;
const stOf = (s: ReqStatus) => REQ_STATUSES.find((x) => x.key === s)!;

export function RequirementsTab({ project, openNum }: { project: Project; openNum?: number }) {
  const p = project.id;
  const base = `/api/projects/${encodeURIComponent(p)}/requirements`;
  const [q, setQ] = useState("");
  const [cov, setCov] = useState<Coverage | "">("");
  const [status, setStatus] = useState<ReqStatus | "">("");
  const [editing, setEditing] = useState<Requirement | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const canEdit = useCanEdit();
  const { value, error } = useLoad<{ items: Requirement[]; summary: Partial<Record<Coverage, number>> }>(base);
  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (value?.items || []).filter(
      (r) =>
        (!s || r.title.toLowerCase().includes(s) || r.extRef.toLowerCase().includes(s) || `${p}-req${r.num}`.toLowerCase() === s || `req${r.num}` === s) &&
        (!cov || r.coverage === cov) &&
        (status ? r.status === status : r.status !== "obsolete")
    );
  }, [value, q, cov, status]);
  const open = openNum !== undefined ? value?.items.find((r) => r.num === openNum) : undefined;
  if (error) return <div className="banner">{error}</div>;
  if (!value) return <div className="skel">Загружаем требования…</div>;
  const active = value.items.filter((r) => r.status !== "obsolete").length;
  const covered = active - (value.summary.none || 0);

  return (
    <section>
      <div className="toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input className="input" style={{ width: 240 }} placeholder="Поиск: название, ключ, номер" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск требований" />
        <select className="input" style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value as ReqStatus | "")} aria-label="Статус">
          <option value="">Действующие</option>
          {REQ_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <div className="spacer" style={{ flex: 1 }} />
        <a className="btn" href={`${base}/matrix.csv`} download>Матрица трассировки (CSV)</a>
        {canEdit && <button className="btn" onClick={() => setImporting(true)}>Импорт</button>}
        {canEdit && <button className="btn primary" onClick={() => setEditing("new")}>+ Требование</button>}
      </div>
      {active > 0 && (
        <div className="card" style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <span>Покрыто тестами: <b>{covered} из {active}</b> ({Math.round((covered / active) * 100)}%)</span>
          {COVERAGE.map((c) => (
            <button key={c.key} className={`btn ghost sm${cov === c.key ? " on" : ""}`} title={c.hint} aria-pressed={cov === c.key} onClick={() => setCov(cov === c.key ? "" : c.key)}>
              <Pill tone={c.tone} label={`${c.label}: ${value.summary[c.key] || 0}`} sm />
            </button>
          ))}
        </div>
      )}
      {!value.items.length ? (
        <Empty title="Требований пока нет">
          Заведите требования или импортируйте их из Jira или ТЗ, свяжите с тест-кейсами — и будет видно, что покрыто тестами, что проверено и где баги.
        </Empty>
      ) : !items.length ? (
        <Empty title="Ничего не найдено">Измените поиск или фильтры.</Empty>
      ) : (
        <div className="tbl-wrap card" style={{ padding: 0 }}>
          <table className="tbl">
            <thead><tr><th>ID</th><th>Требование</th><th>Статус</th><th>Кейсы</th><th>Покрытие</th><th>Баги</th></tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.num} onClick={() => go("p", p, "reqs", r.num)} style={{ cursor: "pointer" }}>
                  <td className="mono small">{p}-REQ{r.num}</td>
                  <td>
                    <Prio p={r.priority} /> {r.title}
                    {r.extRef && <span className="mono muted small" style={{ marginLeft: 6 }}>{r.extRef}</span>}
                    <Tags tags={r.tags} />
                  </td>
                  <td><Pill tone={stOf(r.status).tone} label={stOf(r.status).label} sm /></td>
                  <td className="small">{r.cases.length || <span className="muted">—</span>}</td>
                  <td title={covOf(r.coverage).hint}><Pill tone={covOf(r.coverage).tone} label={covOf(r.coverage).label} sm /></td>
                  <td className="small">{r.openBugs ? <b className="c-crit">{r.openBugs}</b> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <RequirementDrawer project={project} base={base} req={open} onEdit={() => setEditing(open)} onClose={() => go("p", p, "reqs")} />}
      {editing && <RequirementEditor project={project} base={base} req={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {importing && <RequirementsImport base={base} onClose={() => setImporting(false)} />}
    </section>
  );
}

function RequirementDrawer({ project, base, req, onEdit, onClose }: { project: Project; base: string; req: Requirement; onEdit: () => void; onClose: () => void }) {
  const { value } = useLoad<RequirementFull>(`${base}/${req.num}`);
  const canEdit = useCanEdit();
  const { write } = useStore();
  const [deleting, setDeleting] = useState(false);
  const p = project.id;
  return (
    <Drawer
      label={`Требование ${p}-REQ${req.num}`}
      idTag={`${p}-REQ${req.num}`}
      title={req.title}
      onClose={onClose}
      footer={canEdit && (
        <>
          <button className="btn" onClick={onEdit}>Изменить</button>
          <button className="btn ghost danger" onClick={() => setDeleting(true)}>Удалить</button>
        </>
      )}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Pill tone={stOf(req.status).tone} label={stOf(req.status).label} />
        <Pill tone={covOf(req.coverage).tone} label={covOf(req.coverage).label} />
        <span className="small muted">приоритет: {find(PRIORITIES, req.priority).label.toLowerCase()}</span>
        {req.extRef && (req.url ? <a className="mono small" href={req.url} target="_blank" rel="noreferrer">{req.extRef} ↗</a> : <span className="mono small">{req.extRef}</span>)}
        {!req.extRef && req.url && <a className="small" href={req.url} target="_blank" rel="noreferrer">Источник ↗</a>}
      </div>
      <Tags tags={req.tags} />
      {req.description && <div className="view-block"><span className="label">Описание</span><div className="txt">{req.description}</div></div>}
      <div className="view-block">
        <span className="label">Тест-кейсы ({req.cases.length})</span>
        {!value ? <div className="skel">Загружаем…</div> : !value.caseList.length ? (
          <span className="muted small">Не связано ни одного кейса{canEdit ? " — нажмите «Изменить», чтобы добавить" : ""}.</span>
        ) : (
          <table className="tbl">
            <tbody>
              {value.caseList.map((c) => (
                <tr key={c.num}>
                  <td className="mono small"><a href={href("p", p, "cases", String(c.num))}>{p}-{c.num}</a></td>
                  <td>{c.title}</td>
                  <td><ResultPill r={c.lastResult} sm /></td>
                  <td className="small muted">{c.runNum ? <a href={href("p", p, "runs", String(c.runNum))}>прогон #{c.runNum}</a> : ""}{c.executed ? ` · ${fmt(c.executed)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {value && value.bugs.length > 0 && (
        <div className="view-block">
          <span className="label">Баги по этим кейсам</span>
          <table className="tbl">
            <tbody>
              {value.bugs.map((b) => (
                <tr key={b.num}>
                  <td className="mono small"><a href={href("p", p, "bugs", String(b.num))}>{p}-B{b.num}</a></td>
                  <td>{b.title}</td>
                  <td className="small">{find(BUG_STATUSES, b.status as never)?.label || b.status}</td>
                  <td className="mono small muted">{p}-{b.caseNum}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Создал {req.createdBy || "—"} {fmt(req.created)} · изменено {fmt(req.updated)}</p>
      {deleting && (
        <Confirm title={`Удалить ${p}-REQ${req.num}?`} text="Требование и его связи с кейсами удалятся. Сами кейсы, результаты и баги останутся." action="Удалить"
          onClose={() => setDeleting(false)}
          onYes={async () => {
            setDeleting(false);
            if (await write(() => api("DELETE", `${base}/${req.num}`, {}), `${p}-REQ${req.num} удалено`)) onClose();
          }} />
      )}
    </Drawer>
  );
}

function RequirementEditor({ project, base, req, onClose }: { project: Project; base: string; req: Requirement | null; onClose: () => void }) {
  const data = useData();
  const { write } = useStore();
  const p = project.id;
  const [f, setF] = useState({
    title: req?.title || "", description: req?.description || "", status: req?.status || ("draft" as ReqStatus), priority: req?.priority || ("medium" as Priority),
    extRef: req?.extRef || "", url: req?.url || "", tags: req?.tags || [], cases: req?.cases || [],
  });
  const [pick, setPick] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const projectCases = data.cases.filter((c) => c.pid === p);
  const title = (n: number) => projectCases.find((c) => c.num === n)?.title || "кейс не найден";
  const s = pick.trim().toLowerCase();
  const options = s
    ? projectCases.filter((c) => !f.cases.includes(c.num) && (c.title.toLowerCase().includes(s) || `${p}-${c.num}`.toLowerCase() === s || String(c.num) === s)).slice(0, 8)
    : [];
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await write(
      () => (req ? api("PATCH", `${base}/${req.num}`, f) : api("POST", base, f)),
      req ? `${p}-REQ${req.num} сохранено` : "Требование создано"
    );
    if (ok) onClose();
  }
  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={submit} id="reqForm">
        <h2>{req ? `${p}-REQ${req.num}` : "Новое требование"}</h2>
        <div className="field"><label htmlFor="rq-title">Название *</label>
          <input id="rq-title" className="input" value={f.title} onChange={(e) => set("title", e.target.value)} autoFocus required maxLength={500} /></div>
        <div className="field"><label htmlFor="rq-desc">Описание</label>
          <textarea id="rq-desc" className="input" rows={4} value={f.description} onChange={(e) => set("description", e.target.value)} /></div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div className="field"><label htmlFor="rq-status">Статус</label>
            <select id="rq-status" className="input" value={f.status} onChange={(e) => set("status", e.target.value as ReqStatus)}>
              {REQ_STATUSES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select></div>
          <div className="field"><label htmlFor="rq-prio">Приоритет</label>
            <select id="rq-prio" className="input" value={f.priority} onChange={(e) => set("priority", e.target.value as Priority)}>
              {PRIORITIES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select></div>
          <div className="field"><label htmlFor="rq-ext">Ключ во внешней системе</label>
            <input id="rq-ext" className="input mono" placeholder="PROJ-123" value={f.extRef} onChange={(e) => set("extRef", e.target.value)} maxLength={100} /></div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}><label htmlFor="rq-url">Ссылка</label>
            <input id="rq-url" className="input" placeholder="https://…" value={f.url} onChange={(e) => set("url", e.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="rq-tags">Теги</label><TagInput id="rq-tags" value={f.tags} onChange={(v) => set("tags", v)} /></div>
        <div className="field">
          <label htmlFor="rq-case">Тест-кейсы</label>
          {f.cases.length > 0 && (
            <ul className="plain" style={{ margin: "0 0 6px", padding: 0, listStyle: "none" }}>
              {f.cases.map((n) => (
                <li key={n} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="mono small">{p}-{n}</span><span style={{ flex: 1 }}>{title(n)}</span>
                  <button type="button" className="btn ghost sm" aria-label={`Отвязать ${p}-${n}`} onClick={() => set("cases", f.cases.filter((x) => x !== n))}>✕</button>
                </li>
              ))}
            </ul>
          )}
          <input id="rq-case" className="input" placeholder="Найти кейс по названию или номеру" value={pick} onChange={(e) => setPick(e.target.value)} />
          {options.length > 0 && (
            <div className="history" style={{ marginTop: 4 }}>
              {options.map((c) => (
                <button key={c.num} type="button" className="btn ghost sm" style={{ justifyContent: "flex-start" }} onClick={() => { set("cases", [...f.cases, c.num]); setPick(""); }}>
                  <span className="mono">{p}-{c.num}</span>&nbsp;{c.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary">{req ? "Сохранить" : "Создать"}</button>
        </div>
      </form>
    </Modal>
  );
}

// Импорт из CSV (выгрузка Jira, Excel): колонки определяются по заголовкам. Повторный импорт обновляет требования с тем же ключом
const COLS: Record<string, string[]> = {
  title: ["название", "summary", "title", "требование", "тема"],
  extRef: ["ключ", "key", "issue key", "id", "внешний ключ"],
  description: ["описание", "description"],
  url: ["ссылка", "url", "link"],
  priority: ["приоритет", "priority"],
  cases: ["тест-кейсы", "кейсы", "cases", "test cases"],
};
const PRIO_MAP: Record<string, Priority> = { highest: "high", high: "high", высокий: "high", medium: "medium", средний: "medium", low: "low", lowest: "low", низкий: "low" };

export function parseCsv(text: string): string[][] {
  const sep = (text.split("\n")[0].match(/;/g) || []).length >= (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function RequirementsImport({ base, onClose }: { base: string; onClose: () => void }) {
  const { toast, reload } = useStore();
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [report, setReport] = useState<{ created: number; updated: number; errors: string[] } | null>(null);
  async function load(file: File) {
    const rows = parseCsv((await file.text()).replace(/^﻿/, ""));
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const idx = Object.fromEntries(Object.entries(COLS).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
    if (idx.title < 0) return toast("Не найдена колонка с названием (Название, Summary или Title)");
    setItems(rows.slice(1).map((r) => {
      const get = (k: string) => (idx[k] >= 0 ? (r[idx[k]] || "").trim() : "");
      return {
        title: get("title"), extRef: get("extRef"), description: get("description"), url: get("url"),
        priority: PRIO_MAP[get("priority").toLowerCase()] || "medium",
        cases: get("cases").split(/[,;\s]+/).map((x) => Number(x.replace(/^[A-Z]+-/i, ""))).filter((n) => n > 0),
      };
    }));
  }
  async function run() {
    try {
      setReport(await api("POST", `${base}/import`, { items }));
      reload();
    } catch (e: any) {
      toast(e.message);
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>Импорт требований</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        CSV из Jira, Excel или любой системы. Нужна колонка «Название» (или Summary); необязательные — «Ключ» (Issue key), «Описание», «Ссылка»,
        «Приоритет», «Тест-кейсы» (номера через запятую). Требование с уже известным ключом обновится, а не задвоится.
      </p>
      {report ? (
        <div className="view-block">
          <span>Создано: <b>{report.created}</b>, обновлено: <b>{report.updated}</b></span>
          {report.errors.length > 0 && <div className="banner">{report.errors.slice(0, 20).join("\n")}</div>}
        </div>
      ) : (
        <>
          <input type="file" accept=".csv,text/csv" aria-label="Файл CSV" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
          {items && <p className="small">Найдено строк: <b>{items.length}</b></p>}
        </>
      )}
      <div className="acts">
        <button className="btn" onClick={onClose}>{report ? "Готово" : "Отмена"}</button>
        {!report && <button className="btn primary" disabled={!items?.length} onClick={run}>Импортировать</button>}
      </div>
    </Modal>
  );
}

// Требования в карточке кейса
export function CaseRequirements({ pid, caseNum }: { pid: string; caseNum: number }) {
  const { value } = useLoad<{ items: { num: number; title: string; status: ReqStatus; extRef: string }[] }>(
    `/api/projects/${encodeURIComponent(pid)}/cases/${caseNum}/requirements`
  );
  if (!value?.items.length) return null;
  return (
    <div className="view-block">
      <span className="label">Требования</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {value.items.map((r) => (
          <a key={r.num} href={href("p", pid, "reqs", String(r.num))} className="small">
            <span className="mono">{pid}-REQ{r.num}</span> {r.title}{r.extRef && <span className="mono muted"> · {r.extRef}</span>}
          </a>
        ))}
      </div>
    </div>
  );
}
