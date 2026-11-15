// Уведомления (I-01, I-02, I-03): колокольчик в шапке, настройки (почта, какие виды присылать), кнопка «Следить»
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useData, useLoad, useStore } from "../store";
import { fmt, Modal } from "../ui";

interface Note { id: number; project: string | null; kind: string; title: string; body: string; link: string; actor: string | null; created: number; read: boolean }
interface Settings { email: string; emailOn: boolean; off: string[]; kinds: Record<string, string>; smtp: boolean }

export function Bell() {
  const { write } = useStore();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [tick, setTick] = useState(0);
  // список перечитывается при любых изменениях данных и раз в минуту
  useEffect(() => { const t = window.setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []);
  const { value } = useLoad<{ items: Note[]; unread: number }>(`/api/notifications?t=${tick}`);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const unread = value?.unread || 0;
  const go = async (n: Note) => {
    if (!n.read) await api("POST", "/api/notifications/read", { ids: [n.id] }).catch(() => {});
    setOpen(false);
    setTick((x) => x + 1);
    if (n.link) location.hash = `#/${n.link}`;
  };
  return (
    <div className="bell" ref={box}>
      <button className="btn ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={unread ? `Уведомления: непрочитанных ${unread}` : "Уведомления"} title="Уведомления">
        🔔{unread > 0 && <span className="bell-n">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Уведомления">
          <div className="bell-head">
            <b>Уведомления</b>
            <div className="spacer" />
            {unread > 0 && <button className="link small" onClick={() => write(() => api("POST", "/api/notifications/read", { all: true })).then(() => setTick((x) => x + 1))}>Прочитать все</button>}
            <button className="link small" onClick={() => { setSettings(true); setOpen(false); }}>Настройки</button>
          </div>
          {!value?.items.length ? <p className="muted small" style={{ padding: 12, margin: 0 }}>Уведомлений нет. Сюда придёт, если вам назначат баг или кейсы, упомянут через @логин, ответят в том, за чем вы следите.</p> : (
            <ul>
              {value.items.map((n) => (
                <li key={n.id} className={n.read ? "" : "unread"}>
                  <button type="button" onClick={() => go(n)}>
                    <span className="t">{n.title}</span>
                    {n.body && <span className="small muted b">{n.body}</span>}
                    <span className="small muted">{fmt(n.created)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {settings && <NotifySettings onClose={() => setSettings(false)} />}
    </div>
  );
}

function NotifySettings({ onClose }: { onClose: () => void }) {
  const { write } = useStore();
  const s = useLoad<Settings>("/api/notifications/settings").value;
  const [f, setF] = useState<Settings | null>(null);
  const cur = f || s;
  if (!cur) return null;
  const toggle = (k: string) => setF({ ...cur, off: cur.off.includes(k) ? cur.off.filter((x) => x !== k) : [...cur.off, k] });
  const save = async () => {
    if (await write(() => api("PUT", "/api/notifications/settings", { email: cur.email.trim(), emailOn: cur.emailOn, off: cur.off }), "Настройки уведомлений сохранены")) onClose();
  };
  return (
    <Modal onClose={onClose}>
      <h2>Уведомления</h2>
      <div className="field">
        <span className="label-like">О чём сообщать</span>
        <div className="done-list">
          {Object.entries(cur.kinds).map(([k, label]) => (
            <label key={k}><input type="checkbox" checked={!cur.off.includes(k)} onChange={() => toggle(k)} /> <span>{label}</span></label>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="nt-email">Почта</label>
        <input className="input" id="nt-email" type="email" value={cur.email} onChange={(e) => setF({ ...cur, email: e.target.value })} placeholder="ivanova@company.ru" />
        <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
          <input type="checkbox" checked={cur.emailOn} onChange={(e) => setF({ ...cur, emailOn: e.target.checked })} /> Дублировать уведомления письмом
        </label>
        {!cur.smtp && <span className="muted small">Отправка писем на сервере не настроена (SMTP) — уведомления будут только в приложении. Обратитесь к администратору.</span>}
      </div>
      <div className="acts">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={save}>Сохранить</button>
      </div>
    </Modal>
  );
}

// Кнопка «Следить» в карточке бага или кейса
export function WatchButton({ pid, kind, num }: { pid: string; kind: "bugs" | "cases"; num: number }) {
  const { write } = useStore();
  const base = `/api/projects/${encodeURIComponent(pid)}/watch`;
  const [tick, setTick] = useState(0);
  const { value } = useLoad<{ watching: boolean; watchers: number }>(`${base}?kind=${kind}&num=${num}&t=${tick}`);
  if (!value) return null;
  return (
    <button type="button" className={`btn sm${value.watching ? "" : " ghost"}`} aria-pressed={value.watching}
      title={value.watching ? "Вы получаете уведомления о комментариях и изменениях" : "Получать уведомления о комментариях и изменениях"}
      onClick={() => write(() => api("POST", base, { kind, num, watching: !value.watching }), value.watching ? "Вы больше не следите" : "Вы следите").then(() => setTick((x) => x + 1))}>
      {value.watching ? "★ Слежу" : "☆ Следить"}{value.watchers ? ` · ${value.watchers}` : ""}
    </button>
  );
}

// Подсказка логинов при вводе @ в комментарии: участники проекта
export function useMentionSuggest(pid: string | undefined, text: string, caret: number) {
  const data = useData();
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\w.-]{0,32})$/.exec(before);
  if (!pid || !m) return { list: [] as { login: string; name: string }[], start: -1 };
  const p = data.projects.find((x) => x.id === pid);
  const members = new Set(p?.members || []);
  const q = m[2].toLowerCase();
  const list = Object.entries(data.users)
    .filter(([login, u]) => (members.has(login) || u.role === "admin") && (login.toLowerCase().startsWith(q) || u.name.toLowerCase().includes(q)))
    .slice(0, 6).map(([login, u]) => ({ login, name: u.name }));
  return { list, start: before.length - m[2].length - 1 };
}
