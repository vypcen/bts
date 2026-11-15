import { useState } from "react";
import { api } from "../api";
import { PROVIDERS } from "../labels";
import { href, useRoute } from "../router";
import { useData, useLoad, useStore } from "../store";
import type { ProjectRole, Role } from "../types";
import { Avatar, Confirm, Empty, fmt, Modal, Pill, useRoles } from "../ui";
import { NewUserModal, PasswordModal } from "./Password";
import { AuditLog, DeletedProjects, SystemInfo } from "./Admin";
import { RolesAdmin } from "./Roles";

// Ответ GET /api/admin/users
interface AdminUser {
  login: string;
  name: string;
  role: Role;
  blocked: boolean;
  created: number;
  projects: string[];
  projectRoles: Record<string, ProjectRole>;
  provider: string;
  email: string;
  lastLogin: number | null;
  twoFactor?: boolean;
  mustChangePassword?: boolean;
  sessions?: number;
}

interface Seats {
  full: { used: number; limit: number | null };
  view: { used: number; limit: number | null };
}

const usersUrl = "/api/admin/users";
const userUrl = (login: string) => `${usersUrl}/${encodeURIComponent(login)}`;

// Раздел администратора: роли, блокировка, удаление и доступ к проектам
// Раздел администратора: пользователи, журнал аудита, удалённые проекты (#/users, #/users/audit, #/users/trash)
export function Users() {
  const { me } = useStore();
  const [, sub] = useRoute();
  if (me?.role !== "admin") return <UsersList />;
  return (
    <>
      <nav className="nav wrap" style={{ paddingBottom: 0 }}>
        <a href={href("users")} aria-current={!sub ? "page" : undefined}>Пользователи</a>
        <a href={href("users", "audit")} aria-current={sub === "audit" ? "page" : undefined}>Журнал аудита</a>
        <a href={href("users", "trash")} aria-current={sub === "trash" ? "page" : undefined}>Удалённые проекты</a>
        <a href={href("users", "roles")} aria-current={sub === "roles" ? "page" : undefined}>Роли</a>
        <a href={href("users", "system")} aria-current={sub === "system" ? "page" : undefined}>Лицензия и система</a>
      </nav>
      {sub === "audit" ? <main className="wrap"><AuditLog /></main>
        : sub === "roles" ? <main className="wrap"><RolesAdmin /></main>
        : sub === "trash" ? <main className="wrap"><DeletedProjects /></main>
        : sub === "system" ? <main className="wrap"><SystemInfo /></main>
        : <UsersList />}
    </>
  );
}

