import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { User } from "../types";

export function Login() {
  const { setMe, toast } = useStore();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [f, setF] = useState({ login: "", name: "", pass: "", pass2: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const reg = tab === "register";
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const login = f.login.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(login)) return setErr("Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание");
    if (!f.pass) return setErr("Введите пароль");
    if (reg) {
      if (!f.name.trim()) return setErr("Укажите имя");
      if (f.pass.length < 8) return setErr("Пароль должен быть не короче 8 символов");
      if (f.pass !== f.pass2) return setErr("Пароли не совпадают");
    }
    setBusy(true);
    setErr("");
    try {
      const r = reg
        ? await api<{ user: User }>("POST", "/api/auth/register", { login, name: f.name.trim(), password: f.pass })
        : await api<{ user: User }>("POST", "/api/auth/login", { login, password: f.pass });
      if (reg) toast("Аккаунт создан");
      setMe(r.user);
    } catch (x: any) {
      setErr(x.message);
      setBusy(false);
    }
  }

  const switchTab = (t: typeof tab) => {
    setTab(t);
    setErr("");
  };

  return (
    <div className="wrap login">
      <form className="login-card" onSubmit={submit} noValidate>
        <span className="brand"><span className="mark">TB</span>TestBol</span>
        <div>
          <h1 style={{ fontSize: 22 }}>{reg ? "Создать аккаунт" : "Вход в систему"}</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>Тест-кейсы, прогоны и баги для вашей команды</p>
        </div>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!reg} onClick={() => switchTab("login")}>Вход</button>
          <button type="button" role="tab" aria-selected={reg} onClick={() => switchTab("register")}>Регистрация</button>
        </div>
        <div className="field">
          <label htmlFor="a-login">Логин</label>
          <input className="input" id="a-login" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="anna.smirnova" value={f.login} onChange={set("login")} autoFocus />
          {reg && <span className="muted" style={{ fontSize: 12 }}>3–32 символа: латинские буквы, цифры, точка, дефис, подчёркивание</span>}
        </div>
        {reg && (
          <div className="field">
            <label htmlFor="a-name">Имя</label>
            <input className="input" id="a-name" autoComplete="name" placeholder="Анна Смирнова" value={f.name} onChange={set("name")} />
            <span className="muted" style={{ fontSize: 12 }}>Его увидят коллеги в авторах тест-кейсов и багов</span>
          </div>
        )}
        <div className="field">
          <label htmlFor="a-pass">Пароль</label>
          <input className="input" id="a-pass" type="password" autoComplete={reg ? "new-password" : "current-password"} value={f.pass} onChange={set("pass")} />
          {reg && <span className="muted" style={{ fontSize: 12 }}>Минимум 8 символов</span>}
        </div>
        {reg && (
          <div className="field">
            <label htmlFor="a-pass2">Повторите пароль</label>
            <input className="input" id="a-pass2" type="password" autoComplete="new-password" value={f.pass2} onChange={set("pass2")} />
          </div>
        )}
        <div className="err" role="alert">{err}</div>
        <button className="btn primary" type="submit" disabled={busy} style={{ justifyContent: "center", padding: 10 }}>
          {busy ? "Проверяем…" : reg ? "Зарегистрироваться" : "Войти"}
        </button>
      </form>
    </div>
  );
}
