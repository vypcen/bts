import { useEffect, useState, type FormEvent } from "react";
import { AiBar, useAi, useAiReady } from "../ai";
import { api, paths } from "../api";
import { AUTO_STATUSES, find } from "../labels";
import { go, href } from "../router";
import { useCanEdit, useData, useLoad, useStore } from "../store";
import type { Attachment, AutoResult, AutoRun, AutoStatus, AutoStep, AutoTest, Project } from "../types";
import { Confirm, Drawer, Empty, fmt, Modal, Pill, ResultBar } from "../ui";
import { Attachments } from "./Attachments";
import { BugEditor, type BugDraft } from "./Bugs";

const isProblem = (s: AutoStatus) => s === "failed" || s === "broken";

export const fmtDuration = (ms: number) =>
  ms < 1000 ? `${ms} мс` : ms < 60000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.floor(ms / 60000)} мин ${Math.round((ms % 60000) / 1000)} с`;

function AutoPill({ s, sm }: { s: AutoStatus; sm?: boolean }) {
  const d = find(AUTO_STATUSES, s);
  return <Pill tone={d.tone} label={d.label} sm={sm} />;
}

// Самый глубокий упавший шаг — на нём тест и упал. Путь от верхнего шага до него
function failedPath(steps: AutoStep[]): AutoStep[] {
  const s = steps.find((x) => x.status === "failed");
  return s ? [s, ...failedPath(s.steps)] : [];
}

const STEP_MARK = { passed: { icon: "✓", color: "var(--ok)" }, failed: { icon: "✕", color: "var(--crit)" }, skipped: { icon: "–", color: "var(--muted)" } };

// Дерево шагов: у результата со статусами и временем, в реестре — только названия
function StepList({ steps, depth = 0 }: { steps: (AutoStep | { title: string; steps: any[] })[]; depth?: number }) {
  return (
    <ol style={{ margin: 0, paddingLeft: depth ? 18 : 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
      {steps.map((s, i) => {
        const st = "status" in s ? (s as AutoStep) : null;
        // родительские шаги упавшего тоже помечены failed — подсвечиваем только сам шаг падения
        const failedHere = st?.status === "failed" && !st.steps.some((c) => c.status === "failed");
        const mark = st && STEP_MARK[st.status];
        return (
          <li key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div className="small" style={{ display: "flex", gap: 8, alignItems: "baseline", fontWeight: failedHere ? 600 : 400, color: failedHere ? "var(--crit)" : undefined }}>
              <span className="mono" style={{ width: 16, flex: "none", textAlign: "center", color: mark?.color ?? "var(--muted)" }}>{mark ? mark.icon : `${i + 1}.`}</span>
              <span style={{ flex: 1, overflowWrap: "anywhere" }}>{s.title}</span>
              {st && <span className="muted mono" style={{ flex: "none" }}>{fmtDuration(st.durationMs)}</span>}
            </div>
            {failedHere && st.error && <div className="small" style={{ marginLeft: 24, color: "var(--crit)", overflowWrap: "anywhere" }}>{st.error}</div>}
            {s.steps.length > 0 && <StepList steps={s.steps} depth={depth + 1} />}
          </li>
        );
      })}
    </ol>
  );
}

// Строка «что запущено · окружение · адрес» для списка запусков и шапки запуска
function RunMeta({ r }: { r: AutoRun }) {
  const parts = [
    r.scope && <span key="s">Запущено: <span className="mono">{r.scope}</span></span>,
    r.env && <span key="e">Окружение: {r.env}</span>,
    r.url && <span key="u" className="mono" style={{ overflowWrap: "anywhere" }}>{r.url}</span>,
  ].filter(Boolean);
  return <>{parts.map((x, i) => <span key={i}>{i > 0 && " · "}{x}</span>)}</>;
}

// ResultBar рисует полосу по статусам ручных прогонов: «сломан» показываем цветом «заблокирован»
const barCounts = (c: Record<AutoStatus, number>) => ({ passed: c.passed, failed: c.failed, blocked: c.broken, skipped: c.skipped, untested: 0 });
const total = (c: Record<AutoStatus, number>) => c.passed + c.failed + c.broken + c.skipped;

export function AutotestsTab({ project, view }: { project: Project; view: "runs" | "tests" }) {
  const data = useData();
  const canEdit = useCanEdit();
  const p = project.id;
  const [connect, setConnect] = useState(false);
  const runs = data.autoruns.filter((r) => r.pid === p).sort((a, b) => b.num - a.num);

  return (
    <>
      <div className="head">
        <div className="tabs" role="tablist" style={{ width: 260 }}>
          <button role="tab" aria-selected={view === "runs"} onClick={() => go("p", p, "auto")}>Запуски</button>
          <button role="tab" aria-selected={view === "tests"} onClick={() => go("p", p, "auto", "tests")}>Все автотесты</button>
        </div>
        <div className="spacer" />
        {canEdit && <button className="btn primary" onClick={() => setConnect(true)}>Подключить автотесты</button>}
      </div>
      {view === "tests" ? (
        <TestsRegistry project={project} />
      ) : runs.length === 0 ? (
        <Empty title="Запусков автотестов пока нет">
          Каждый запуск тестов на вашем компьютере или в CI появится здесь отдельной папкой: что прошло, что упало, скриншоты падений.
          {canEdit && <button className="btn primary" onClick={() => setConnect(true)}>Подключить автотесты</button>}
        </Empty>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>ID</th><th>Запуск</th><th style={{ width: 210 }}>Результат</th>
                <th style={{ width: 110 }}>Длительность</th><th style={{ width: 150 }}>Когда</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => <RunRow key={r.id} r={r} />)}
            </tbody>
          </table>
        </div>
      )}
      {connect && <ConnectModal pid={p} onClose={() => setConnect(false)} />}
    </>
  );
}

function RunRow({ r }: { r: AutoRun }) {
  const c = r.counts;
  const bad = c.failed + c.broken;
  return (
    <tr className="click" onClick={() => go("p", r.pid, "auto", r.num)}>
      <td className="id"><a href={href("p", r.pid, "auto", r.num)} style={{ color: "inherit" }}>{r.id}</a></td>
      <td className="title">
        {r.title}
        <div className="muted small" style={{ fontWeight: 400 }}><RunMeta r={r} /></div>
      </td>
      <td>
        <ResultBar counts={barCounts(c)} />
        <div className="muted small mono" style={{ marginTop: 4 }}>
          {c.passed}/{total(c)}
          {bad ? <span style={{ color: "var(--crit)" }}> · упало {bad}</span> : null}
          {r.state === "running" && <span style={{ color: "var(--info)" }}> · идёт…</span>}
        </div>
      </td>
      <td className="mono small">{r.state === "running" ? "—" : fmtDuration(r.durationMs)}</td>
      <td className="small">{fmt(r.created)}</td>
    </tr>
  );
}

// ---------- страница запуска ----------
type Filter = "all" | "problems" | AutoStatus;

export function AutoRunPage({ project, num }: { project: Project; num: number }) {
  const data = useData();
  const { write, liveError } = useStore();
  const canEdit = useCanEdit();
  const p = project.id;
  const run = data.autoruns.find((r) => r.pid === p && r.num === num);
  const { value, error } = useLoad<{ results: AutoResult[]; attachments: Attachment[] }>(paths.autorun(p, num));
  const [filter, setFilter] = useState<Filter | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [modal, setModal] = useState<"edit" | "delete" | null>(null);
  const [bugDraft, setBugDraft] = useState<BugDraft | null>(null);

  if (!run) {
    return (
      <main className="wrap">
        <div className="banner">Запуск {p}-A{num} не найден: возможно, его удалили.</div>
        <a href={href("p", p, "auto")}>← К запускам автотестов</a>
      </main>
    );
  }

  const c = run.counts;
  const bad = c.failed + c.broken;
  // если что-то упало, сразу показываем именно это
  const f: Filter = filter ?? (bad ? "problems" : "all");
  const results = value?.results || [];
  const needle = q.trim().toLowerCase();
  const rows = results.filter(
    (r) =>
      (f === "all" || (f === "problems" ? isProblem(r.status) : r.status === f)) &&
      (!needle || r.name.toLowerCase().includes(needle) || r.suite.toLowerCase().includes(needle) || r.message.toLowerCase().includes(needle))
  );
  const filesOf = (r: AutoResult) => (value?.attachments || []).filter((a) => a.autoResultId === r.id);
  const sel = selected !== null ? results.find((r) => r.id === selected) : undefined;

  const chip = (k: Filter, label: string, n: number, tone?: string) => (
    <button key={k} className="stat" aria-pressed={f === k} onClick={() => setFilter(k)}>
      {tone && <span className={`pill t-${tone}`} style={{ padding: "2px 4px" }}><span className="dot" /></span>}
      <span>{label}</span><span className="n">{n}</span>
    </button>
  );

  return (
    <main className="wrap">
      {liveError && <div className="banner">{liveError}</div>}
      <a href={href("p", p, "auto")} className="small">← Автотесты проекта {project.name}</a>
      <div className="head">
        <div>
          <span className="label">{run.id}</span>
          <h1>{run.title}</h1>
          <p className="muted">
            {(run.scope || run.env || run.url) && <><RunMeta r={run} /><br /></>}
            {fmt(run.created)}{run.state === "finished" && <> · {fmtDuration(run.durationMs)}</>}
          </p>
        </div>
        <div className="spacer" />
        <div className="acts">
          {run.state === "running" ? <Pill tone="info" label="Идёт" /> : bad ? <Pill tone="crit" label={`Упало ${bad}`} /> : <Pill tone="ok" label="Всё прошло" />}
          {canEdit && <button className="btn" onClick={() => setModal("edit")}>Параметры</button>}
          {canEdit && <button className="btn danger" onClick={() => setModal("delete")} aria-label="Удалить запуск">✕</button>}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <ResultBar counts={barCounts(c)} />
        <span className="muted small">Пройдено {c.passed} из {total(c)}</span>
      </div>
      <div className="stats">
        {chip("all", "Все", total(c))}
        {bad > 0 && chip("problems", "Упавшие и сломанные", bad, "crit")}
        {AUTO_STATUSES.map((s) => chip(s.key, s.label, c[s.key], s.tone))}
      </div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Поиск по названию, набору или тексту ошибки" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && !value && <div className="banner">Не удалось загрузить результаты: {error}</div>}
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 120 }}>Статус</th><th>Тест</th><th style={{ width: 100 }}>Время</th>
              <th style={{ width: 120 }} title="Статус в предыдущем запуске, где был этот тест">Ранее</th><th style={{ width: 70 }}>Файлы</th>
            </tr>
          </thead>
          <tbody>
            {!value && !error && <tr><td colSpan={5} className="nores">Загружаем результаты…</td></tr>}
            {rows.map((r) => {
              const files = filesOf(r).length;
              const regress = r.prev?.status === "passed" && isProblem(r.status);
              const failedAt = failedPath(r.steps).map((s) => s.title).join(" › ");
              return (
                <tr key={r.id} className="click" aria-selected={selected === r.id} onClick={() => setSelected(r.id)}>
                  <td><AutoPill s={r.status} /></td>
                  <td className="title">
                    {r.name}
                    {r.suite && <div className="muted small mono" style={{ fontWeight: 400, overflowWrap: "anywhere" }}>{r.suite}</div>}
                    {r.message && (
                      <div className="small" style={{ fontWeight: 400, color: isProblem(r.status) ? "var(--crit)" : r.status === "passed" ? "var(--warn)" : "var(--muted)", overflowWrap: "anywhere" }}>
                        {r.message.slice(0, 200)}
                      </div>
                    )}
                    {failedAt && <div className="small" style={{ fontWeight: 400, overflowWrap: "anywhere" }}>Упал на шаге: <b>{failedAt}</b></div>}
                  </td>
                  <td className="mono small">{fmtDuration(r.durationMs)}</td>
                  <td className="nowrap">
                    {r.prev ? <span title={`${p}-A${r.prev.runNum}`}><AutoPill s={r.prev.status} sm /> <span className="muted small mono">A{r.prev.runNum}</span></span> : <span className="muted small">новый</span>}
                    {regress && <div className="small" style={{ color: "var(--crit)", fontWeight: 600 }}>Регресс</div>}
                  </td>
                  <td className="mono small">{files ? `📎 ${files}` : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
            {value && !rows.length && <tr><td colSpan={5} className="nores">{results.length ? "Ничего не найдено." : "Результаты ещё не пришли."}</td></tr>}
          </tbody>
        </table>
      </div>

      {bugDraft ? (
        <BugEditor pid={p} draft={bugDraft} onClose={() => setBugDraft(null)} />
      ) : sel ? (
        <AutoResultDrawer key={sel.id} run={run} r={sel} files={filesOf(sel)} onClose={() => setSelected(null)} onBug={setBugDraft} />
      ) : null}
      {modal === "edit" && <AutoRunModal run={run} onClose={() => setModal(null)} />}
      {modal === "delete" && (
        <Confirm
          title={`Удалить запуск ${run.id}?`}
          text={`Будут удалены ${total(c)} результатов и скриншоты к ним. Сами автотесты останутся в реестре.`}
          onClose={() => setModal(null)}
          onYes={async () => {
            setModal(null);
            if (await write(() => api("DELETE", paths.autorun(p, num), {}), "Запуск удалён")) go("p", p, "auto");
          }}
        />
      )}
    </main>
  );
}

// Шаги в баг текстом: «1. Шаг», вложенные с отступом, упавший помечен
function stepLines(steps: AutoStep[], prefix = ""): string[] {
  return steps.flatMap((s, i) => [
    `${prefix}${i + 1}. ${s.title}${s.status === "failed" && !s.steps.some((c) => c.status === "failed") ? "  ← упал здесь" : ""}`,
    ...stepLines(s.steps, prefix + "   "),
  ]);
}

function draftFromAuto(run: AutoRun, r: AutoResult): BugDraft {
  return {
    title: `Автотест: ${r.name}`.slice(0, 500),
    severity: "major",
    assignee: "",
    env: [run.env, run.url, run.branch && `Ветка ${run.branch}`, run.build && `Сборка ${run.build}`].filter(Boolean).join(", "),
    steps: [
      `Автотест: ${r.suite ? `${r.suite} › ` : ""}${r.name}`, r.file && `Файл: ${r.file}`, `Запуск: ${run.id}`,
      r.steps.length ? `\nШаги:\n${stepLines(r.steps).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
    actual: [r.message, r.details && r.details !== r.message ? r.details.slice(0, 3000) : ""].filter(Boolean).join("\n\n"),
    expected: "Тест проходит",
  };
}

