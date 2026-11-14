// Общие части модели кейса и бага: структурные шаги, теги, пользовательские поля
import { useState, type KeyboardEvent } from "react";
import { useData } from "./store";
import type { CustomField, FieldValue, FieldValues, Step } from "./types";
import { useNames } from "./ui";

// ---------- шаги ----------
export const emptyStep = (): Step => ({ action: "", expected: "", data: "" });
// Шаги для формы: из структуры, а если её нет (старые данные) — из текста по строкам
export const stepsOf = (c: { stepList?: Step[]; steps?: string }): Step[] =>
  c.stepList?.length ? c.stepList : (c.steps || "").split("\n").filter((l) => l.trim()).map((action) => ({ ...emptyStep(), action }));

export function StepsEditor({ value, onChange }: { value: Step[]; onChange: (v: Step[]) => void }) {
  const rows = value.length ? value : [emptyStep()];
  const set = (i: number, k: keyof Step, v: string) => onChange(rows.map((s, n) => (n === i ? { ...s, [k]: v } : s)));
  const move = (i: number, d: number) => {
    const next = [...rows];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  // Enter в последнем поле действия добавляет шаг; Ctrl+Enter оставляем форме
  const onKey = (i: number) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && i === rows.length - 1 && rows[i].action.trim()) {
      e.preventDefault();
      onChange([...rows, emptyStep()]);
    }
  };
  return (
    <div className="steps-editor">
      {rows.map((s, i) => (
        <div className="step-row" key={i}>
          <span className="step-n">{i + 1}</span>
          <div className="step-cells">
            <textarea className="input" rows={1} aria-label={`Шаг ${i + 1}: действие`} placeholder="Действие" value={s.action}
              onChange={(e) => set(i, "action", e.target.value)} onKeyDown={onKey(i)} />
            <textarea className="input" rows={1} aria-label={`Шаг ${i + 1}: ожидаемый результат`} placeholder="Ожидаемый результат шага" value={s.expected}
              onChange={(e) => set(i, "expected", e.target.value)} />
            <input className="input small" aria-label={`Шаг ${i + 1}: тестовые данные`} placeholder="Тестовые данные (необязательно)" value={s.data}
              onChange={(e) => set(i, "data", e.target.value)} />
          </div>
          <div className="step-acts">
            <button type="button" className="btn ghost sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Шаг ${i + 1} выше`}>↑</button>
            <button type="button" className="btn ghost sm" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label={`Шаг ${i + 1} ниже`}>↓</button>
            <button type="button" className="btn ghost sm" onClick={() => onChange(rows.filter((_, n) => n !== i))} aria-label={`Удалить шаг ${i + 1}`}>✕</button>
          </div>
        </div>
      ))}
      <button type="button" className="btn sm" onClick={() => onChange([...rows, emptyStep()])}>+ Шаг</button>
    </div>
  );
}

// Шаги для чтения: номер, действие, данные, ожидаемый результат шага
export function StepsView({ steps, render }: { steps: Step[]; render?: (s: Step, i: number) => React.ReactNode }) {
  if (!steps.length) return <span className="muted">Не указаны</span>;
  return (
    <ol className="steps-view">
      {steps.map((s, i) => (
        <li key={i}>
          <div className="step-main">
            <div>{s.action}</div>
            {s.data && <div className="small"><span className="muted">Данные:</span> <span className="mono">{s.data}</span></div>}
            {s.expected && <div className="small"><span className="muted">Ожидается:</span> {s.expected}</div>}
          </div>
          {render?.(s, i)}
        </li>
      ))}
    </ol>
  );
}

// ---------- теги ----------
export function Tags({ tags, onClick }: { tags?: string[]; onClick?: (t: string) => void }) {
  if (!tags?.length) return null;
  return (
    <span className="tags">
      {tags.map((t) => (onClick ? <button key={t} type="button" className="tag" onClick={() => onClick(t)}>{t}</button> : <span key={t} className="tag">{t}</span>))}
    </span>
  );
}

