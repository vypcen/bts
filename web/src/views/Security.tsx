// Безопасность своей учётной записи: пароль, двухфакторная аутентификация, активные сессии.
// И экран «сначала смените пароль / включите 2FA», если этого требует политика (server/security.js)
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { fmt, Modal } from "../ui";

interface TwoFactorState { enabled: boolean; since: number | null; recoveryLeft: number; required: boolean; policy: string; available: boolean }
interface Session { id: string; created: number; lastSeen: number; ip: string; agent: string; current: boolean }

// ---------- пароль ----------
function PasswordForm({ onDone, forced }: { onDone?: () => void; forced?: boolean }) {
  const { me, toast } = useStore();
  const [f, setF] = useState({ current: "", pass: "", pass2: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.current) return setErr("Введите текущий пароль");
    if (f.pass !== f.pass2) return setErr("Пароли не совпадают");
    setBusy(true);
    setErr("");
    try {
      await api("POST", "/api/auth/password", { current: f.current, password: f.pass });
      toast("Пароль изменён. На других устройствах нужно войти заново");
      setF({ current: "", pass: "", pass2: "" });
      onDone?.();
    } catch (x: any) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} noValidate className="sec-form">
      <div className="field"><label htmlFor="pw-cur">{forced ? "Текущий (временный) пароль" : "Текущий пароль"}</label>
        <input className="input" id="pw-cur" type="password" autoComplete="current-password" value={f.current} onChange={set("current")} autoFocus /></div>
      <div className="field"><label htmlFor="pw-new">Новый пароль</label>
        <input className="input" id="pw-new" type="password" autoComplete="new-password" value={f.pass} onChange={set("pass")} />
        <span className="muted" style={{ fontSize: 12 }}>Пароль: {me?.passwordPolicy || "не короче 8 символов"}</span></div>
      <div className="field"><label htmlFor="pw-new2">Повторите новый пароль</label>
        <input className="input" id="pw-new2" type="password" autoComplete="new-password" value={f.pass2} onChange={set("pass2")} /></div>
      <div className="err" role="alert">{err}</div>
      <div className="acts" style={{ justifyContent: "flex-start" }}>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Сохраняем…" : "Сменить пароль"}</button>
      </div>
    </form>
  );
}

// ---------- 2FA ----------
function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join("\n");
  return (
    <div className="view-block">
      <span className="label">Резервные коды</span>
      <p className="small" style={{ margin: "0 0 6px" }}>
        Сохраните их в надёжном месте (менеджер паролей, распечатка). Каждый код подходит один раз, если телефона нет под рукой.
        <b> Больше они показаны не будут.</b>
      </p>
      <pre className="mono recovery-codes" aria-label="Резервные коды">{text}</pre>
      <div className="acts" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(text)}>Скопировать</button>
        <a className="btn" href={`data:text/plain;charset=utf-8,${encodeURIComponent("Резервные коды TestBall\n\n" + text)}`} download="testball-recovery-codes.txt" style={{ textDecoration: "none" }}>Скачать</a>
      </div>
    </div>
  );
}

function TwoFactorSetup({ onEnabled }: { onEnabled: (codes: string[]) => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api<{ secret: string; qr: string }>("POST", "/api/auth/2fa/setup", {}).then(setSetup, (e) => setErr(e.message));
  }, []);
  async function enable(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/enable", { code });
      onEnabled(r.recoveryCodes);
    } catch (x: any) {
      setErr(x.message);
    }
  }
  if (!setup) return err ? <div className="err" role="alert">{err}</div> : <div className="skel">Готовим QR-код…</div>;
  return (
    <form onSubmit={enable} noValidate className="sec-form">
      <ol className="sec-steps">
        <li>Установите на телефон приложение-аутентификатор: Яндекс Ключ, Google Authenticator, Microsoft Authenticator или любое с поддержкой TOTP.</li>
        <li>
          Отсканируйте QR-код в приложении.
          <div className="qr" dangerouslySetInnerHTML={{ __html: setup.qr }} />
          <span className="small muted">Не сканируется? Введите ключ вручную: <span className="mono">{setup.secret}</span></span>
        </li>
        <li>Введите 6-значный код, который показало приложение.</li>
      </ol>
      <div className="field"><label htmlFor="tf-code">Код из приложения</label>
        <input className="input mono" id="tf-code" inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 180 }} /></div>
      <div className="err" role="alert">{err}</div>
      <div className="acts" style={{ justifyContent: "flex-start" }}>
        <button className="btn primary" type="submit" disabled={!code.trim()}>Включить</button>
      </div>
    </form>
  );
}

