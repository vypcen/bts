import { useEffect, useRef, type ReactNode } from "react";
import { find, PRIORITIES, RESULTS, SEVERITIES, type Tone } from "./labels";
import { useStore } from "./store";
import type { Priority, ResultValue, Severity } from "./types";

export const fmt = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export const fmtSize = (b: number) =>
  b < 1024 ? `${b} Б` : b < 1024 * 1024 ? `${Math.round(b / 1024)} КБ` : `${(b / 1024 / 1024).toFixed(1)} МБ`;

export function Pill({ tone, label, sm }: { tone: Tone; label: string; sm?: boolean }) {
  return (
    <span className={`pill t-${tone}${sm ? " sm" : ""}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

// Вертикальная метка-полоска для приоритета и серьёзности
const BAR: Record<Tone, string> = { crit: "c-crit", warn: "c-warn", info: "c-info", neutral: "c-line", ok: "c-info", accent: "c-info" };
export function Prio({ p }: { p: Priority }) {
  const d = find(PRIORITIES, p);
  return <span className={`prio ${BAR[d.tone]}`}><i />{d.label}</span>;
}
export function Sev({ s }: { s: Severity }) {
  const d = find(SEVERITIES, s);
  return <span className={`prio ${BAR[d.tone]}`} style={s === "blocker" ? { fontWeight: 600 } : undefined}><i />{d.label}</span>;
}
export function ResultPill({ r, sm }: { r: ResultValue; sm?: boolean }) {
  const d = find(RESULTS, r);
  return <Pill tone={d.tone} label={d.label} sm={sm} />;
}

const hue = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};
const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

export function useNames() {
  const { me, data } = useStore();
  return (login: string | null | undefined) => {
    if (!login) return "—";
    if (me && login === me.login) return "Вы";
    return data?.users[login]?.name || "Участник";
  };
}

export function Avatar({ login }: { login: string }) {
  const { data, me } = useStore();
  const name = (me?.login === login ? me.name : data?.users[login]?.name) || login;
  return (
    <span className="ava" style={{ background: `hsl(${hue(login)} 45% 42%)` }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Who({ login }: { login: string | null | undefined }) {
  const nameOf = useNames();
  if (!login) return <span className="muted">—</span>;
  return (
    <span className="who">
      <Avatar login={login} />
      <span>{nameOf(login)}</span>
    </span>
  );
}

// Esc закрывает только верхний слой: модалку поверх панели, затем саму панель
const escStack: (() => void)[] = [];
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && escStack.length) escStack[escStack.length - 1]();
});
function useEscape(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    escStack.push(h);
    return () => {
      escStack.splice(escStack.indexOf(h), 1);
    };
  }, []);
}

export function Drawer(props: { label: string; idTag?: string; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEscape(props.onClose);
  return (
    <>
      <div className="scrim" onClick={props.onClose} />
      <aside className="drawer" role="dialog" aria-label={props.label}>
        <header>
          {props.idTag && <span className="mono muted">{props.idTag}</span>}
          <h2>{props.title}</h2>
          <button type="button" className="btn ghost" onClick={props.onClose} aria-label="Закрыть">✕</button>
        </header>
        <div className="body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </aside>
    </>
  );
}

export function Modal({ onClose, children, wide }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="modal">
      <div className="scrim" onClick={onClose} />
      <div className={`box${wide ? " wide" : ""}`} role="dialog">
        {children}
      </div>
    </div>
  );
}

export function Confirm(props: { title: string; text: string; action?: string; onYes: () => void; onClose: () => void }) {
  return (
    <Modal onClose={props.onClose}>
      <h2>{props.title}</h2>
      <p className="muted" style={{ margin: 0 }}>{props.text}</p>
      <div className="acts">
        <button className="btn" onClick={props.onClose}>Отмена</button>
        <button className="btn danger solid" onClick={props.onYes} autoFocus>{props.action || "Удалить"}</button>
      </div>
    </Modal>
  );
}

export function TextBlock({ label, text, empty = "Не указано", steps }: { label: string; text: string; empty?: string; steps?: boolean }) {
  const lines = steps ? text.split("\n").filter(Boolean) : [];
  return (
    <div className="view-block">
      <span className="label">{label}</span>
      <div className="txt">
        {!text ? <span className="muted">{empty}</span> : steps ? <ol className="steps">{lines.map((s, i) => <li key={i}>{s}</li>)}</ol> : text}
      </div>
    </div>
  );
}

// Полоса распределения результатов
const BAR_ORDER: [ResultValue, string][] = [["passed", "--ok"], ["failed", "--crit"], ["blocked", "--warn"], ["skipped", "--muted"], ["untested", "--line"]];
export function ResultBar({ counts, title }: { counts: Record<ResultValue, number>; title?: string }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="bar" title={title}>
      {BAR_ORDER.map(([k, v]) => (counts[k] ? <span key={k} style={{ width: `${(counts[k] / total) * 100}%`, background: `var(${v})` }} /> : null))}
    </div>
  );
}

// Значок «💬 N» рядом с названием в таблице, если есть комментарии
export function CommentCount({ n }: { n?: number }) {
  return n ? <span className="ccount" title={`Комментариев: ${n}`}>💬 {n}</span> : null;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}
