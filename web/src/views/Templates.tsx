// Шаблоны тест-кейсов и багов: выбор в форме создания, сохранение текущей формы как шаблона,
// управление во вкладке проекта «Настройки». Шаблон заполняет только пустые поля формы:
// например, у бага из упавшего кейса шаги из кейса не затрутся
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useCan, useLoad, useStore } from "../store";
import type { FieldValues } from "../types";
import { Confirm, Modal } from "../ui";

export type TemplateKind = "case" | "bug";
export interface Template { id: number; kind: TemplateKind; name: string; data: Record<string, any>; isDefault: boolean; createdBy: string | null; updated: number }

const url = (pid: string) => `/api/projects/${encodeURIComponent(pid)}/templates`;

export function useTemplates(pid: string, kind: TemplateKind): Template[] {
  const { value } = useLoad<{ templates: Template[] }>(`${url(pid)}?kind=${kind}`);
  return value?.templates || [];
}

// пустое поле: нет значения, пустая строка, пустой список или шаги без текста
const blank = (v: unknown) =>
  v === undefined || v === null || v === "" ||
  (Array.isArray(v) && v.every((s: any) => s && typeof s === "object" && !String(s.action || "").trim() && !String(s.expected || "").trim()));

// Заполнить пустые поля формы значениями шаблона; теги объединяются, пользовательские поля — только незаполненные
export function applyTemplate<T extends Record<string, any>>(form: T, t: Template, defaults: Partial<T> = {}): T {
  const out: Record<string, any> = { ...form };
  for (const [k, v] of Object.entries(t.data)) {
    if (k === "tags") out.tags = [...new Set([...(form.tags || []), ...(v as string[])])];
    else if (k === "fields") out.fields = { ...(v as FieldValues), ...(form.fields || {}) };
    else if (blank(form[k]) || (k in defaults && form[k] === (defaults as any)[k])) out[k] = v;
  }
  return out as T;
}

// Выбор шаблона в форме создания. Шаблон по умолчанию применяется сам один раз
export function TemplatePicker<T extends Record<string, any>>({ pid, kind, form, setForm, defaults }: {
  pid: string; kind: TemplateKind; form: T; setForm: (f: T) => void; defaults?: Partial<T>;
}) {
  const list = useTemplates(pid, kind);
  const [picked, setPicked] = useState("");
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || !list.length) return;
    auto.current = true;
    const def = list.find((t) => t.isDefault);
    if (def) {
      setForm(applyTemplate(form, def, defaults));
      setPicked(String(def.id));
    }
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.length) return null;
  return (
    <div className="field">
      <label htmlFor={`tpl-${kind}`}>Шаблон</label>
      <select id={`tpl-${kind}`} className="input" value={picked} onChange={(e) => {
        setPicked(e.target.value);
        const t = list.find((x) => String(x.id) === e.target.value);
        if (t) setForm(applyTemplate(form, t, defaults));
      }}>
        <option value="">— без шаблона —</option>
        {list.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (по умолчанию)" : ""}</option>)}
      </select>
      <span className="muted" style={{ fontSize: 12 }}>Шаблон заполняет пустые поля; уже введённое не меняется</span>
    </div>
  );
}