function TwoFactorPanel() {
  const { toast, setMe } = useStore();
  const [st, setSt] = useState<TwoFactorState | null>(null);
  const [mode, setMode] = useState<"view" | "setup" | "disable" | "codes">("view");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [f, setF] = useState({ password: "", code: "" });
  const [err, setErr] = useState("");
  const load = () => api<TwoFactorState>("GET", "/api/auth/2fa").then(setSt, (e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!st) return err ? <div className="err">{err}</div> : <div className="skel">Загружаем…</div>;
  if (!st.available) return <p className="muted">Вы входите через корпоративный единый вход — второй фактор настраивается в нём.</p>;
  if (codes) return <><p>Двухфакторная аутентификация включена.</p><RecoveryCodes codes={codes} /></>;
  if (mode === "setup") {
    return <TwoFactorSetup onEnabled={(c) => { setCodes(c); setMe((m) => (m ? { ...m, twoFactor: true } : m)); load(); toast("Двухфакторная аутентификация включена"); }} />;
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    try {
      if (mode === "disable") {
        await api("POST", "/api/auth/2fa/disable", f);
        setMe((m) => (m ? { ...m, twoFactor: false } : m));
        toast("Двухфакторная аутентификация отключена");
        setMode("view");
      } else {
        const r = await api<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/recovery-codes", f);
        setCodes(r.recoveryCodes);
      }
      setF({ password: "", code: "" });
      setErr("");
      load();
    } catch (x: any) {
      setErr(x.message);
    }
  }
  if (mode === "disable" || mode === "codes") {
    return (
      <form onSubmit={confirm} noValidate className="sec-form">
        <p className="small" style={{ margin: 0 }}>{mode === "disable" ? "Чтобы отключить, подтвердите, что это вы." : "Старые резервные коды перестанут работать."}</p>
        <div className="field"><label htmlFor="tf-pass">Пароль</label>
          <input className="input" id="tf-pass" type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoFocus /></div>
        <div className="field"><label htmlFor="tf-c">Код из приложения или резервный код</label>
          <input className="input mono" id="tf-c" autoComplete="one-time-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} style={{ maxWidth: 220 }} /></div>
        <div className="err" role="alert">{err}</div>
        <div className="acts" style={{ justifyContent: "flex-start" }}>
          <button className="btn" type="button" onClick={() => { setMode("view"); setErr(""); }}>Отмена</button>
          <button className={`btn ${mode === "disable" ? "danger" : "primary"}`} type="submit">{mode === "disable" ? "Отключить" : "Получить новые коды"}</button>
        </div>
      </form>
    );
  }
  return (
    <div className="sec-form">
      {st.enabled ? (
        <>
          <p style={{ margin: 0 }}>
            <b className="c-ok">Включена</b>{st.since ? ` с ${fmt(st.since)}` : ""}. При входе, кроме пароля, нужен код из приложения на телефоне.
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Неиспользованных резервных кодов: <b>{st.recoveryLeft}</b>{st.recoveryLeft <= 3 ? " — получите новые" : ""}.
          </p>
          <div className="acts" style={{ justifyContent: "flex-start" }}>
            <button className="btn" onClick={() => setMode("codes")}>Новые резервные коды</button>
            {!st.required && <button className="btn ghost danger" onClick={() => setMode("disable")}>Отключить</button>}
          </div>
          {st.required && <p className="small muted" style={{ margin: 0 }}>Отключить нельзя: двухфакторная аутентификация обязательна по политике безопасности.</p>}
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            Выключена. С ней войти под вашим именем не получится даже с украденным паролем: нужен ещё код из приложения на вашем телефоне.
          </p>
          <div className="acts" style={{ justifyContent: "flex-start" }}>
            <button className="btn primary" onClick={() => setMode("setup")}>Включить</button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- сессии ----------
// Браузер и система из User-Agent — коротко, для узнавания своего устройства
function device(agent: string): string {
  if (!agent) return "Неизвестное устройство";
  const browser = /Edg\//.test(agent) ? "Edge" : /YaBrowser/.test(agent) ? "Яндекс Браузер" : /OPR\//.test(agent) ? "Opera" : /Firefox\//.test(agent) ? "Firefox"
    : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : /curl|python|node|axios|Go-http/i.test(agent) ? "Скрипт" : "Браузер";
  const os = /Windows/.test(agent) ? "Windows" : /Mac OS X|Macintosh/.test(agent) ? "macOS" : /Android/.test(agent) ? "Android"
    : /iPhone|iPad/.test(agent) ? "iOS" : /Linux/.test(agent) ? "Linux" : "";
  return os ? `${browser}, ${os}` : browser;
}

function SessionsPanel() {
  const { toast, setMe } = useStore();
  const [list, setList] = useState<Session[] | null>(null);
  const [info, setInfo] = useState({ idleMinutes: 0, maxSessions: 0 });
  const load = () => api<{ sessions: Session[]; idleMinutes: number; maxSessions: number }>("GET", "/api/auth/sessions").then((r) => {
    setList(r.sessions);
    setInfo({ idleMinutes: r.idleMinutes, maxSessions: r.maxSessions });
  });
  useEffect(() => {
    load();
  }, []);
  if (!list) return <div className="skel">Загружаем…</div>;
  async function end(s: Session) {
    try {
      await api("DELETE", `/api/auth/sessions/${s.id}`, {});
      if (s.current) return setMe(null);
      toast("Сессия завершена");
      load();
    } catch (x: any) {
      toast(x.message);
    }
  }
  return (
    <div className="sec-form">
      <table className="tbl">
        <thead><tr><th>Устройство</th><th>IP</th><th>Вход</th><th>Последняя активность</th><th /></tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              <td>{device(s.agent)}{s.current && <span className="tag" style={{ marginLeft: 6 }}>это устройство</span>}</td>
              <td className="mono small">{s.ip || "—"}</td>
              <td className="small muted">{fmt(s.created)}</td>
              <td className="small muted">{fmt(s.lastSeen)}</td>
              <td><button className="btn ghost sm" onClick={() => end(s)}>{s.current ? "Выйти" : "Завершить"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length > 1 && (
        <div className="acts" style={{ justifyContent: "flex-start" }}>
          <button className="btn" onClick={async () => { await api("POST", "/api/auth/sessions/others", {}); toast("Остальные сессии завершены"); load(); }}>
            Завершить все, кроме этой
          </button>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        {info.idleMinutes ? `Сессия закрывается после ${info.idleMinutes} мин. без действий. ` : ""}
        {info.maxSessions ? `Одновременно — не больше ${info.maxSessions} сессий: при новом входе самая старая закрывается.` : ""}
      </p>
    </div>
  );
}

// ---------- окно «Безопасность» ----------
export function SecurityModal({ onClose }: { onClose: () => void }) {
  const { me } = useStore();
  const local = !me?.provider || me.provider === "local";
  const [tab, setTab] = useState<"password" | "2fa" | "sessions">(local ? "password" : "2fa");
  const tabs: [typeof tab, string][] = [...(local ? [["password", "Пароль"] as [typeof tab, string]] : []), ["2fa", "Двухфакторная аутентификация"], ["sessions", "Активные сессии"]];
  return (
    <Modal onClose={onClose} wide>
      <h2>Безопасность</h2>
      <div className="seg" role="tablist" style={{ marginBottom: 8 }}>
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn ghost sm${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === "password" ? <PasswordForm /> : tab === "2fa" ? <TwoFactorPanel /> : <SessionsPanel />}
      <div className="acts"><button className="btn" onClick={onClose}>Закрыть</button></div>
    </Modal>
  );
}

// ---------- обязательное действие ----------
export function PendingScreen() {
  const { me, setMe, toast } = useStore();
  const [codes, setCodes] = useState<string[] | null>(null);
  const logout = () => {
    api("POST", "/api/auth/logout", {}).catch(() => {});
    setMe(null);
  };
  const done = async () => {
    const r = await api<{ user: any }>("GET", "/api/auth/me");
    setMe(r.user);
  };
  return (
    <div className="wrap login">
      <div className="login-card" style={{ maxWidth: 520 }}>
        <span className="brand"><span className="mark">TB</span>TestBall</span>
        {me?.pending === "password" ? (
          <>
            <h1 style={{ fontSize: 22, margin: 0 }}>Смените пароль</h1>
            <p className="muted" style={{ margin: 0 }}>Пароль выдан администратором или истёк срок его действия. Придумайте новый, чтобы продолжить.</p>
            <PasswordForm forced onDone={done} />
          </>
        ) : codes ? (
          <>
            <h1 style={{ fontSize: 22, margin: 0 }}>Готово</h1>
            <RecoveryCodes codes={codes} />
            <button className="btn primary" onClick={done} style={{ justifyContent: "center" }}>Я сохранил коды, продолжить</button>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 22, margin: 0 }}>Включите двухфакторную аутентификацию</h1>
            <p className="muted" style={{ margin: 0 }}>Так требует политика безопасности вашей компании. Это займёт минуту.</p>
            <TwoFactorSetup onEnabled={(c) => { setCodes(c); toast("Двухфакторная аутентификация включена"); }} />
          </>
        )}
        <button type="button" className="btn ghost" onClick={logout}>Выйти</button>
      </div>
    </div>
  );
}