function AutoResultDrawer(props: { run: AutoRun; r: AutoResult; files: Attachment[]; onClose: () => void; onBug: (d: BugDraft) => void }) {
  const { run, r, files } = props;
  const canEdit = useCanEdit();
  const aiReady = useAiReady();
  const ai = useAi();
  // разбор привязан к результату: при переходе к другому тесту старый не показываем
  const [explain, setExplain] = useState<{ id: number; text: string } | null>(null);
  const explained = explain?.id === r.id ? explain.text : "";

  async function explainIt() {
    const res = await ai.run(() => api<{ text: string }>("POST", paths.aiExplain(run.pid, r.id), {}));
    if (res) setExplain({ id: r.id, text: res.text });
  }
  return (
    <Drawer
      label="Результат автотеста"
      idTag={run.id}
      title={r.name}
      onClose={props.onClose}
      footer={
        <>
          {canEdit && isProblem(r.status) && <button className="btn" onClick={() => props.onBug(draftFromAuto(run, r))}>Завести баг</button>}
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>Закрыть</button>
        </>
      }
    >
      <div className="view-block">
        <span className="label">Результат</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <AutoPill s={r.status} /><span className="muted small mono">{fmtDuration(r.durationMs)}</span>
        </div>
        {r.prev && <span className="muted small">В прошлый раз ({run.pid}-A{r.prev.runNum}): <AutoPill s={r.prev.status} sm /></span>}
      </div>
      {aiReady && isProblem(r.status) && (
        <div className="view-block">
          <span className="label">Разбор падения</span>
          {explained && <div className="ai-answer">{explained}</div>}
          <AiBar busy={ai.busy} onRun={explainIt} label={explained ? "Разобрать ещё раз" : "Объяснить падение"}
            hint={explained ? "Ответ модели может ошибаться — сверяйте со стектрейсом" : "Модель прочитает ошибку, шаги и стектрейс и подскажет, где искать"} />
        </div>
      )}
      {r.suite && <div className="view-block"><span className="label">Набор</span><span className="mono small" style={{ overflowWrap: "anywhere" }}>{r.suite}</span></div>}
      {r.file && <div className="view-block"><span className="label">Файл</span><span className="mono small" style={{ overflowWrap: "anywhere" }}>{r.file}</span></div>}
      {r.steps.length > 0 && <div className="view-block"><span className="label">Шаги</span><StepList steps={r.steps} /></div>}
      {r.message && <div className="view-block"><span className="label">Ошибка</span><div className="txt">{r.message}</div></div>}
      {r.details && (
        <div className="view-block">
          <span className="label">Подробности</span>
          <pre className="txt mono small" style={{ margin: 0, maxHeight: 360, overflow: "auto", whiteSpace: "pre-wrap" }}>{r.details}</pre>
        </div>
      )}
      <Attachments list={files} label="Скриншоты и файлы" uploadUrl={canEdit ? paths.autoFiles(run.pid, run.num, r.id) : undefined} />
      {files.some((a) => a.name === "trace.zip") && (
        <span className="muted small">
          Трейс Playwright: скачайте trace.zip и откройте на <a href="https://trace.playwright.dev" target="_blank" rel="noopener">trace.playwright.dev</a> или командой <span className="mono">npx playwright show-trace trace.zip</span>.
        </span>
      )}
    </Drawer>
  );
}

