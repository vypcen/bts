// H-04: матрица покрытия «требования × тест-кейсы × результаты» со срезом по релизу или прогону и выгрузкой
import { useState } from "react";
import { go } from "../router";
import { useLoad } from "../store";
import type { Priority, ResultValue } from "../types";
import { Empty, fmt, Pill } from "../ui";
import { useReleases } from "./Releases";
import { COVERAGE, type Coverage, type ReqStatus } from "./Requirements";

interface MatrixCase {
  num: number; title: string; priority: Priority; inScope: boolean; result: ResultValue; run: number | null; executed: number | null; executor: string | null;
  bugs: { num: number; title: string; severity: string }[];
}
interface Matrix {
  scope: { kind: "latest" | "release" | "run"; num: number | null; label: string };
  requirements: { num: number; title: string; extRef: string; status: ReqStatus; coverage: Coverage; cases: number[]; openBugs: number }[];
  cases: MatrixCase[];
  summary: Record<Coverage, number> & { total: number; coveredPct: number; passedPct: number; casesLinked: number; casesUnlinked: number | null };
}

const CELL: Record<ResultValue, { mark: string; bg: string; fg: string; label: string }> = {
  passed: { mark: "✓", bg: "var(--ok)", fg: "#fff", label: "Пройден" },
  failed: { mark: "✗", bg: "var(--crit)", fg: "#fff", label: "Упал" },
  blocked: { mark: "Б", bg: "var(--warn)", fg: "#fff", label: "Заблокирован" },
  skipped: { mark: "П", bg: "var(--neutral-soft)", fg: "var(--fg)", label: "Пропущен" },
  untested: { mark: "·", bg: "var(--neutral-soft)", fg: "var(--muted)", label: "Не проверен" },
};
const covOf = (c: Coverage) => COVERAGE.find((x) => x.key === c)!;

export function CoverageMatrix({ pid }: { pid: string }) {
  const [kind, setKind] = useState<"latest" | "release" | "run">("latest");
  const [release, setRelease] = useState("");
  const [run, setRun] = useState("");
  const [obsolete, setObsolete] = useState(false);
  const releases = useReleases(pid).filter((r) => r.status !== "cancelled");
  const qs = new URLSearchParams();
  if (kind === "release" && release) qs.set("release", release);
  if (kind === "run" && Number(run) > 0) qs.set("run", run);
  if (obsolete) qs.set("obsolete", "1");
  const base = `/api/projects/${encodeURIComponent(pid)}/requirements/matrix`;
  const ready = kind === "latest" || (kind === "release" && release) || (kind === "run" && Number(run) > 0);
  const { value: m, error } = useLoad<Matrix>(ready ? `${base}?${qs}` : null);
  const exp = (format: string) => `${base}/export?${new URLSearchParams({ ...Object.fromEntries(qs), format })}`;

  return (
    <section>
      <div className="toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <select className="input" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Срез результатов">
          <option value="latest">Последние результаты</option>
          <option value="release">Результаты в релизе</option>
          <option value="run">Результаты прогона</option>
        </select>
        {kind === "release" && (
          <select className="input" style={{ width: "auto" }} value={release} onChange={(e) => setRelease(e.target.value)} aria-label="Релиз">
            <option value="">Выберите релиз…</option>
            {releases.filter((r) => !r.parent).map((r) => [
              <option key={r.num} value={r.num}>{r.name}</option>,
              ...releases.filter((s) => s.parent === r.num).map((s) => <option key={s.num} value={s.num}>   └ {s.name}</option>),
            ])}
          </select>
        )}
        {kind === "run" && (
          <input className="input" style={{ width: 130 }} type="number" min={1} placeholder="№ прогона" value={run} onChange={(e) => setRun(e.target.value)} aria-label="Номер прогона" />
        )}
        <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={obsolete} onChange={(e) => setObsolete(e.target.checked)} /> с устаревшими
        </label>
        <div style={{ flex: 1 }} />
        {m && (
          <>
            <a className="btn" href={exp("xlsx")} download>Excel</a>
            <a className="btn" href={exp("pdf")} download>PDF</a>
            <a className="btn ghost" href={exp("csv")} download>CSV</a>
          </>
        )}
      </div>
      {error ? <div className="banner">{error}</div>
        : !ready ? <Empty title="Выберите срез">{kind === "release" ? "Укажите релиз: в матрице будут результаты его прогонов и спринтов." : "Укажите номер прогона."}</Empty>
        : !m ? <div className="skel">Собираем матрицу…</div>
        : <MatrixView pid={pid} m={m} />}
    </section>
  );
}

