import { useState, type FormEvent } from "react";
import { api, paths } from "../api";
import { folderPath, folderTree, withSubfolders } from "../selectors";
import { useCanEdit, useData, useStore } from "../store";
import type { CaseFolder, TestCase } from "../types";
import { Confirm, Modal } from "../ui";

// Что выбрано в дереве: все кейсы, кейсы без папки или папка (вместе с подпапками)
export type FolderSel = "all" | "none" | number;

export function inFolder(data: ReturnType<typeof useData>, sel: FolderSel) {
  if (sel === "all") return () => true;
  if (sel === "none") return (c: TestCase) => c.folder === null;
  const ids = withSubfolders(data, sel);
  return (c: TestCase) => c.folder !== null && ids.has(c.folder);
}

// Варианты для <select>: корень и папки с отступом по глубине. exclude — папка, которую переносят (вместе с подпапками)
export function FolderOptions({ pid, exclude, rootLabel = "Без папки" }: { pid: string; exclude?: number; rootLabel?: string }) {
  const data = useData();
  const skip = exclude !== undefined ? withSubfolders(data, exclude) : new Set<number>();
  return (
    <>
      <option value="">{rootLabel}</option>
      {folderTree(data, pid).filter(({ f }) => !skip.has(f.id)).map(({ f, depth }) => (
        <option key={f.id} value={f.id}>{"   ".repeat(depth)}{f.name}</option>
      ))}
    </>
  );
}

export function FolderTree({ pid, cases, sel, onSelect }: { pid: string; cases: TestCase[]; sel: FolderSel; onSelect: (s: FolderSel) => void }) {
  const data = useData();
  const { write } = useStore();
  const canEdit = useCanEdit();
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ folder?: CaseFolder; parent: number | null } | null>(null);
  const [deleting, setDeleting] = useState<CaseFolder | null>(null);
  const tree = folderTree(data, pid);

  // сколько кейсов в папке вместе с подпапками
  const own = new Map<number, number>();
  for (const c of cases) if (c.folder !== null) own.set(c.folder, (own.get(c.folder) || 0) + 1);
  const total = new Map<number, number>();
  for (let i = tree.length - 1; i >= 0; i--) {
    const { f } = tree[i];
    const n = (own.get(f.id) || 0) + (total.get(f.id) || 0);
    total.set(f.id, n);
    if (f.parent !== null) total.set(f.parent, (total.get(f.parent) || 0) + n);
  }
  // свёрнутая папка прячет все вложенные
  const hidden = new Set<number>();
  for (const { f } of tree) if (f.parent !== null && (closed.has(f.parent) || hidden.has(f.parent))) hidden.add(f.id);
  const hasKids = new Set(tree.map(({ f }) => f.parent));
  const toggle = (id: number) => {
    const s = new Set(closed);
    s.has(id) ? s.delete(id) : s.add(id);
    setClosed(s);
  };

  return (
    <nav className="ftree" aria-label="Папки тест-кейсов">
      <div className="ft-head">
        <span className="label">Папки</span>
        {canEdit && <button className="btn ghost sm" onClick={() => setEditing({ parent: typeof sel === "number" ? sel : null })} title={typeof sel === "number" ? "Новая подпапка в выбранной папке" : "Новая папка"}>+ Папка</button>}
      </div>
      <button className="ft-row" aria-current={sel === "all"} onClick={() => onSelect("all")}><span className="ft-name">Все кейсы</span><span className="n">{cases.length}</span></button>
      {tree.map(({ f, depth }) => hidden.has(f.id) ? null : (
        <div key={f.id} className="ft-row" aria-current={sel === f.id} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(f.id)}>
          <button className="ft-tw" onClick={(e) => { e.stopPropagation(); toggle(f.id); }} aria-label={closed.has(f.id) ? "Развернуть" : "Свернуть"} style={{ visibility: hasKids.has(f.id) ? "visible" : "hidden" }}>
            {closed.has(f.id) ? "▸" : "▾"}
          </button>
          <span className="ft-name" title={f.name}>{f.name}</span>
          {canEdit && (
            <span className="ft-acts" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setEditing({ folder: f, parent: f.parent })} aria-label={`Изменить папку ${f.name}`} title="Переименовать или перенести">✎</button>
              <button onClick={() => setDeleting(f)} aria-label={`Удалить папку ${f.name}`} title="Удалить папку">✕</button>
            </span>
          )}
          <span className="n">{total.get(f.id) || 0}</span>
        </div>
      ))}
      {tree.length > 0 && (
        <button className="ft-row" aria-current={sel === "none"} onClick={() => onSelect("none")}><span className="ft-name muted">Без папки</span><span className="n">{cases.filter((c) => c.folder === null).length}</span></button>
      )}
      {!tree.length && canEdit && <p className="muted small" style={{ margin: "4px 8px" }}>Разложите кейсы по папкам, например «Оплата», «Профиль».</p>}

      {editing && <FolderModal pid={pid} folder={editing.folder} parent={editing.parent} onClose={() => setEditing(null)} onCreated={onSelect} />}
      {deleting && (
        <Confirm
          title={`Удалить папку «${deleting.name}»?`}
          text={`Кейсы и подпапки не удалятся, а переедут ${deleting.parent === null ? "в корень проекта" : `в «${folderPath(data, deleting.parent)}»`}.`}
          onClose={() => setDeleting(null)}
          onYes={async () => {
            const f = deleting;
            setDeleting(null);
            if (await write(() => api("DELETE", paths.folder(pid, f.id), {}), "Папка удалена") && sel === f.id) onSelect(f.parent ?? "all");
          }}
        />
      )}
    </nav>
  );
}

function FolderModal({ pid, folder, parent, onClose, onCreated }: { pid: string; folder?: CaseFolder; parent: number | null; onClose: () => void; onCreated: (id: number) => void }) {
  const { write, toast } = useStore();
  const [name, setName] = useState(folder?.name || "");
  const [to, setTo] = useState(parent === null ? "" : String(parent));
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErr("Укажите название папки");
    const body = { name, parent: to ? Number(to) : null };
    if (folder) {
      if (await write(() => api("PATCH", paths.folder(pid, folder.id), body), "Папка сохранена")) onClose();
      return;
    }
    let id = 0;
    if (await write(async () => { id = (await api<{ id: number }>("POST", paths.folders(pid), body)).id; })) {
      toast(`Папка «${name.trim()}» создана`);
      onClose();
      onCreated(id);
    }
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>{folder ? "Папка" : "Новая папка"}</h2>
        <div className="field"><label htmlFor="f-name">Название *</label>
          <input className="input" id="f-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Оплата" autoFocus /></div>
        <div className="field"><label htmlFor="f-parent">Внутри папки</label>
          <select className="input" id="f-parent" value={to} onChange={(e) => setTo(e.target.value)}>
            <FolderOptions pid={pid} exclude={folder?.id} rootLabel="— в корне проекта —" />
          </select></div>
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">{folder ? "Сохранить" : "Создать"}</button>
        </div>
      </form>
    </Modal>
  );
}