function AutoRunModal({ run, onClose }: { run: AutoRun; onClose: () => void }) {
  const { write } = useStore();
  const [f, setF] = useState({ title: run.title, build: run.build, env: run.env, branch: run.branch, scope: run.scope, url: run.url });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setErr("Укажите название запуска");
    if (await write(() => api("PATCH", paths.autorun(run.pid, run.num), f), "Запуск сохранён")) onClose();
  }
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>Параметры запуска</h2>
        <div className="field"><label htmlFor="a-title">Название *</label><input className="input" id="a-title" value={f.title} onChange={set("title")} autoFocus /></div>
        <div className="row2">
          <div className="field"><label htmlFor="a-branch">Ветка</label><input className="input mono" id="a-branch" value={f.branch} onChange={set("branch")} /></div>
          <div className="field"><label htmlFor="a-build">Сборка / версия</label><input className="input mono" id="a-build" value={f.build} onChange={set("build")} /></div>
        </div>
        <div className="row2">
          <div className="field"><label htmlFor="a-scope">Запущено</label><input className="input mono" id="a-scope" value={f.scope} onChange={set("scope")} /></div>
          <div className="field"><label htmlFor="a-env">Окружение</label><input className="input" id="a-env" value={f.env} onChange={set("env")} /></div>
        </div>
        <div className="field"><label htmlFor="a-url">Адрес приложения</label><input className="input mono" id="a-url" value={f.url} onChange={set("url")} /></div>
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- реестр автотестов ----------
function TestsRegistry({ project }: { project: Project }) {
  const p = project.id;
  const { write } = useStore();
  const canEdit = useCanEdit();
  const { value, error } = useLoad<{ tests: AutoTest[] }>(paths.autotests(p));
  const [q, setQ] = useState("");
  const [onlyFlaky, setOnlyFlaky] = useState(false);
  const [del, setDel] = useState<AutoTest | null>(null);
  const tests = value?.tests || [];
  const flaky = (t: AutoTest) => t.history.some((h) => h.status === "passed") && t.history.some((h) => isProblem(h.status));
  const needle = q.trim().toLowerCase();
  const rows = tests.filter((t) => (!onlyFlaky || flaky(t)) && (!needle || t.name.toLowerCase().includes(needle) || t.suite.toLowerCase().includes(needle)));

  if (error && !value) return <div className="banner">Не удалось загрузить автотесты: {error}</div>;
  if (!value) return <div className="skel">Загружаем автотесты…</div>;
  if (!tests.length) return <Empty title="Автотестов пока нет">Тесты появятся здесь сами при первом запуске, который пришлёт их результаты.</Empty>;

  return (
    <>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Поиск по названию или набору" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={onlyFlaky} onChange={(e) => setOnlyFlaky(e.target.checked)} /> Только нестабильные
        </label>
        <span className="muted small">{rows.length} из {tests.length}</span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Автотест</th><th style={{ width: 120 }}>Последний</th><th style={{ width: 190 }} title="Последние 10 запусков, свежий справа">История</th><th style={{ width: 120 }}>Появился</th><th style={{ width: 50 }} /></tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const last = t.history[0];
              return (
                <tr key={t.id}>
                  <td className="title">
                    {t.name}
                    {t.suite && <div className="muted small mono" style={{ fontWeight: 400, overflowWrap: "anywhere" }}>{t.suite}</div>}
                    {flaky(t) && <div className="small" style={{ color: "var(--warn)", fontWeight: 600 }}>Нестабильный</div>}
                    {t.steps.length > 0 && (
                      <details style={{ fontWeight: 400, marginTop: 4 }}>
                        <summary className="small muted" style={{ cursor: "pointer" }}>Шаги ({t.steps.length})</summary>
                        <div style={{ marginTop: 6 }}><StepList steps={t.steps} /></div>
                      </details>
                    )}
                  </td>
                  <td>{last ? <a href={href("p", p, "auto", last.runNum)} style={{ textDecoration: "none" }}><AutoPill s={last.status} sm /></a> : <span className="muted small">—</span>}</td>
                  <td>
                    <div style={{ display: "flex", gap: 3 }}>
                      {[...t.history].reverse().map((h) => (
                        <a key={h.runNum} href={href("p", p, "auto", h.runNum)} title={`${p}-A${h.runNum}: ${find(AUTO_STATUSES, h.status).label}`}
                          className={`t-${find(AUTO_STATUSES, h.status).tone}`} style={{ width: 12, height: 18, borderRadius: 3, display: "inline-block", background: "currentColor" }} />
                      ))}
                    </div>
                  </td>
                  <td className="small">{fmt(t.created)}</td>
                  <td>{canEdit && <button className="btn ghost sm" onClick={() => setDel(t)} aria-label={`Удалить ${t.name}`} title="Удалить из реестра">✕</button>}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={5} className="nores">Ничего не найдено.</td></tr>}
          </tbody>
        </table>
      </div>
      {del && (
        <Confirm
          title={`Удалить автотест «${del.name}»?`}
          text="Пропадёт и его история во всех запусках. Если тест снова придёт в отчёте, он заведётся заново. Удобно для переименованных и удалённых тестов."
          onClose={() => setDel(null)}
          onYes={async () => {
            const t = del;
            setDel(null);
            await write(() => api("DELETE", `${paths.autotests(p)}/${t.id}`, {}), "Автотест удалён");
          }}
        />
      )}
    </>
  );
}

