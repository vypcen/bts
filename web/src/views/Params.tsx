// Параметры тест-кейсов и наборы данных проекта (D-06).
// Кейс с параметрами в прогоне проверяется по разу на каждый набор значений, в шагах {{имя}} заменяется значением.
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useCan, useLoad, useStore } from "../store";
import type { Dataset, ParamRow, ParamTable, Step } from "../types";
import { Confirm, fmt, Modal } from "../ui";

const url = (pid: string) => `/api/projects/${encodeURIComponent(pid)}/datasets`;

export function useDatasets(pid: string): Dataset[] {
  return useLoad<{ items: Dataset[] }>(url(pid)).value?.items || [];
}

// подстановка значений набора в текст шага: {{имя}} → значение; неизвестные имена остаются как есть
export const subst = (text: string, values?: Record<string, string>) =>
  !values || !text ? text : text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => (k in values ? values[k] : m));
export const substSteps = (steps: Step[], values?: Record<string, string>): Step[] =>
  values ? steps.map((s) => ({ ...s, action: subst(s.action, values), expected: subst(s.expected, values), data: subst(s.data, values) })) : steps;

// таблица параметров кейса (своя или из набора проекта)
export const paramsOf = (c: { params?: ParamTable; dataset?: ParamTable }): ParamTable | null => c.dataset || c.params || null;

