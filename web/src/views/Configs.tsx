// Конфигурации (E-02): справочник групп (браузер, ОС, устройство, стенд), выбор конфигураций для прогона по плану,
// конфигурация прогона и сводная матрица «кейс × конфигурация»
import { useState } from "react";
import { api } from "../api";
import { href } from "../router";
import { useLoad, useStore } from "../store";
import type { ConfigGroup, ResultValue } from "../types";
import { Confirm, Modal, ResultPill } from "../ui";

const url = (pid: string) => `/api/projects/${encodeURIComponent(pid)}/configs`;
type Config = Record<string, string>;

export function useConfigs(pid: string): ConfigGroup[] {
  return useLoad<{ groups: ConfigGroup[] }>(url(pid)).value?.groups || [];
}

export const configLabel = (cfg: Config | null | undefined, groups: ConfigGroup[] = []) => {
  if (!cfg) return "";
  const order = groups.map((g) => g.name);
  return [...order.filter((g) => g in cfg), ...Object.keys(cfg).filter((g) => !order.includes(g))].map((g) => cfg[g]).join(", ");
};

// все сочетания выбранных вариантов: группа без выбранных вариантов не участвует
export function combos(groups: ConfigGroup[], picked: Record<string, string[]>): Config[] {
  let out: Config[] = [{}];
  for (const g of groups) {
    const opts = picked[g.name] || [];
    if (!opts.length) continue;
    out = out.flatMap((c) => opts.map((o) => ({ ...c, [g.name]: o })));
  }
  return out.filter((c) => Object.keys(c).length);
}

// Справочник во вкладке «Настройки»
export function ConfigsSettings({ pid }: { pid: string }) {
  const groups = useConfigs(pid);
  const { write } = useStore();
  const [name, setName] = useState("");
  const [opts, setOpts] = useState("");
  const [del, setDel] = useState<ConfigGroup | null>(null);
  const split = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const add = async () => {
    if (await write(() => api("POST", url(pid), { name: name.trim(), options: split(opts) }), `Группа «${name.trim()}» добавлена`)) { setName(""); setOpts(""); }
  };
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Конфигурации</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Окружения, на которых проверяете: браузеры, ОС, устройства, стенды. Прогон по плану можно запустить сразу на несколько конфигураций —
        получится по прогону на каждую и общая матрица результатов.
      </p>
      {groups.map((g) => <GroupRow key={g.id} pid={pid} g={g} onDelete={() => setDel(g)} />)}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor="cfg-name">Группа</label><input className="input" id="cfg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Браузер" /></div>
        <div className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}><label htmlFor="cfg-opts">Варианты через запятую</label>
          <input className="input" id="cfg-opts" value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="Chrome, Firefox, Safari" /></div>
        <button className="btn" disabled={!name.trim() || !split(opts).length} onClick={add}>+ Группа</button>
      </div>
      {del && (
        <Confirm title={`Удалить группу «${del.name}»?`} text="У уже созданных прогонов конфигурация останется как была." action="Удалить"
          onClose={() => setDel(null)} onYes={async () => { const g = del; setDel(null); await write(() => api("DELETE", `${url(pid)}/${g.id}`), "Группа удалена"); }} />
      )}
    </section>
  );
}

function GroupRow({ pid, g, onDelete }: { pid: string; g: ConfigGroup; onDelete: () => void }) {
  const { write } = useStore();
  const [text, setText] = useState(g.options.join(", "));
  const save = () => {
    const options = text.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
    if (options.join("|") !== g.options.join("|")) write(() => api("PATCH", `${url(pid)}/${g.id}`, { options }), `Варианты «${g.name}» сохранены`);
  };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
      <b style={{ minWidth: 120 }}>{g.name}</b>
      <input className="input" style={{ flex: 1, minWidth: 220 }} aria-label={`Варианты: ${g.name}`} value={text} onChange={(e) => setText(e.target.value)} onBlur={save} />
      <button className="btn ghost sm" style={{ color: "var(--crit)" }} aria-label={`Удалить группу ${g.name}`} onClick={onDelete}>✕</button>
    </div>
  );
}