export function TagInput({ value, onChange, suggestions = [], id }: { value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; id?: string }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const t = raw.trim().replace(/,$/, "").trim();
    if (t && !value.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...value, t].slice(0, 20));
    setText("");
  };
  const listId = id ? `${id}-list` : undefined;
  return (
    <div className="tag-input">
      {value.map((t) => (
        <span key={t} className="tag">{t}<button type="button" aria-label={`Убрать тег ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>×</button></span>
      ))}
      <input id={id} list={listId} className="input" placeholder={value.length ? "" : "Например: smoke, оплата"} value={text}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text.trim() && add(text)} />
      {listId && <datalist id={listId}>{suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>}
    </div>
  );
}

// Все теги проекта для подсказок и фильтра
export function useProjectTags(kind: "cases" | "bugs"): string[] {
  const data = useData();
  const set = new Set<string>();
  for (const x of kind === "cases" ? data.cases : data.bugs) for (const t of x.tags || []) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, "ru"));
}

// ---------- пользовательские поля ----------
export function useFields(entity: CustomField["entity"]): CustomField[] {
  return useData().customFields.filter((f) => f.entity === entity);
}

// Ошибка, если не заполнено обязательное поле (сервер проверит тоже)
export function missingRequired(defs: CustomField[], values: FieldValues): string {
  const miss = defs.find((d) => d.required && d.type !== "checkbox" && (values[d.id] === undefined || values[d.id] === "" || (Array.isArray(values[d.id]) && !(values[d.id] as string[]).length)));
  return miss ? `Заполните поле «${miss.name}»` : "";
}

export function FieldsEditor({ entity, values, onChange }: { entity: CustomField["entity"]; values: FieldValues; onChange: (v: FieldValues) => void }) {
  const defs = useFields(entity);
  const data = useData();
  const nameOf = useNames();
  if (!defs.length) return null;
  const set = (id: number, v: FieldValue | null) => {
    const next = { ...values };
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) delete next[id];
    else next[id] = v;
    onChange(next);
  };
  const people = Object.keys(data.users);
  return (
    <div className="fields-grid">
      {defs.map((d) => {
        const id = `cf-${d.id}`;
        const v = values[d.id];
        const label = <label htmlFor={id}>{d.name}{d.required ? " *" : ""}</label>;
        switch (d.type) {
          case "textarea":
            return <div className="field" key={d.id} style={{ gridColumn: "1 / -1" }}>{label}<textarea className="input" id={id} rows={3} value={String(v ?? "")} onChange={(e) => set(d.id, e.target.value)} /></div>;
          case "number":
            return <div className="field" key={d.id}>{label}<input className="input" id={id} type="number" value={v === undefined ? "" : String(v)} onChange={(e) => set(d.id, e.target.value === "" ? null : Number(e.target.value))} /></div>;
          case "date":
            return <div className="field" key={d.id}>{label}<input className="input" id={id} type="date" value={String(v ?? "")} onChange={(e) => set(d.id, e.target.value)} /></div>;
          case "checkbox":
            return <div className="field" key={d.id}><label className="check"><input type="checkbox" id={id} checked={v === true} onChange={(e) => set(d.id, e.target.checked || null)} /> {d.name}</label></div>;
          case "select":
            return (
              <div className="field" key={d.id}>{label}
                <select className="input" id={id} value={String(v ?? "")} onChange={(e) => set(d.id, e.target.value)}>
                  <option value="">—</option>
                  {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            );
          case "multiselect": {
            const cur = Array.isArray(v) ? v : [];
            return (
              <div className="field" key={d.id}><span className="label-like">{d.name}{d.required ? " *" : ""}</span>
                <div className="multi">
                  {d.options.map((o) => (
                    <label key={o} className="check"><input type="checkbox" checked={cur.includes(o)}
                      onChange={(e) => set(d.id, e.target.checked ? [...cur, o] : cur.filter((x) => x !== o))} /> {o}</label>
                  ))}
                </div>
              </div>
            );
          }
          case "user":
            return (
              <div className="field" key={d.id}>{label}
                <select className="input" id={id} value={String(v ?? "")} onChange={(e) => set(d.id, e.target.value)}>
                  <option value="">—</option>
                  {people.map((login) => <option key={login} value={login}>{nameOf(login)}</option>)}
                </select>
              </div>
            );
          default:
            return <div className="field" key={d.id}>{label}<input className="input" id={id} type={d.type === "url" ? "url" : "text"} value={String(v ?? "")} onChange={(e) => set(d.id, e.target.value)} /></div>;
        }
      })}
    </div>
  );
}

export function fieldText(d: CustomField, v: FieldValue | undefined, nameOf: (l: string) => string): string {
  if (v === undefined || v === "") return "";
  if (d.type === "checkbox") return v ? "Да" : "Нет";
  if (Array.isArray(v)) return v.join(", ");
  if (d.type === "user") return nameOf(String(v));
  if (d.type === "date") return new Date(String(v)).toLocaleDateString("ru-RU");
  return String(v);
}

export function FieldsView({ entity, values }: { entity: CustomField["entity"]; values?: FieldValues }) {
  const defs = useFields(entity);
  const nameOf = useNames();
  const shown = defs.filter((d) => values && values[d.id] !== undefined && values[d.id] !== "");
  if (!shown.length) return null;
  return (
    <div className="fields-grid">
      {shown.map((d) => {
        const v = values![d.id];
        return (
          <div className="view-block" key={d.id}>
            <span className="label">{d.name}</span>
            {d.type === "url" ? <a href={String(v)} target="_blank" rel="noreferrer noopener">{String(v)}</a> : <span>{fieldText(d, v, nameOf)}</span>}
          </div>
        );
      })}
    </div>
  );
}
