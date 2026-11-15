// Общие шаги проекта: список блоков, создание, правка, удаление (с копированием шагов в кейсы, если блок используется)
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { emptyStep, StepsEditor, StepsView, useSharedSteps } from "../casekit";
import { useCan, useStore } from "../store";
import type { SharedStep, Step } from "../types";
import { Confirm, fmt, Modal } from "../ui";

const url = (pid: string) => `/api/projects/${encodeURIComponent(pid)}/shared-steps`;

export function SharedStepsModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const list = useSharedSteps(pid);
  const canEdit = useCan("cases.edit");
  const [editing, setEditing] = useState<SharedStep | "new" | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<SharedStep | null>(null);
  const { write } = useStore();
  if (editing) return <SharedEditor pid={pid} block={editing === "new" ? null : editing} onClose={() => setEditing(null)} />;
  return (
    <Modal onClose={onClose} wide>
      <h2>Общие шаги</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Блок шагов, который повторяется в разных кейсах («Вход как администратор», «Оформить заказ»). В кейс он вставляется кнопкой «+ Общие шаги…»
        в редакторе шагов; изменение блока сразу видно во всех кейсах.
      </p>
      {!list.length ? <p className="muted">Блоков пока нет.</p> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Блок</th><th>Шагов</th><th>В кейсах</th><th>Изменён</th><th /></tr></thead>
            <tbody>
              {list.map((b) => [
                <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setOpen(open === b.id ? null : b.id)}>
                  <td><b>{b.title}</b></td>
                  <td>{b.stepList.length}</td>
                  <td>{b.usedIn || <span className="muted">—</span>}</td>
                  <td className="small muted">{fmt(b.updated)}{b.updatedBy ? ` · ${b.updatedBy}` : ""}</td>
                  <td className="actions" onClick={(e) => e.stopPropagation()}>
                    {canEdit && <button className="btn ghost sm" onClick={() => setEditing(b)}>Изменить</button>}
                    {canEdit && <button className="btn ghost sm" style={{ color: "var(--crit)" }} onClick={() => setDeleting(b)} aria-label={`Удалить блок ${b.title}`}>✕</button>}
                  </td>
                </tr>,
                open === b.id && (
                  <tr key={`${b.id}-steps`}><td colSpan={5}><StepsView steps={b.stepList} /></td></tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
      )}
      <div className="acts">
        {canEdit && <button className="btn primary" onClick={() => setEditing("new")} style={{ marginRight: "auto" }}>+ Блок</button>}
        <button className="btn" onClick={onClose}>Закрыть</button>
      </div>
      {deleting && (
        <Confirm
          title={`Удалить блок «${deleting.title}»?`}
          text={deleting.usedIn ? `Блок используется в кейсах (${deleting.usedIn}). В них вместо ссылки останутся копии его шагов.` : "Блок не используется ни в одном кейсе."}
          action="Удалить"
          onClose={() => setDeleting(null)}
          onYes={async () => { const b = deleting; setDeleting(null); await write(() => api("DELETE", `${url(pid)}/${b.num}`, { inline: true }), `Блок «${b.title}» удалён`); }}
        />
      )}
    </Modal>
  );
}

function SharedEditor({ pid, block, onClose }: { pid: string; block: SharedStep | null; onClose: () => void }) {
  const { write } = useStore();
  const [title, setTitle] = useState(block?.title || "");
  const [steps, setSteps] = useState<Step[]>(block?.stepList.length ? block.stepList : [emptyStep()]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = { title: title.trim(), stepList: steps.filter((s) => s.action.trim() || s.expected.trim()) };
    const ok = await write(() => (block ? api("PATCH", `${url(pid)}/${block.num}`, body) : api("POST", url(pid), body)),
      block ? `Блок «${body.title}» сохранён${block.usedIn ? ` — изменился в ${block.usedIn} кейсах` : ""}` : `Блок «${body.title}» создан`);
    if (ok) onClose();
  }
  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={submit} id="sharedForm">
        <h2>{block ? `Общие шаги: ${block.title}` : "Новый блок общих шагов"}</h2>
        {block?.usedIn ? <div className="banner" style={{ marginBottom: 8 }}>Блок используется в кейсах ({block.usedIn}) — изменения появятся во всех сразу.</div> : null}
        <div className="field"><label htmlFor="sh-title">Название *</label>
          <input id="sh-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Вход как администратор" autoFocus maxLength={300} /></div>
        <div className="field"><span className="label">Шаги</span><StepsEditor value={steps} onChange={setSteps} /></div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary" disabled={!title.trim()}>{block ? "Сохранить" : "Создать"}</button>
        </div>
      </form>
    </Modal>
  );
}

