import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ROLES } from "../labels";
import { useStore } from "../store";
import type { Role } from "../types";
import { Modal } from "../ui";

const userUrl = (login: string) => `/api/admin/users/${encodeURIComponent(login)}`;

// Смена своего пароля (нужен текущий) или сброс пароля пользователю админом (target).
// В обоих случаях сервер закрывает остальные сессии: тот, кто вошёл со старым паролем, теряет доступ
export function PasswordModal({ target, onClose }: { target?: { login: string; name: string }; onClose: () => void }) {
  const { write } = useStore();
  const [f, setF] = useState({ current: "", pass: "", pass2: "" });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target && !f.current) return setErr("Введите текущий пароль");
    if (f.pass.length < 8) return setErr("Новый пароль должен быть не короче 8 символов");
    if (f.pass !== f.pass2) return setErr("Пароли не совпадают");
    const ok = target
      ? await write(() => api("PATCH", userUrl(target.login), { password: f.pass }), `Пароль ${target.name} изменён`)
      : await write(() => api("POST", "/api/auth/password", { current: f.current, password: f.pass }), "Пароль изменён. На других устройствах нужно войти заново");
    if (ok) onClose();
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>{target ? `Новый пароль: ${target.name}` : "Смена пароля"}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {target ? "Пользователь выйдет на всех устройствах и войдёт с новым паролем. Передайте его лично." : "На остальных устройствах сессии закроются."}
        </p>
        {!target && (
          <div className="field"><label htmlFor="pw-cur">Текущий пароль</label>
            <input className="input" id="pw-cur" type="password" autoComplete="current-password" value={f.current} onChange={set("current")} autoFocus /></div>
        )}
        <div className="field"><label htmlFor="pw-new">Новый пароль</label>
          <input className="input" id="pw-new" type="password" autoComplete="new-password" value={f.pass} onChange={set("pass")} autoFocus={!!target} />
          <span className="muted" style={{ fontSize: 12 }}>Минимум 8 символов</span></div>
        <div className="field"><label htmlFor="pw-new2">Повторите новый пароль</label>
          <input className="input" id="pw-new2" type="password" autoComplete="new-password" value={f.pass2} onChange={set("pass2")} /></div>
        <div className="err" role="alert">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}

// Новый пользователь от имени админа — единственный способ завести учётную запись при REGISTRATION=closed
export function NewUserModal({ onClose }: { onClose: () => void }) {
  const { write } = useStore();
  const [f, setF] = useState({ login: "", name: "", pass: "", role: "tester" as Role });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const login = f.login.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(login)) return setErr("Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание");
    if (!f.name.trim()) return setErr("Укажите имя");
    if (f.pass.length < 8) return setErr("Пароль должен быть не короче 8 символов");
    const body = { login, name: f.name.trim(), password: f.pass, role: f.role };
    if (await write(() => api("POST", "/api/admin/users", body), `Пользователь ${login} создан. Выдайте ему доступ к проектам`)) onClose();
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>Новый пользователь</h2>
        <div className="field"><label htmlFor="nu-login">Логин</label>
          <input className="input" id="nu-login" autoCapitalize="none" spellCheck={false} placeholder="anna.smirnova" value={f.login} onChange={set("login")} autoFocus /></div>
        <div className="field"><label htmlFor="nu-name">Имя</label>
          <input className="input" id="nu-name" placeholder="Анна Смирнова" value={f.name} onChange={set("name")} /></div>
        <div className="field"><label htmlFor="nu-pass">Временный пароль</label>
          <input className="input" id="nu-pass" type="password" autoComplete="new-password" value={f.pass} onChange={set("pass")} />
          <span className="muted" style={{ fontSize: 12 }}>Минимум 8 символов. Пользователь сменит его сам: кнопка «Пароль» вверху страницы</span></div>
        <div className="field"><label htmlFor="nu-role">Роль</label>
          <select className="input" id="nu-role" value={f.role} onChange={set("role")}>{ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></div>
        <div className="err" role="alert">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">Создать</button>
        </div>
      </form>
    </Modal>
  );
}