// Выбор конфигураций для прогона по плану: отмеченные варианты перемножаются
export function ConfigPicker({ pid, picked, onChange }: { pid: string; picked: Record<string, string[]>; onChange: (p: Record<string, string[]>) => void }) {
  const groups = useConfigs(pid);
  if (!groups.length) return null;
  const list = combos(groups, picked);
  const toggle = (g: string, o: string) => {
    const cur = new Set(picked[g] || []);
    cur.has(o) ? cur.delete(o) : cur.add(o);
    onChange({ ...picked, [g]: [...cur] });
  };
  return (
    <div className="field">
      <span className="label-like">Конфигурации</span>
      {groups.map((g) => (
        <div key={g.id} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 4 }}>
          <span className="small muted" style={{ minWidth: 90 }}>{g.name}</span>
          {g.options.map((o) => (
            <label key={o} className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={(picked[g.name] || []).includes(o)} onChange={() => toggle(g.name, o)} /> {o}
            </label>
          ))}
        </div>
      ))}
      <span className="muted" style={{ fontSize: 12 }}>
        {list.length > 1 ? `Будет создано прогонов: ${list.length} — ${list.map((c) => configLabel(c, groups)).join("; ")}` : list.length === 1 ? `Один прогон на ${configLabel(list[0], groups)}` : "Без конфигурации — один прогон"}
        {list.length > 50 && " · больше 50 за раз нельзя"}
      </span>
    </div>
  );
}

// Конфигурация обычного прогона: по варианту из каждой группы (можно не выбирать)
export function ConfigSelect({ pid, value, onChange }: { pid: string; value: Config; onChange: (v: Config) => void }) {
  const groups = useConfigs(pid);
  if (!groups.length) return null;
  return (
    <div className="field">
      <span className="label-like">Конфигурация</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {groups.map((g) => (
          <select key={g.id} className="input" style={{ width: "auto" }} aria-label={g.name} value={value[g.name] || ""}
            onChange={(e) => { const v = { ...value }; if (e.target.value) v[g.name] = e.target.value; else delete v[g.name]; onChange(v); }}>
            <option value="">{g.name}: любой</option>
            {g.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ))}
      </div>
    </div>
  );
}

export function ConfigChips({ cfg, groups }: { cfg?: Config | null; groups: ConfigGroup[] }) {
  if (!cfg || !Object.keys(cfg).length) return null;
  const order = groups.map((g) => g.name);
  const keys = [...order.filter((g) => g in cfg), ...Object.keys(cfg).filter((g) => !order.includes(g))];
  return <span className="chips">{keys.map((k) => <span key={k} className="chip" title={k}>{cfg[k]}</span>)}</span>;
}

interface Matrix {
  runs: { num: number; title: string; state: string; label: string; counts: Partial<Record<ResultValue, number>> }[];
  cases: { num: number; title: string; results: Record<string, ResultValue> }[];
}

// Сводная матрица пачки прогонов
export function MatrixModal({ pid, batch, onClose }: { pid: string; batch: string; onClose: () => void }) {
  const m = useLoad<Matrix>(`/api/projects/${encodeURIComponent(pid)}/runs/matrix/${batch}`).value;
  return (
    <Modal onClose={onClose} wide>
      <h2>Матрица конфигураций</h2>
      {!m ? <p className="muted">Загрузка…</p> : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Кейс</th>
                {m.runs.map((r) => (
                  <th key={r.num} style={{ textTransform: "none" }}>
                    <a href={href("p", pid, "runs", r.num)}>{r.label || `R${r.num}`}</a>
                    <div className="small muted" style={{ fontWeight: 400 }}>
                      {(() => { const t = Object.values(r.counts || {}).reduce((a, b) => a + (b || 0), 0); const u = r.counts?.untested || 0; return `${t - u}/${t}${r.counts?.failed ? ` · упало ${r.counts.failed}` : ""}`; })()}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.cases.map((c) => (
                <tr key={c.num}>
                  <td className="title"><span className="mono small muted">{pid}-{c.num}</span> {c.title}</td>
                  {m.runs.map((r) => <td key={r.num}>{c.results[r.num] ? <ResultPill r={c.results[r.num]} sm /> : <span className="muted">—</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="acts"><button className="btn" onClick={onClose}>Закрыть</button></div>
    </Modal>
  );
}
