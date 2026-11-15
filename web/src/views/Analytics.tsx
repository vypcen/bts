import { useEffect, useState, type ReactNode } from "react";
import { paths } from "../api";
import { BUG_STATUSES, find, SEVERITIES } from "../labels";
import { href } from "../router";
import { useLoad } from "../store";
import type { Analytics, Project, ResultValue } from "../types";
import { Empty, ResultBar, useNames } from "../ui";

// Подсказка у курсора для графиков
type Tip = { x: number; y: number; text: string } | null;
function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const on = (text: string) => ({
    onMouseMove: (e: { clientX: number; clientY: number }) => setTip({ x: e.clientX + 12, y: e.clientY + 12, text }),
    onMouseLeave: () => setTip(null),
  });
  const node = tip && <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>;
  return { on, node };
}

const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
const shortDay = (d: string) => d.slice(8, 10) + "." + d.slice(5, 7);

function Kpi({ value, label, hint }: { value: ReactNode; label: string; hint?: string }) {
  return (
    <div className="kpi" title={hint}>
      <span className="v">{value}</span>
      <span className="l">{label}</span>
    </div>
  );
}

function Panel({ title, children, legend }: { title: string; children: ReactNode; legend?: ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {legend}
      {children}
    </section>
  );
}

// Заведено / решено багов по дням: сгруппированные столбики, одна ось
function BugFlow({ flow, days }: { flow: Analytics["bugs"]["flow"]; days: number }) {
  const { on, node } = useTip();
  // все дни периода, включая пустые — иначе расстояния между столбиками врут
  const all: { day: string; created: number; resolved: number }[] = [];
  const byDay = new Map(flow.map((f) => [f.day, f]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    all.push(byDay.get(d) || { day: d, created: 0, resolved: 0 });
  }
  const max = Math.max(1, ...all.flatMap((d) => [d.created, d.resolved]));
  const W = 600, H = 160, pad = 24, bw = (W - pad) / all.length;
  const y = (v: number) => H - 18 - (v / max) * (H - 30);
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Заведено и решено багов по дням">
        <g className="grid">{ticks.map((t) => <line key={t} x1={pad} x2={W} y1={y(t)} y2={y(t)} />)}</g>
        {ticks.map((t) => <text key={t} x={0} y={y(t) + 4}>{t}</text>)}
        {all.map((d, i) => {
          const x = pad + i * bw;
          const w = Math.max(1, bw / 2 - 2);
          return (
            <g key={d.day} {...on(`${d.day}\nЗаведено: ${d.created}\nРешено: ${d.resolved}`)}>
              <rect className="hit" x={x} y={0} width={bw} height={H - 18} />
              {d.created > 0 && <rect x={x + 1} y={y(d.created)} width={w} height={H - 18 - y(d.created)} rx={2} fill="var(--s1)" />}
              {d.resolved > 0 && <rect x={x + 1 + w + 2} y={y(d.resolved)} width={w} height={H - 18 - y(d.resolved)} rx={2} fill="var(--s2)" />}
              {(i === 0 || i === all.length - 1 || i % Math.ceil(all.length / 6) === 0) && <text x={x} y={H - 4}>{shortDay(d.day)}</text>}
            </g>
          );
        })}
      </svg>
      {node}
    </>
  );
}

