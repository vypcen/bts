import { useState } from "react";
import { api } from "../api";
import { find, ROLES } from "../labels";
import { href } from "../router";
import { useData, useLoad, useStore } from "../store";
import type { Role } from "../types";
import { Avatar, Confirm, Empty, fmt, Modal, Pill } from "../ui";
import { NewUserModal, PasswordModal } from "./Password";

// Ответ GET /api/admin/users
interface AdminUser {
  login: string;
  name: string;
  role: Role;
  blocked: boolean;
  created: number;
  projects: string[];
}

const usersUrl = "/api/admin/users";
const userUrl = (login: string) => `${usersUrl}/${encodeURIComponent(login)}`;

// Раздел администратора: роли, блокировка, удаление и доступ к проектам
export function Users() {
  const { me, write, liveError } = useStore();
  const { value, error } = useLoad<{ users: AdminUser[] }>(usersUrl);
  const [q, setQ] = useState("");
  const [access, setAccess] = useState<AdminUser | null>(null);
  const [del, setDel] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const users = value?.users || [];
  const needle = q.trim().toLowerCase();
  const rows = users.filter((u) => !needle || u.login.includes(needle) || u.name.toLowerCase().includes(needle));
  const patch = (u: AdminUser, body: object, msg: string) => write(() => api("PATCH", userUrl(u.login), body), msg);

  if (me?.role !== "admin") {
    return (
      <main className="wrap">
        <div className="banner">Раздел доступен только администраторам.</div>
        <a href={href()}>← К проектам</a>
      </main>
    );
  }

  return (
    <main className="wrap">
      {liveError && <div className="banner">{liveError}</div>}
      <div className="head">
        <div>
          <h1>Пользователи</h1>
          <p className="muted">Роли, блокировка и доступ к проектам. Пользователь видит только проекты, в которые его добавили; администратор видит все.</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ Новый пользователь</button>
      </div>
      <div className="stats" style={{ flexWrap: "wrap" }}>
        {ROLES.map((r) => (
          <span key={r.key} className="small muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Pill tone={r.tone} label={r.label} sm /> {r.hint}
          </span>
        ))}
      </div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Поиск по имени или логину" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted small">{rows.length} из {users.length}</span>
      </div>
      {error && !value && <div className="banner">Не удалось загрузить пользователей: {error}</div>}
      {!value && !error ? (
        <div className="skel">Загружаем пользователей…</div>
      ) : !users.length ? (
        <Empty title="Пользователей нет" />
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Пользователь</th><th style={{ width: 170 }}>Роль</th><th>Проекты</th>
                <th style={{ width: 130 }}>Статус</th><th style={{ width: 300 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const self = u.login === me.login;
                return (
                  <tr key={u.login} style={u.blocked ? { opacity: 0.6 } : undefined}>
                    <td className="title">
                      <span className="who"><Avatar login={u.login} /><span>{u.name}</span></span>
                      <div className="muted small mono" style={{ fontWeight: 400 }}>@{u.login}{self && " · это вы"} · с {fmt(u.created)}</div>
                    </td>
                    <td>
                      <select className="input" aria-label={`Роль ${u.name}`} value={u.role} disabled={self}
                        title={self ? "Свою роль поменять нельзя: попросите другого администратора" : undefined}
                        onChange={(e) => patch(u, { role: e.target.value }, `${u.name}: ${find(ROLES, e.target.value as Role).label}`)}>
                        {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                      </select>
                    </td>
                    <td>
                      {u.role === "admin" ? (
                        <span className="muted small">Все проекты</span>
                      ) : (
                        <div className="chips" style={{ alignItems: "center" }}>
                          {u.projects.map((k) => <a key={k} className="chip" href={href("p", k)}>{k}</a>)}
                          {!u.projects.length && <span className="small" style={{ color: "var(--warn)" }}>Нет доступа ни к одному</span>}
                          <button className="btn ghost sm" onClick={() => setAccess(u)}>Изменить</button>
                        </div>
                      )}
                    </td>
                    <td>{u.blocked ? <Pill tone="crit" label="Заблокирован" sm /> : <Pill tone="ok" label="Активен" sm />}</td>
                    <td className="actions">
                      {!self && (
                        <>
                          <button className="btn sm" onClick={() => patch(u, { blocked: !u.blocked }, u.blocked ? `${u.name} разблокирован` : `${u.name} заблокирован`)}>
                            {u.blocked ? "Разблокировать" : "Заблокировать"}
                          </button>
                          <button className="btn sm" onClick={() => setResetting(u)}>Сменить пароль</button>
                          <button className="btn ghost sm" style={{ color: "var(--crit)" }} onClick={() => setDel(u)} aria-label={`Удалить ${u.name}`}>Удалить</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={5} className="nores">Ничего не найдено.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {access && <AccessModal user={access} onClose={() => setAccess(null)} />}
      {creating && <NewUserModal onClose={() => setCreating(false)} />}
      {resetting && <PasswordModal target={resetting} onClose={() => setResetting(null)} />}
      {del && (
        <Confirm
          title={`Удалить пользователя «${del.name}»?`}
          text="Он больше не сможет войти, его токены перестанут работать. Созданные им кейсы, баги и прогоны останутся, в авторах будет пусто. Если нужно только закрыть доступ, лучше заблокировать."
          onClose={() => setDel(null)}
          onYes={async () => {
            const u = del;
            setDel(null);
            await write(() => api("DELETE", userUrl(u.login), {}), "Пользователь удалён");
          }}
        />
      )}
    </main>
  );
}

function AccessModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const data = useData();
  const { write } = useStore();
  const [picked, setPicked] = useState(new Set(user.projects));
  const projects = [...data.projects].sort((a, b) => a.id.localeCompare(b.id));
  const toggle = (k: string) => {
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  };
  async function save() {
    if (await write(() => api("PUT", `${userUrl(user.login)}/projects`, { projects: [...picked] }), "Доступ сохранён")) onClose();
  }
  return (
    <Modal onClose={onClose}>
      <h2>Доступ к проектам: {user.name}</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Отмеченные проекты пользователь видит и, если он тестировщик, может менять. Остальные для него не существуют.
      </p>
      {projects.length ? (
        <div className="history" style={{ maxHeight: 360, overflow: "auto" }}>
          {projects.map((p) => (
            <label key={p.id} style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="mono small" style={{ width: 56 }}>{p.id}</span>
              <span style={{ flex: 1 }}>{p.name}</span>
            </label>
          ))}
        </div>
      ) : (
        <span className="muted">Проектов пока нет.</span>
      )}
      <div className="acts">
        <button type="button" className="btn sm" style={{ marginRight: "auto" }} onClick={() => setPicked(new Set(projects.map((p) => p.id)))}>Все</button>
        <button type="button" className="btn" onClick={onClose}>Отмена</button>
        <button type="button" className="btn primary" onClick={save}>Сохранить</button>
      </div>
    </Modal>
  );
}
