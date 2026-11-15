import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { User } from "../types";

interface Providers {
  local: boolean;
  ldap: boolean;
  oidc: { label: string } | null;
  kerberos: { label: string } | null;
}

export function Login() {
  const { setMe, toast } = useStore();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [f, setF] = useState({ login: "", name: "", pass: "", pass2: "", code: "", otp: "" });
  // сервер попросил второй фактор: показываем поле кода
  const [needOtp, setNeedOtp] = useState(false);
  const [policy, setPolicy] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // setup — пользователей ещё нет: регистрируется первый администратор с кодом из логов сервера
  const [mode, setMode] = useState<{ setup: boolean; registration: "open" | "closed"; providers: Providers }>({
    setup: false, registration: "open", providers: { local: true, ldap: false, oidc: null, kerberos: null },
  });
  useEffect(() => {
    api<{ setup?: boolean; registration?: "open" | "closed"; providers?: Providers; passwordPolicy?: string }>("GET", "/api/auth/me").then((r) => {
      setPolicy(r.passwordPolicy || "");
      setMode({ setup: !!r.setup, registration: r.registration || "open", providers: r.providers || { local: true, ldap: false, oidc: null, kerberos: null } });
      if (r.setup) setTab("register");
    }, () => {});
    // ошибка входа через SSO/Kerberos приходит в адресе после возврата от IdP
    const ssoError = new URLSearchParams(window.location.search).get("sso_error");
    if (ssoError) {
      setErr(ssoError);
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
  }, []);
  const pv = mode.providers;
  // форма логина и пароля нужна для локальных учётных записей и для LDAP/AD
  const passwordForm = pv.local || pv.ldap || mode.setup;
  const returnTo = encodeURIComponent("/" + window.location.hash);
  const canRegister = mode.setup || mode.registration === "open";
  const reg = tab === "register" && canRegister;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    // в каталоге логин бывает в виде DOMAIN\user или user@domain — его проверяет сервер
    const login = f.login.trim().toLowerCase();
    if (reg && !/^[a-z0-9._-]{3,32}$/.test(login)) return setErr("Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание");
    if (!login) return setErr("Введите логин");
    if (!f.pass) return setErr("Введите пароль");
    if (!reg && needOtp && !f.otp.trim()) return setErr("Введите код из приложения-аутентификатора");
    if (reg) {
      if (!f.name.trim()) return setErr("Укажите имя");
      if (f.pass !== f.pass2) return setErr("Пароли не совпадают");
      if (mode.setup && !f.code.trim()) return setErr("Введите код установки из логов сервера");
    }
    setBusy(true);
    setErr("");
    try {
      const r = reg
        ? await api<{ user: User }>("POST", "/api/auth/register", { login, name: f.name.trim(), password: f.pass, setupCode: f.code.trim() || undefined })
        : await api<{ user: User }>("POST", "/api/auth/login", { login, password: f.pass, code: needOtp ? f.otp.trim() : undefined });
      if (reg) toast("Аккаунт создан");
      setMe(r.user);
    } catch (x: any) {
      if (x.data?.twoFactor && !needOtp) {
        // пароль верный, нужен код — просим его без сообщения об ошибке
        setNeedOtp(true);
        setErr("");
      } else setErr(x.message);
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
        <span className="brand"><span className="mark">TB</span>TestBall</span>
        <div>
          <h1 style={{ fontSize: 22 }}>{mode.setup ? "Первый администратор" : reg ? "Создать аккаунт" : "Вход в систему"}</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {mode.setup
              ? "Пользователей ещё нет. Первый зарегистрированный станет администратором — для этого нужен код установки"
              : "Тест-кейсы, прогоны и баги для вашей команды"}
          </p>
        </div>
        {!mode.setup && (pv.oidc || pv.kerberos) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pv.oidc && <a className="btn primary" href={`/api/auth/oidc/start?return=${returnTo}`} style={{ justifyContent: "center", padding: 10, textDecoration: "none" }}>{pv.oidc.label}</a>}
            {pv.kerberos && <a className="btn" href={`/api/auth/kerberos?return=${returnTo}`} style={{ justifyContent: "center", padding: 10, textDecoration: "none" }}>{pv.kerberos.label}</a>}
            {passwordForm && <span className="muted small" style={{ textAlign: "center" }}>или по логину и паролю</span>}
          </div>
        )}
        {!passwordForm && <div className="err" role="alert">{err}</div>}
        {passwordForm && <>
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
          {reg && <span className="muted" style={{ fontSize: 12 }}>Пароль: {policy || "не короче 8 символов"}</span>}
        </div>
        {!reg && needOtp && (
          <div className="field">
            <label htmlFor="a-otp">Код из приложения-аутентификатора</label>
            <input className="input mono" id="a-otp" inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" value={f.otp} onChange={set("otp")} autoFocus />
            <span className="muted" style={{ fontSize: 12 }}>Нет телефона под рукой — введите один из резервных кодов</span>
          </div>
        )}
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
        </>}
        {pv.ldap && !reg && <p className="muted small" style={{ margin: 0, textAlign: "center" }}>Можно войти доменной учётной записью: логин и пароль Windows.</p>}
        {passwordForm && !canRegister && !pv.ldap && <p className="muted small" style={{ margin: 0, textAlign: "center" }}>Нет учётной записи? Её создаёт администратор.</p>}
      </form>
    </div>
  );
}