// ---------- подключение: токены и инструкция ----------
interface Token { id: number; name: string; created: number; used: number | null }

function ConnectModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const { toast } = useStore();
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState("");
  const [del, setDel] = useState<Token | null>(null);
  const load = () => api<{ tokens: Token[] }>("GET", paths.tokens).then((r) => setTokens(r.tokens), (e) => toast(e.message));
  useEffect(() => {
    load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ token: string }>("POST", paths.tokens, { name: name.trim() || "Мой компьютер" });
      setFresh(r.token);
      setName("");
      load();
    } catch (e: any) {
      toast(e.message);
    }
  }

  const origin = window.location.origin;
  const vars = `export TESTBOL_URL=${origin}
export TESTBOL_TOKEN=${fresh || "<токен>"}
export TESTBOL_PROJECT=${pid}`;
  const playwright = `# в папке с playwright.config
curl -O ${origin}/testbol-reporter.js

${vars}

npx playwright test`;
  const config = `reporter: [["list"], ["./testbol-reporter.js"]],
use: { screenshot: "only-on-failure", trace: "retain-on-failure" },`;
  const junit = `curl -O ${origin}/report.js
${vars}

node report.js results/junit.xml                 # готовый отчёт
node report.js results/ -- pytest --junitxml=results/junit.xml   # запустить и отправить`;
  const pre = (text: string) => <pre className="txt mono small" style={{ margin: 0, overflowX: "auto", whiteSpace: "pre" }}>{text}</pre>;

  return (
    <Modal onClose={onClose} wide>
      <h2>Подключить автотесты</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Каждый запуск тестов станет здесь отдельной папкой: результаты появляются по ходу запуска, к упавшим тестам прикладываются скриншоты и трейсы. Подробности — в README, часть 3.
      </p>
      <div className="view-block">
        <span className="label">1. Токен</span>
        {fresh ? (
          <div className="linkbox">
            Токен показывается только сейчас, сохраните его:
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input className="input mono" readOnly value={fresh} onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={() => navigator.clipboard?.writeText(fresh).then(() => toast("Скопировано"), () => {})}>Копировать</button>
            </div>
          </div>
        ) : (
          <form onSubmit={create} style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder="Где будет работать: «Ноутбук», «CI»" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn primary" type="submit">Создать токен</button>
          </form>
        )}
        {tokens && tokens.length > 0 && (
          <div className="history">
            {tokens.map((t) => (
              <div key={t.id}>
                <b style={{ flex: 1, minWidth: 120 }}>{t.name}</b>
                <span className="muted">создан {fmt(t.created)} · {t.used ? `использован ${fmt(t.used)}` : "ещё не использовался"}</span>
                <button className="btn ghost sm" onClick={() => setDel(t)} aria-label={`Отозвать ${t.name}`}>Отозвать</button>
              </div>
            ))}
          </div>
        )}
        <span className="muted small">Токен годится только для отправки результатов автотестов: читать и менять баги и кейсы с ним нельзя.</span>
      </div>
      <div className="view-block">
        <span className="label">2. Playwright</span>
        {pre(playwright)}
        <span className="muted small">В <span className="mono">playwright.config</span> добавьте репортер (остальные настройки не трогайте):</span>
        {pre(config)}
        <span className="muted small">
          Без переменных TESTBOL_* репортер молча выключается, так что конфиг можно закоммитить: у коллег без токена тесты работают как обычно.
          В Windows PowerShell вместо <span className="mono">export X=…</span> пишите <span className="mono">$env:X="…"</span>.
        </span>
      </div>
      <details className="small">
        <summary style={{ cursor: "pointer" }}>Другой фреймворк (pytest, Jest, JUnit…) — через отчёт JUnit XML</summary>
        <div className="view-block" style={{ marginTop: 8 }}>
          {pre(junit)}
          <span className="muted small">Нужен Node.js 20+. Скриншоты прикладываются, если отчёт ссылается на них строкой <span className="mono">[[ATTACHMENT|путь]]</span>.</span>
        </div>
      </details>
      <div className="acts">
        <button className="btn" onClick={onClose}>Готово</button>
      </div>
      {del && (
        <Confirm
          title={`Отозвать токен «${del.name}»?`}
          text="Скрипты с этим токеном перестанут отправлять результаты."
          action="Отозвать"
          onClose={() => setDel(null)}
          onYes={async () => {
            const t = del;
            setDel(null);
            try {
              await api("DELETE", `${paths.tokens}/${t.id}`, {});
              toast("Токен отозван");
              load();
            } catch (e: any) {
              toast(e.message);
            }
          }}
        />
      )}
    </Modal>
  );
}
