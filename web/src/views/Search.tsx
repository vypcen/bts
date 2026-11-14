// Глобальный поиск (Ctrl+K / ⌘K): кейсы, баги, прогоны и автотесты во всех доступных проектах.
// Понимает ID («LK-12», «LK-B7», «LK-R3») и обычный текст с русской морфологией — ищет сервер (GET /api/search)
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { BUG_STATUSES, CASE_STATUSES, find } from "../labels";
import { go } from "../router";
import { Pill } from "../ui";

interface Hit { key: string; id: string; title: string; kind: string; route: (string | number)[]; pill?: { tone: any; label: string } }
interface SearchResult {
  cases: { id: string; pid: string; num: number; title: string; status: any; kind: string }[];
  bugs: { id: string; pid: string; num: number; title: string; status: any }[];
  runs: { id: string; pid: string; num: number; title: string; state: string; build: string }[];
  autotests: { id: number; pid: string; suite: string; name: string }[];
}

export function useSearchHotkey(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2 && !/^\d+$/.test(text)) {
      setHits([]);
      return;
    }
    const my = ++seq.current;
    setBusy(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await api<SearchResult>("GET", `/api/search?q=${encodeURIComponent(text)}`);
        if (my !== seq.current) return;
        setHits([
          ...r.cases.map((c) => ({ key: `c${c.id}`, id: c.id, title: c.title, kind: c.kind === "checklist" ? "Чек-лист" : "Кейс", route: ["p", c.pid, "cases", c.num], pill: find(CASE_STATUSES, c.status) })),
          ...r.bugs.map((b) => ({ key: `b${b.id}`, id: b.id, title: b.title, kind: "Баг", route: ["p", b.pid, "bugs", b.num], pill: find(BUG_STATUSES, b.status) })),
          ...r.runs.map((x) => ({ key: `r${x.id}`, id: x.id, title: x.title + (x.build ? ` · ${x.build}` : ""), kind: "Прогон", route: ["p", x.pid, "runs", x.num] })),
          ...r.autotests.map((a) => ({ key: `a${a.id}`, id: a.pid, title: [a.suite, a.name].filter(Boolean).join(" › "), kind: "Автотест", route: ["p", a.pid, "auto", "tests"] })),
        ]);
        setActive(0);
      } catch {
        if (my === seq.current) setHits([]);
      } finally {
        if (my === seq.current) setBusy(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const open = (h: Hit) => {
    go(...h.route);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && hits[active]) open(hits[active]);
  };

  return (
    <div className="modal search-modal">
      <div className="scrim" onClick={onClose} />
      <div className="box wide search-palette" role="dialog" aria-label="Поиск">
        <input className="input" autoFocus placeholder="Поиск: название, текст шагов или ID (LK-12, LK-B7)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          role="combobox" aria-expanded={hits.length > 0} aria-controls="search-hits" />
        <ul id="search-hits" role="listbox" className="search-hits">
          {hits.map((h, i) => (
            <li key={h.key} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => open(h)}>
              <span className="muted small" style={{ width: 70 }}>{h.kind}</span>
              <span className="mono small" style={{ width: 70 }}>{h.id}</span>
              <span className="title">{h.title}</span>
              {h.pill && <Pill tone={h.pill.tone} label={h.pill.label} sm />}
            </li>
          ))}
          {!hits.length && q.trim().length >= 2 && !busy && <li className="muted small">Ничего не найдено</li>}
        </ul>
        <div className="muted small">↑↓ — выбрать, Enter — открыть, Esc — закрыть</div>
      </div>
    </div>
  );
}