function UsersList() {
  const { me, write, liveError } = useStore();
  const roleList = useRoles();
  const { value, error } = useLoad<{ users: AdminUser[]; seats: Seats }>(usersUrl);
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
        {roleList.all.map((r) => (
          <span key={r.key} className="small muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Pill tone={r.key === "admin" ? "accent" : r.key === "tester" ? "info" : "neutral"} label={r.label} sm /> {r.hint}
          </span>
        ))}
        <a className="small" href={href("users", "roles")}>Настроить роли →</a>
      </div>
      {value?.seats && (
        <div className="small muted" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span title="Тестировщики и администраторы">Полные лицензии: <b>{value.seats.full.used}</b>{value.seats.full.limit !== null ? ` из ${value.seats.full.limit}` : " (без ограничений)"}</span>
          <span title="Разработчики и наблюдатели">Просмотровые лицензии: <b>{value.seats.view.used}</b>{value.seats.view.limit !== null ? ` из ${value.seats.view.limit}` : " (без ограничений)"}</span>
        </div>
      )}
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
                      <div className="muted small mono" style={{ fontWeight: 400 }}>
                        @{u.login}{self && " · это вы"} · {PROVIDERS[u.provider] || u.provider} · {u.lastLogin ? `вход ${fmt(u.lastLogin)}` : `с ${fmt(u.created)}`}
                      </div>
                    </td>
                    <td>
                      <select className="input" aria-label={`Роль ${u.name}`} value={u.role} disabled={self}
                        title={self ? "Свою роль поменять нельзя: попросите другого администратора" : undefined}
                        onChange={(e) => patch(u, { role: e.target.value }, `${u.name}: ${roleList.name(e.target.value)}`)}>
                        {roleList.all.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                      </select>
                    </td>
                    <td>
                      {u.role === "admin" ? (
                        <span className="muted small">Все проекты</span>
                      ) : (
                        <div className="chips" style={{ alignItems: "center" }}>
                          {u.projects.map((k) => (
                            <a key={k} className="chip" href={href("p", k)} title={u.projectRoles[k] ? `Роль в проекте: ${roleList.name(u.projectRoles[k])}` : undefined}>
                              {k}{u.projectRoles[k] && <span className="muted"> · {roleList.name(u.projectRoles[k]).toLowerCase()}</span>}
                            </a>
                          ))}
                          {!u.projects.length && <span className="small" style={{ color: "var(--warn)" }}>Нет доступа ни к одному</span>}
                          <button className="btn ghost sm" onClick={() => setAccess(u)}>Изменить</button>
                        </div>
                      )}
                    </td>
                    <td>
                      {u.blocked ? <Pill tone="crit" label="Заблокирован" sm /> : <Pill tone="ok" label="Активен" sm />}
                      <div className="small muted" style={{ marginTop: 4 }}>
                        {u.twoFactor && <span title="Двухфакторная аутентификация включена">2FA · </span>}
                        {u.mustChangePassword && <span title="Сменит пароль при следующем входе">смена пароля · </span>}
                        {u.sessions ? `сессий: ${u.sessions}` : "не в сети"}
                      </div>
                    </td>
                    <td className="actions">
                      {!self && (
                        <>
                          <button className="btn sm" onClick={() => patch(u, { blocked: !u.blocked }, u.blocked ? `${u.name} разблокирован` : `${u.name} заблокирован`)}>
                            {u.blocked ? "Разблокировать" : "Заблокировать"}
                          </button>
                          {u.provider === "local" && <button className="btn sm" onClick={() => setResetting(u)}>Сменить пароль</button>}
                          {u.twoFactor && (
                            <button className="btn sm" title="Потерян телефон: пользователь войдёт по паролю и настроит 2FA заново"
                              onClick={() => write(() => api("POST", `${usersUrl}/${encodeURIComponent(u.login)}/2fa/reset`, {}), `${u.name}: двухфакторная аутентификация сброшена`)}>
                              Сбросить 2FA
                            </button>
                          )}
                          {!!u.sessions && (
                            <button className="btn sm" title="Выйти на всех устройствах (например, потерян ноутбук)"
                              onClick={() => write(() => api("POST", `${usersUrl}/${encodeURIComponent(u.login)}/sessions/revoke`, {}), `${u.name}: все сессии завершены`)}>
                              Завершить сессии
                            </button>
                          )}
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
  const roleList = useRoles();
  const [picked, setPicked] = useState(new Set(user.projects));
  // роль в проекте; "" — как глобальная
  const [roles, setRoles] = useState<Record<string, ProjectRole | "">>({ ...user.projectRoles });
  const projects = [...data.projects].sort((a, b) => a.id.localeCompare(b.id));
  const toggle = (k: string) => {
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  };
  async function save() {
    const projects = [...picked].map((key) => ({ key, role: roles[key] || null }));
    if (await write(() => api("PUT", `${userUrl(user.login)}/projects`, { projects }), "Доступ сохранён")) onClose();
  }
  return (
    <Modal onClose={onClose}>
      <h2>Доступ к проектам: {user.name}</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Отмеченные проекты пользователь видит, остальные для него не существуют. Роль можно задать отдельно для проекта —
        иначе действует глобальная ({roleList.name(user.role).toLowerCase()}).
      </p>
      {projects.length ? (
        <div className="history" style={{ maxHeight: 360, overflow: "auto" }}>
          {projects.map((p) => (
            <label key={p.id} style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="mono small" style={{ width: 56 }}>{p.id}</span>
              <span style={{ flex: 1 }}>{p.name}</span>
              {picked.has(p.id) && (
                <select className="input" style={{ width: 170 }} aria-label={`Роль в ${p.id}`} value={roles[p.id] || ""}
                  onChange={(e) => setRoles({ ...roles, [p.id]: e.target.value as ProjectRole | "" })}>
                  <option value="">Как глобальная</option>
                  {roleList.project.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              )}
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