// Процент прохождения автотестов по запускам: одна линия с точками
function PassRateLine({ runs }: { runs: Analytics["auto"]["runs"] }) {
  const { on, node } = useTip();
  const pts = runs.filter((r) => r.passRate !== null);
  if (pts.length < 2) return <span className="muted small">Нужно хотя бы два завершённых запуска</span>;
  const W = 600, H = 160, pad = 32;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - pad - 8);
  const y = (v: number) => H - 18 - (v / 100) * (H - 30);
  const d = pts.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r.passRate!)}`).join(" ");
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Процент прохождения автотестов по запускам">
        <g className="grid">{[0, 50, 100].map((t) => <line key={t} x1={pad} x2={W} y1={y(t)} y2={y(t)} />)}</g>
        {[0, 50, 100].map((t) => <text key={t} x={0} y={y(t) + 4}>{t}%</text>)}
        <path d={d} fill="none" stroke="var(--s1)" strokeWidth={2} strokeLinejoin="round" />
        {pts.map((r, i) => (
          <g key={r.num} {...on(`A${r.num} · ${r.title}\n${r.passRate}% прошло из ${r.total}${r.flaky ? `\nНестабильных: ${r.flaky}` : ""}`)}>
            <circle cx={x(i)} cy={y(r.passRate!)} r={12} className="hit" />
            <circle cx={x(i)} cy={y(r.passRate!)} r={4} fill="var(--s1)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        ))}
        <text x={x(0)} y={H - 4}>A{pts[0].num}</text>
        <text x={x(pts.length - 1) - 24} y={H - 4}>A{pts[pts.length - 1].num}</text>
      </svg>
      {node}
    </>
  );
}

function MiniBar({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div className="minibar">
      <div className="track"><span style={{ width: `${max ? (value / max) * 100 : 0}%` }} /></div>
      <span className="mono small" style={{ minWidth: 56, textAlign: "right" }}>{label}</span>
    </div>
  );
}

export function AnalyticsTab({ project }: { project: Project }) {
  const [days, setDays] = useState(30);
  const nameOf = useNames();
  // nonce — перезапросить; fresh — пересчитать сразу (кнопка «Пересчитать»)
  const [nonce, setNonce] = useState(0);
  const [fresh, setFresh] = useState(false);
  const { value: a, error } = useLoad<Analytics>(`${paths.analytics(project.id, days)}${fresh ? "&fresh=1" : ""}${nonce ? `&n=${nonce}` : ""}`);
  // данные устарели и пересчитываются в фоне — заберём новые через несколько секунд
  useEffect(() => {
    if (!a?.refreshing) return;
    const t = setTimeout(() => {
      setFresh(false);
      setNonce((n) => n + 1);
    }, 4000);
    return () => clearTimeout(t);
  }, [a]);
  const p = project.id;

  if (error && !a) return <div className="banner">Не удалось загрузить аналитику: {error}</div>;
  if (!a) return <div className="skel">Считаем показатели…</div>;

  const openBugs = a.bugs.open.reduce((s, b) => s + b.n, 0);
  const sevRows = SEVERITIES.map((s) => ({ s, n: a.bugs.open.filter((b) => b.severity === s.key).reduce((x, b) => x + b.n, 0) }));
  const maxSev = Math.max(1, ...sevRows.map((r) => r.n));
  const statuses = [...new Set(a.bugs.open.map((b) => b.status))];
  const maxFail = Math.max(1, ...a.auto.topFailing.map((t) => t.fails));
  const maxLoad = Math.max(1, ...a.workload.map((w) => w.todo + w.done));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="toolbar">
        <label className="small muted" htmlFor="an-days">Период</label>
        <select id="an-days" className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} дней</option>)}
        </select>
        {a.computedAt && (
          <span className="small muted" style={{ marginLeft: "auto" }} title="Аналитика считается заранее и обновляется автоматически">
            {a.refreshing ? "Обновляем… " : ""}данные на {new Date(a.computedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <button className="btn ghost sm" onClick={() => { setFresh(true); setNonce((n) => n + 1); }}>Пересчитать</button>
      </div>

      <div className="kpis">
        <Kpi value={a.cases.total} label={`тест-кейсов · готово ${a.cases.ready}`} />
        <Kpi value={pct(a.coverage.executedPct)} label={`готовых кейсов проверено за ${days} дн.`} hint={`Проверено ${a.coverage.executed} разных кейсов`} />
        <Kpi value={pct(a.coverage.automatedPct)} label="кейсов покрыто автотестами" hint={`${a.cases.automated} кейсов связаны с автотестами`} />
        <Kpi value={openBugs} label="открытых багов" />
        <Kpi value={pct(a.auto.lastPassRate)} label="прошло в последнем запуске автотестов" />
        <Kpi value={a.auto.flaky.length} label="нестабильных автотестов" />
      </div>

      <div className="panels">
        <Panel title="Последние прогоны">
          {a.runs.length ? (
            <div className="history">
              {[...a.runs].reverse().slice(0, 10).map((r) => (
                <div key={r.num}>
                  <a className="chip" href={href("p", p, "runs", r.num)}>R{r.num}</a>
                  <span style={{ flex: 1, minWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                  <span style={{ width: 140 }}><ResultBar counts={r.counts as Record<ResultValue, number>} title={`Пройдено ${r.counts.passed}, упало ${r.counts.failed}, заблокировано ${r.counts.blocked}, не проверено ${r.counts.untested}`} /></span>
                  <span className="mono small" style={{ width: 48, textAlign: "right" }}>{pct(r.passRate)}</span>
                </div>
              ))}
            </div>
          ) : <span className="muted small">Прогонов пока нет</span>}
        </Panel>

        <Panel title={`Баги: заведено и решено за ${days} дн.`}
          legend={<div className="legend"><span><i style={{ background: "var(--s1)" }} />Заведено</span><span><i style={{ background: "var(--s2)" }} />Решено (проверен, закрыт, отклонён)</span></div>}>
          <BugFlow flow={a.bugs.flow} days={Math.min(days, 60)} />
        </Panel>

        <Panel title="Открытые баги по серьёзности">
          {openBugs ? (
            <div style={{ overflowX: "auto" }}><table>
              <thead><tr><th>Серьёзность</th><th style={{ width: "40%" }} />{statuses.map((s) => <th key={s} className="small">{find(BUG_STATUSES, s).label}</th>)}</tr></thead>
              <tbody>
                {sevRows.map(({ s, n }) => (
                  <tr key={s.key}>
                    <td>{s.label}</td>
                    <td><MiniBar value={n} max={maxSev} label={String(n)} /></td>
                    {statuses.map((st) => <td key={st} className="mono small">{a.bugs.open.find((b) => b.severity === s.key && b.status === st)?.n || "—"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <span className="muted small">Открытых багов нет</span>}
        </Panel>

        <Panel title="Автотесты: процент прохождения по запускам">
          <PassRateLine runs={a.auto.runs} />
        </Panel>

        <Panel title={`Чаще всего падают (за ${days} дн.)`}>
          {a.auto.topFailing.length ? a.auto.topFailing.map((t) => (
            <div key={t.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="small" style={{ overflowWrap: "anywhere" }}>{t.name} <span className="muted">· {t.suite}</span></span>
              <MiniBar value={t.fails} max={maxFail} label={`${t.fails} из ${t.runs}`} />
            </div>
          )) : <span className="muted small">Падений нет</span>}
        </Panel>

        <Panel title="Нестабильные автотесты">
          {a.auto.flaky.length ? (
            <div className="history">
              {a.auto.flaky.map((t) => (
                <div key={t.id} style={{ alignItems: "flex-start" }}>
                  <span className="mono small" style={{ width: 40 }}>{Math.round(t.score * 100)}%</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="small">{t.name}</span> {t.quarantined && <span className="tag">карантин</span>}
                    <div className="muted small">{t.reason}</div>
                  </span>
                </div>
              ))}
              <a className="small" href={href("p", p, "auto", "tests")}>Все автотесты →</a>
            </div>
          ) : <span className="muted small">Нестабильных тестов не найдено</span>}
        </Panel>

        <Panel title="Нагрузка исполнителей в открытых прогонах">
          {a.workload.length ? a.workload.map((w) => (
            <div key={w.login} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="small">{nameOf(w.login)}</span>
              <MiniBar value={w.done} max={w.todo + w.done || maxLoad} label={`${w.done} / ${w.todo + w.done}`} />
            </div>
          )) : <span className="muted small">В открытых прогонах кейсы никому не назначены</span>}
        </Panel>
      </div>
      {!a.cases.total && <Empty title="Данных пока мало">Аналитика наполнится, когда появятся кейсы, прогоны и запуски автотестов.</Empty>}
    </div>
  );
}
