import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { User } from "../types";

export function Login() {
  const { setMe, toast } = useStore();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [f, setF] = useState({ login: "", name: "", pass: "", pass2: "", code: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // setup — пользователей ещё нет: регистрируется первый администратор с кодом из логов сервера
  const [mode, setMode] = useState<{ setup: boolean; registration: "open" | "closed" }>({ setup: false, registration: "open" });
  useEffect(() => {
    api<{ setup?: boolean; registration?: "open" | "closed" }>("GET", "/api/auth/me").then((r) => {
      setMode({ setup: !!r.setup, registration: r.registration || "open" });
      if (r.setup) setTab("register");
    }, () => {});
  }, []);
  const canRegister = mode.setup || mode.registration === "open";
  const reg = tab === "register" && canRegister;
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
      if (mode.setup && !f.code.trim()) return setErr("Введите код установки из логов сервера");
    }
    setBusy(true);
    setErr("");
    try {
      const r = reg
        ? await api<{ user: User }>("POST", "/api/auth/register", { login, name: f.name.trim(), password: f.pass, setupCode: f.code.trim() || undefined })
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
          <h1 style={{ fontSize: 22 }}>{mode.setup ? "Первый администратор" : reg ? "Создать аккаунт" : "Вход в систему"}</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {mode.setup
              ? "Пользователей ещё нет. Первый зарегистрированный станет администратором — для этого нужен код установки"
              : "Тест-кейсы, прогоны и баги для вашей команды"}
          </p>
        </div>
        {!mode.setup && canRegister && (
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={!reg} onClick={() => switchTab("login")}>Вход</button>
            <button type="button" role="tab" aria-selected={reg} onClick={() => switchTab("register")}>Регистрация</button>
          </div>
        )}
        {mode.setup && (
          <div className="field">
            <label htmlFor="a-code">Код установки</label>
            <input className="input mono" id="a-code" autoComplete="off" spellCheck={false} value={f.code} onChange={set("code")} />
            <span className="muted" style={{ fontSize: 12 }}>Напечатан в логах сервера: <span className="mono">docker compose logs app</span>, или задан в SETUP_CODE в .env</span>
          </div>
        )}
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
        {!canRegister && <p className="muted small" style={{ margin: 0, textAlign: "center" }}>Нет учётной записи? Её создаёт администратор.</p>}
      </form>
    </div>
  );
}
