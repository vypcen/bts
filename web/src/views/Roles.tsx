// Роли и разрешения (администратор): встроенные роли — для справки, свои — создать, изменить, удалить.
// Лицензия: роль только с просмотровыми разрешениями (комментарии, статусы багов, помощник) занимает просмотровое место
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Modal, Pill } from "../ui";

interface Perm { key: string; group: string; label: string }
interface RoleRow { key: string; name: string; description: string; permissions: string[]; seat: "full" | "view"; builtin: boolean; users: number }
interface RolesData { permissions: Perm[]; viewPermissions: string[]; roles: RoleRow[] }

export function RolesAdmin() {
  const [d, setD] = useState<RolesData | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<RoleRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);
  const load = () => api<RolesData>("GET", "/api/admin/roles").then(setD, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  if (error) return <div className="banner">{error}</div>;
  if (!d) return <div className="skel">Загружаем роли…</div>;
  const groups = [...new Set(d.permissions.map((p) => p.group))];
  return (
    <section>
      <div className="head">
        <div>
          <h1>Роли</h1>
          <p className="muted" style={{ maxWidth: 760 }}>
            Роль — набор разрешений. Встроенные роли изменить нельзя; свои роли (например, «Тест-менеджер» или «Автоматизатор») выдаются
            так же, как встроенные: глобально или в конкретном проекте. Просматривать проект может любой его участник.
          </p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEditing("new")}>+ Роль</button>
      </div>
      <div className="tbl-wrap card" style={{ padding: 0 }}>
        <table className="tbl roles-matrix">
          <thead>
            <tr>
              <th>Разрешение</th>
              {d.roles.map((r) => (
                <th key={r.key} className="role-col">
                  {r.builtin ? r.name : <button className="btn ghost sm" onClick={() => setEditing(r)} title="Изменить роль">{r.name} ✎</button>}
                  <div className="small muted" style={{ fontWeight: 400 }}>{r.seat === "full" ? "полная" : "просмотровая"} · {r.users} польз.</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => [
              <tr key={g} className="group-row"><td colSpan={d.roles.length + 1}><b>{g}</b></td></tr>,
              ...d.permissions.filter((p) => p.group === g).map((p) => (
                <tr key={p.key}>
                  <td className="small">{p.label}</td>
                  {d.roles.map((r) => (
                    <td key={r.key} className="role-col" aria-label={`${r.name}: ${r.permissions.includes(p.key) ? "да" : "нет"}`}>
                      {r.permissions.includes(p.key) ? <span className="c-ok">✓</span> : <span className="muted">—</span>}
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Полное место в лицензии занимает роль, в которой есть хоть одно разрешение, кроме: {d.permissions.filter((p) => d.viewPermissions.includes(p.key)).map((p) => p.label.toLowerCase()).join(", ")}.
      </p>
      {editing && <RoleEditor data={d} role={editing === "new" ? null : editing} onDelete={(r) => { setEditing(null); setDeleting(r); }} onClose={() => { setEditing(null); load(); }} />}
      {deleting && <RoleDelete data={d} role={deleting} onClose={() => { setDeleting(null); load(); }} />}
    </section>
  );
}

function RoleEditor({ data, role, onClose, onDelete }: { data: RolesData; role: RoleRow | null; onClose: () => void; onDelete: (r: RoleRow) => void }) {
  const { write } = useStore();
  const [f, setF] = useState({ name: role?.name || "", description: role?.description || "", permissions: new Set(role?.permissions || ["comments"]) });
  const toggle = (k: string) => {
    const next = new Set(f.permissions);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setF({ ...f, permissions: next });
  };
  const full = [...f.permissions].some((p) => !data.viewPermissions.includes(p));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = { name: f.name.trim(), description: f.description.trim(), permissions: [...f.permissions] };
    const ok = await write(
      () => (role ? api("PATCH", `/api/admin/roles/${role.key}`, body) : api("POST", "/api/admin/roles", body)),
      role ? `Роль «${body.name}» сохранена` : `Роль «${body.name}» создана — выдайте её в «Пользователях»`
    );
    if (ok) onClose();
  }
  const groups = [...new Set(data.permissions.map((p) => p.group))];
  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={submit} id="roleForm">
        <h2>{role ? `Роль «${role.name}»` : "Новая роль"}</h2>
        <div className="row2">
          <div className="field"><label htmlFor="ro-name">Название *</label>
            <input id="ro-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Тест-менеджер" autoFocus maxLength={60} /></div>
          <div className="field"><label htmlFor="ro-desc">Описание</label>
            <input id="ro-desc" className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Планирует регресс, не правит кейсы" maxLength={300} /></div>
        </div>
        <div className="perm-groups">
          {groups.map((g) => (
            <fieldset key={g} className="perm-group">
              <legend>{g}</legend>
              {data.permissions.filter((p) => p.group === g).map((p) => (
                <label key={p.key} className="small" style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <input type="checkbox" checked={f.permissions.has(p.key)} onChange={() => toggle(p.key)} />
                  <span>{p.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <p className="small" style={{ margin: 0 }}>
          Лицензия: <Pill tone={full ? "info" : "neutral"} label={full ? "полное место" : "просмотровое место"} sm />
          {role && role.users > 0 && <span className="muted"> · роль выдана: {role.users}</span>}
        </p>
        <div className="acts">
          {role && <button type="button" className="btn danger" onClick={() => onDelete(role)} style={{ marginRight: "auto" }}>Удалить роль</button>}
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary" disabled={f.name.trim().length < 2}>{role ? "Сохранить" : "Создать"}</button>
        </div>
      </form>
    </Modal>
  );
}

function RoleDelete({ data, role, onClose }: { data: RolesData; role: RoleRow; onClose: () => void }) {
  const { write } = useStore();
  const [replace, setReplace] = useState("viewer");
  const others = data.roles.filter((r) => r.key !== role.key && r.key !== "admin");
  return (
    <Modal onClose={onClose}>
      <h2>Удалить роль «{role.name}»?</h2>
      {role.users > 0 ? (
        <div className="field">
          <label htmlFor="rd-repl">Роль выдана ({role.users}). Что выдать вместо неё?</label>
          <select id="rd-repl" className="input" value={replace} onChange={(e) => setReplace(e.target.value)}>
            {others.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </div>
      ) : <p className="muted">Роль никому не выдана.</p>}
      <div className="acts">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn danger solid" onClick={async () => {
          if (await write(() => api("DELETE", `/api/admin/roles/${role.key}`, role.users ? { replaceWith: replace } : {}), `Роль «${role.name}» удалена`)) onClose();
        }}>Удалить</button>
      </div>
    </Modal>
  );
}
