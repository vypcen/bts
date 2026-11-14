// Настройка пользовательских полей проекта: для тест-кейсов, багов и прогонов
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useData, useStore } from "../store";
import type { CustomField, FieldType } from "../types";
import { Confirm, Modal } from "../ui";

const TYPE_LABEL: Record<FieldType, string> = {
  text: "Строка", textarea: "Текст", number: "Число", date: "Дата", select: "Список", multiselect: "Несколько из списка",
  user: "Пользователь", url: "Ссылка", checkbox: "Флажок",
};
const ENTITY_LABEL = { case: "Тест-кейсы", bug: "Баги", run: "Прогоны" };

export function FieldsSettings({ pid }: { pid: string }) {
  const data = useData();
  const { write } = useStore();
  const [editing, setEditing] = useState<Partial<CustomField> | null>(null);
  const [deleting, setDeleting] = useState<CustomField | null>(null);
  const url = `/api/projects/${encodeURIComponent(pid)}/fields`;
  const move = (f: CustomField, d: number) => {
    const list = data.customFields.filter((x) => x.entity === f.entity);
    const i = list.findIndex((x) => x.id === f.id);
    const other = list[i + d];
    if (!other) return;
    write(async () => {
      await api("PATCH", `${url}/${f.id}`, { position: other.position });
      await api("PATCH", `${url}/${other.id}`, { position: f.position === other.position ? f.position + d : f.position });
    });
  };
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="head" style={{ marginBottom: 0 }}>
        <div>
          <h2 style={{ fontSize: 18 }}>Пользовательские поля</h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>Свои поля для кейсов, багов и прогонов: компонент, ссылка на задачу, платформа. По полям-спискам можно фильтровать.</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEditing({ entity: "case", type: "select", options: [], required: false })}>+ Поле</button>
      </div>
      {(["case", "bug", "run"] as const).map((entity) => {
        const list = data.customFields.filter((f) => f.entity === entity);
        if (!list.length) return null;
        return (
          <div key={entity} className="card">
            <span className="label">{ENTITY_LABEL[entity]}</span>
            <table className="tbl">
              <tbody>
                {list.map((f, i) => (
                  <tr key={f.id}>
                    <td>{f.name}{f.required && <span className="muted"> · обязательное</span>}</td>
                    <td className="small muted">{TYPE_LABEL[f.type]}{f.options.length ? `: ${f.options.join(", ")}` : ""}</td>
                    <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                      <button className="btn ghost sm" disabled={i === 0} onClick={() => move(f, -1)} aria-label={`${f.name} выше`}>↑</button>
                      <button className="btn ghost sm" disabled={i === list.length - 1} onClick={() => move(f, 1)} aria-label={`${f.name} ниже`}>↓</button>
                      <button className="btn sm" onClick={() => setEditing(f)}>Изменить</button>{" "}
                      <button className="btn sm danger" onClick={() => setDeleting(f)}>Удалить</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {!data.customFields.length && <span className="muted small">Полей пока нет.</span>}
      {editing && <FieldModal url={url} field={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <Confirm title={`Удалить поле «${deleting.name}»?`} text="Поле пропадёт из форм и фильтров. Значения в уже сохранённых записях перестанут показываться."
          onClose={() => setDeleting(null)}
          onYes={async () => {
            await write(() => api("DELETE", `${url}/${deleting.id}`, {}), "Поле удалено");
            setDeleting(null);
          }} />
      )}
    </section>
  );
}

function FieldModal({ url, field, onClose }: { url: string; field: Partial<CustomField>; onClose: () => void }) {
  const { write } = useStore();
  const isNew = field.id === undefined;
  const [f, setF] = useState({
    entity: field.entity || "case", name: field.name || "", type: field.type || "select",
    options: (field.options || []).join("\n"), required: Boolean(field.required),
  });
  const [err, setErr] = useState("");
  const needsOptions = f.type === "select" || f.type === "multiselect";
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.name.trim()) return setErr("Укажите название поля");
    const options = f.options.split("\n").map((x) => x.trim()).filter(Boolean);
    if (needsOptions && !options.length) return setErr("Добавьте варианты, по одному в строке");
    const body = { name: f.name, required: f.required, options, ...(isNew ? { entity: f.entity, type: f.type } : {}) };
    if (await write(() => api(isNew ? "POST" : "PATCH", isNew ? url : `${url}/${field.id}`, body), isNew ? "Поле добавлено" : "Поле сохранено")) onClose();
  }
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>{isNew ? "Новое поле" : `Поле «${field.name}»`}</h2>
        <div className="row2">
          <div className="field"><label htmlFor="cf-entity">Для</label>
            <select className="input" id="cf-entity" value={f.entity} disabled={!isNew} onChange={(e) => setF({ ...f, entity: e.target.value as CustomField["entity"] })}>
              {Object.entries(ENTITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          <div className="field"><label htmlFor="cf-type">Тип</label>
            <select className="input" id="cf-type" value={f.type} disabled={!isNew} onChange={(e) => setF({ ...f, type: e.target.value as FieldType })}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
        </div>
        <div className="field"><label htmlFor="cf-name">Название *</label><input className="input" id="cf-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Например: Компонент" autoFocus /></div>
        {needsOptions && (
          <div className="field"><label htmlFor="cf-opts">Варианты</label>
            <textarea className="input" id="cf-opts" rows={5} value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} placeholder={"По одному в строке, например:\nОплата\nДоставка\nПрофиль"} /></div>
        )}
        <label className="check"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> Обязательное</label>
        {!isNew && <span className="muted small">Тип и раздел поля не меняются: уже сохранённые значения стали бы неверными.</span>}
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">{isNew ? "Добавить" : "Сохранить"}</button>
        </div>
      </form>
    </Modal>
  );
}