function MatrixView({ pid, m }: { pid: string; m: Matrix }) {
  const s = m.summary;
  const byNum = new Map(m.cases.map((c) => [c.num, c]));
  if (!m.requirements.length) return <Empty title="Требований нет">Заведите требования и свяжите их с тест-кейсами.</Empty>;
  return (
    <>
      <div className="card" style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <span className="muted small">{m.scope.label}</span>
        <span>Требований: <b>{s.total}</b></span>
        <span>Покрыто тестами: <b>{s.coveredPct}%</b></span>
        <span>Пройдено полностью: <b>{s.passedPct}%</b></span>
        {COVERAGE.map((c) => <Pill key={c.key} tone={c.tone} label={`${c.label}: ${s[c.key] || 0}`} sm />)}
        {!!s.casesUnlinked && <span className="small muted" title="Тест-кейсы, не связанные ни с одним требованием">Кейсов без требований: {s.casesUnlinked}</span>}
      </div>
      <div className="tbl-wrap card" style={{ padding: 0 }}>
        <table className="tbl cov-matrix" aria-label="Матрица покрытия">
          <thead>
            <tr>
              <th className="cov-sticky">Требование</th>
              <th>Покрытие</th>
              {m.cases.map((c) => (
                <th key={c.num} className="cov-col" title={`${pid}-${c.num} ${c.title}`}>
                  <a href="#" onClick={(e) => { e.preventDefault(); go("p", pid, "cases", c.num); }}><span>{pid}-{c.num}</span></a>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.requirements.map((r) => (
              <tr key={r.num}>
                <td className="cov-sticky">
                  <a href="#" onClick={(e) => { e.preventDefault(); go("p", pid, "reqs", r.num); }} className="mono small">{pid}-REQ{r.num}</a>{" "}
                  <span className="small">{r.title}</span>
                  {r.openBugs > 0 && <span className="small t-crit" title="Открытые баги по кейсам требования"> · багов {r.openBugs}</span>}
                </td>
                <td title={covOf(r.coverage).hint}><Pill tone={covOf(r.coverage).tone} label={covOf(r.coverage).label} sm /></td>
                {m.cases.map((c) => {
                  if (!r.cases.includes(c.num)) return <td key={c.num} className="cov-cell" />;
                  const k = byNum.get(c.num)!;
                  const st = k.inScope ? CELL[k.result] : { mark: "—", bg: "transparent", fg: "var(--muted)", label: "вне среза" };
                  const tip = `${pid}-${k.num} ${k.title}\n${st.label}${k.run ? ` · прогон ${pid}-R${k.run}` : ""}${k.executed ? ` · ${fmt(k.executed)}` : ""}${k.executor ? ` · ${k.executor}` : ""}${k.bugs.length ? `\nОткрытые баги: ${k.bugs.map((b) => `${pid}-B${b.num}`).join(", ")}` : ""}`;
                  return (
                    <td key={c.num} className="cov-cell">
                      <span className="cov-mark" style={{ background: st.bg, color: st.fg }} title={tip} aria-label={`${pid}-${k.num}: ${st.label}`}>{st.mark}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">✓ пройден · ✗ упал · Б заблокирован · П пропущен · «·» не проверен · «—» кейс не попал в выбранный релиз или прогон. Наведите на клетку — прогон, дата, исполнитель и баги.</p>
    </>
  );
}