// «Сохранить как шаблон» — текущее заполнение формы (без названия кейса или бага)
export function SaveAsTemplate({ pid, kind, data }: { pid: string; kind: TemplateKind; data: Record<string, any> }) {
  const canCases = useCan("cases.edit");
  const canSettings = useCan("settings");
  const can = canCases || canSettings;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isDefault, setDefault] = useState(false);
  const { write } = useStore();
  if (!can) return null;
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)} title="Сохранить заполненные поля как заготовку для новых">Сохранить как шаблон</button>
      {open && (
        <Modal onClose={() => setOpen(false)}>
          <h2>Новый шаблон {kind === "case" ? "тест-кейса" : "бага"}</h2>
          <p className="muted small" style={{ marginTop: 0 }}>В шаблон попадут заполненные поля формы, кроме названия.</p>
          <div className="field"><label htmlFor="tpl-name">Название шаблона</label>
            <input id="tpl-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "case" ? "API-проверка" : "Баг вёрстки"} autoFocus /></div>
          <label className="small" style={{ display: "flex", gap: 6 }}>
            <input type="checkbox" checked={isDefault} onChange={(e) => setDefault(e.target.checked)} /> Подставлять в новые {kind === "case" ? "тест-кейсы" : "баги"} автоматически
          </label>
          <div className="acts">
            <button className="btn" onClick={() => setOpen(false)}>Отмена</button>
            <button className="btn primary" disabled={!name.trim()} onClick={async () => {
              if (await write(() => api("POST", url(pid), { kind, name: name.trim(), data, isDefault }), `Шаблон «${name.trim()}» сохранён`)) setOpen(false);
            }}>Сохранить</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// Управление шаблонами (вкладка «Настройки»)
export function TemplatesSettings({ pid }: { pid: string }) {
  const { write } = useStore();
  const cases = useTemplates(pid, "case");
  const bugs = useTemplates(pid, "bug");
  const [renaming, setRenaming] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Template | null>(null);
  const describe = (t: Template) => {
    const d = t.data;
    const parts: string[] = [];
    if (d.stepList?.length) parts.push(`шагов: ${d.stepList.length}`);
    if (d.steps) parts.push(t.kind === "bug" ? "шаги воспроизведения" : "пункты");
    if (d.pre) parts.push("предусловия");
    if (d.expected) parts.push("ожидаемый результат");
    if (d.env) parts.push("окружение");
    if (d.priority) parts.push("приоритет");
    if (d.severity) parts.push("серьёзность");
    if (d.tags?.length) parts.push(`теги: ${d.tags.join(", ")}`);
    if (d.fields && Object.keys(d.fields).length) parts.push(`полей: ${Object.keys(d.fields).length}`);
    return parts.join(" · ") || "пустой";
  };
  const block = (title: string, list: Template[]) => (
    <div className="view-block">
      <span className="label">{title}</span>
      {!list.length ? <span className="muted small">Пока нет. Заполните форму нового {title === "Тест-кейсы" ? "кейса" : "бага"} и нажмите «Сохранить как шаблон».</span> : (
        <table className="tbl">
          <tbody>
            {list.map((t) => (
              <tr key={t.id}>
                <td><b>{t.name}</b>{t.isDefault && <span className="tag" style={{ marginLeft: 6 }}>по умолчанию</span>}<div className="small muted">{describe(t)}</div></td>
                <td className="actions" style={{ whiteSpace: "nowrap" }}>
                  <button className="btn ghost sm" onClick={() => write(() => api("PATCH", `${url(pid)}/${t.id}`, { isDefault: !t.isDefault }), t.isDefault ? "Шаблон больше не подставляется сам" : "Шаблон будет подставляться в новые")}>
                    {t.isDefault ? "Не по умолчанию" : "По умолчанию"}
                  </button>
                  <button className="btn ghost sm" onClick={() => { setRenaming(t); setName(t.name); }}>Переименовать</button>
                  <button className="btn ghost sm" style={{ color: "var(--crit)" }} onClick={() => setDeleting(t)} aria-label={`Удалить шаблон ${t.name}`}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Шаблоны</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Заготовки для новых тест-кейсов и багов: выбираются в форме создания и заполняют пустые поля.</p>
      {block("Тест-кейсы", cases)}
      {block("Баги", bugs)}
      {renaming && (
        <Modal onClose={() => setRenaming(null)}>
          <h2>Переименовать шаблон</h2>
          <div className="field"><label htmlFor="tpl-rn">Название</label><input id="tpl-rn" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="acts">
            <button className="btn" onClick={() => setRenaming(null)}>Отмена</button>
            <button className="btn primary" disabled={!name.trim()} onClick={async () => { if (await write(() => api("PATCH", `${url(pid)}/${renaming.id}`, { name: name.trim() }), "Шаблон переименован")) setRenaming(null); }}>Сохранить</button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Confirm title={`Удалить шаблон «${deleting.name}»?`} text="Созданные по нему кейсы и баги не изменятся." action="Удалить"
          onClose={() => setDeleting(null)} onYes={async () => { const t = deleting; setDeleting(null); await write(() => api("DELETE", `${url(pid)}/${t.id}`, {}), "Шаблон удалён"); }} />
      )}
    </section>
  );
}