export function ParamsView({ table, title }: { table: ParamTable; title?: string }) {
  return (
    <div className="tbl-wrap params-tbl">
      <table className="tbl">
        <thead><tr><th>{title || "Набор"}</th>{table.columns.map((c) => <th key={c} className="mono" style={{ textTransform: "none" }}>{`{{${c}}}`}</th>)}</tr></thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}><td><b>{r.name}</b></td>{table.columns.map((c) => <td key={c} className="wrap">{r.values[c] || <span className="muted">—</span>}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Редактор таблицы: параметры-колонки и наборы-строки
export function TableEditor({ value, onChange }: { value: ParamTable; onChange: (v: ParamTable) => void }) {
  const [newCol, setNewCol] = useState("");
  const cols = value.columns;
  const addCol = () => {
    const name = newCol.trim();
    if (!name || cols.includes(name)) return;
    onChange({ columns: [...cols, name], rows: value.rows.map((r) => ({ ...r, values: { ...r.values, [name]: "" } })) });
    setNewCol("");
  };
  const delCol = (c: string) => onChange({ columns: cols.filter((x) => x !== c), rows: value.rows.map((r) => { const v = { ...r.values }; delete v[c]; return { ...r, values: v }; }) });
  const setCell = (i: number, patch: Partial<ParamRow>) => onChange({ ...value, rows: value.rows.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const addRow = () => onChange({ ...value, rows: [...value.rows, { name: `Набор ${value.rows.length + 1}`, values: Object.fromEntries(cols.map((c) => [c, ""])) }] });
  return (
    <div className="params-editor">
      <div className="tbl-wrap params-tbl">
        <table className="tbl">
          <thead>
            <tr>
              <th>Набор</th>
              {cols.map((c) => (
                <th key={c} className="mono" style={{ textTransform: "none" }}>
                  {`{{${c}}}`} <button type="button" className="btn ghost sm" aria-label={`Удалить параметр ${c}`} onClick={() => delCol(c)}>✕</button>
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {value.rows.map((r, i) => (
              <tr key={i}>
                <td><input className="input" aria-label={`Название набора ${i + 1}`} value={r.name} onChange={(e) => setCell(i, { name: e.target.value })} /></td>
                {cols.map((c) => (
                  <td key={c}><input className="input" aria-label={`${c}, ${r.name}`} value={r.values[c] ?? ""} onChange={(e) => setCell(i, { values: { ...r.values, [c]: e.target.value } })} /></td>
                ))}
                <td><button type="button" className="btn ghost sm" aria-label={`Удалить набор ${r.name}`} onClick={() => onChange({ ...value, rows: value.rows.filter((_, k) => k !== i) })}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
        <input className="input" style={{ maxWidth: 220 }} aria-label="Новый параметр" placeholder="Новый параметр, например login" value={newCol}
          onChange={(e) => setNewCol(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCol(); } }} />
        <button type="button" className="btn sm" onClick={addCol} disabled={!newCol.trim()}>+ Параметр</button>
        <button type="button" className="btn sm" onClick={addRow} disabled={!cols.length}>+ Набор</button>
      </div>
    </div>
  );
}

// Блок «Параметры» в редакторе кейса: без параметров / своя таблица / набор данных проекта
export type ParamsForm = { mode: "none" | "own" | "dataset"; table: ParamTable; dataset: string };
export const paramsForm = (c?: { params?: ParamTable; dataset?: Dataset }): ParamsForm => ({
  mode: c?.dataset ? "dataset" : c?.params ? "own" : "none",
  table: c?.params || { columns: [], rows: [] },
  dataset: c?.dataset ? String(c.dataset.id) : "",
});
export const paramsBody = (p: ParamsForm) =>
  p.mode === "dataset" && p.dataset ? { dataset: Number(p.dataset), params: null }
    : p.mode === "own" && p.table.columns.length && p.table.rows.length ? { params: p.table, dataset: null }
    : { params: null, dataset: null };

export function ParamsEditor({ pid, value, onChange }: { pid: string; value: ParamsForm; onChange: (v: ParamsForm) => void }) {
  const sets = useDatasets(pid);
  const chosen = sets.find((d) => String(d.id) === value.dataset);
  return (
    <div className="field">
      <span className="label-like">Параметры</span>
      <div className="seg" role="radiogroup" aria-label="Параметры кейса" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        {([["none", "Без параметров"], ["own", "Своя таблица"], ["dataset", "Набор данных проекта"]] as const).map(([k, l]) => (
          <label key={k} className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" name="params-mode" checked={value.mode === k} onChange={() => onChange({ ...value, mode: k })} /> {l}
          </label>
        ))}
      </div>
      {value.mode === "own" && <TableEditor value={value.table} onChange={(table) => onChange({ ...value, table })} />}
      {value.mode === "dataset" && (
        <>
          <select className="input" aria-label="Набор данных" value={value.dataset} onChange={(e) => onChange({ ...value, dataset: e.target.value })}>
            <option value="">Выберите набор…</option>
            {sets.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.rows.length} наб.</option>)}
          </select>
          {!sets.length && <span className="muted small">В проекте ещё нет наборов данных: заведите их кнопкой «Наборы данных» над списком кейсов.</span>}
          {chosen && <ParamsView table={chosen} />}
        </>
      )}
      {value.mode !== "none" && (
        <span className="muted" style={{ fontSize: 12 }}>
          В шагах пишите {"{{имя}}"} — в прогоне кейс проверяется по разу на каждый набор, и вместо {"{{имя}}"} подставится значение.
        </span>
      )}
    </div>
  );
}

// Наборы данных проекта: список, создание, правка, удаление (кейсы получают копию таблицы)
export function DatasetsModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const list = useDatasets(pid);
  const canEdit = useCan("cases.edit");
  const { write } = useStore();
  const [editing, setEditing] = useState<Dataset | "new" | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Dataset | null>(null);
  if (editing) return <DatasetEditor pid={pid} ds={editing === "new" ? null : editing} onClose={() => setEditing(null)} />;
  return (
    <Modal onClose={onClose} wide>
      <h2>Наборы данных</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Общие таблицы значений для кейсов с параметрами: учётные записи, браузеры, тарифы. Кейс, которому выбран набор, в прогоне проверяется
        по разу на каждую строку. Правка набора действует на новые прогоны; идущие прогоны сохраняют свой снимок.
      </p>
      {!list.length ? <p className="muted">Наборов пока нет.</p> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Набор</th><th>Параметры</th><th>Строк</th><th>В кейсах</th><th>Изменён</th><th /></tr></thead>
            <tbody>
              {list.map((d) => [
                <tr key={d.id} style={{ cursor: "pointer" }} onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <td className="title">{d.name}</td>
                  <td className="mono small wrap">{d.columns.join(", ")}</td>
                  <td>{d.rows.length}</td>
                  <td>{d.usedIn || <span className="muted">—</span>}</td>
                  <td className="small muted">{d.updated ? fmt(d.updated) : ""}{d.updatedBy ? ` · ${d.updatedBy}` : ""}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    {canEdit && <button className="btn ghost sm" onClick={() => setEditing(d)}>Изменить</button>}
                    {canEdit && <button className="btn ghost sm" style={{ color: "var(--crit)" }} onClick={() => setDeleting(d)} aria-label={`Удалить набор ${d.name}`}>✕</button>}
                  </td>
                </tr>,
                open === d.id && <tr key={`${d.id}-rows`}><td colSpan={6}><ParamsView table={d} /></td></tr>,
              ])}
            </tbody>
          </table>
        </div>
      )}
      <div className="acts">
        {canEdit && <button className="btn primary" onClick={() => setEditing("new")} style={{ marginRight: "auto" }}>+ Набор данных</button>}
        <button className="btn" onClick={onClose}>Закрыть</button>
      </div>
      {deleting && (
        <Confirm
          title={`Удалить набор «${deleting.name}»?`}
          text={deleting.usedIn ? `Набор используется в кейсах (${deleting.usedIn}). Они получат копию таблицы в свои параметры.` : "Набор не используется ни в одном кейсе."}
          action="Удалить"
          onClose={() => setDeleting(null)}
          onYes={async () => { const d = deleting; setDeleting(null); await write(() => api("DELETE", `${url(pid)}/${d.num}`), `Набор «${d.name}» удалён`); }}
        />
      )}
    </Modal>
  );
}

function DatasetEditor({ pid, ds, onClose }: { pid: string; ds: Dataset | null; onClose: () => void }) {
  const { write } = useStore();
  const [name, setName] = useState(ds?.name || "");
  const [table, setTable] = useState<ParamTable>(ds ? { columns: ds.columns, rows: ds.rows } : { columns: [], rows: [] });
  const [err, setErr] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErr("Укажите название набора");
    if (!table.columns.length || !table.rows.length) return setErr("Добавьте хотя бы один параметр и одну строку");
    const body = { name: name.trim(), ...table };
    const ok = await write(() => (ds ? api("PATCH", `${url(pid)}/${ds.num}`, body) : api("POST", url(pid), body)), ds ? `Набор «${body.name}» сохранён` : `Набор «${body.name}» создан`);
    if (ok) onClose();
  }
  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={submit} noValidate>
        <h2>{ds ? "Набор данных" : "Новый набор данных"}</h2>
        <div className="field"><label htmlFor="ds-name">Название *</label><input className="input" id="ds-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Учётные записи" autoFocus /></div>
        <TableEditor value={table} onChange={setTable} />
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary">{ds ? "Сохранить" : "Создать"}</button>
        </div>
      </form>
    </Modal>
  );
}
