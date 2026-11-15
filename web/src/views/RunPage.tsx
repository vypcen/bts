import { useEffect, useRef, useState } from "react";
import { api, paths } from "../api";
import { FieldsView, stepsOf, StepsView } from "../casekit";
import { checkedCount, checklistItems, itemMark } from "../checklist";
import { BUG_STATUSES, find, RESULTS } from "../labels";
import { go, href } from "../router";
import { countResults } from "../selectors";
import { useCan, useData, useLoad, useStore } from "../store";
import type { Attachment, CaseVersion, Project, Result, ResultValue, Run, RunResults, TestCase } from "../types";
import { Confirm, Drawer, fmt, FullCase, fullCase, Modal, PagedRows, Pill, Prio, ResultBar, ResultPill, TextBlock, useNames, Who } from "../ui";
import { AssignPicker, executorsOf, type Assign } from "./Plans";
import { substSteps } from "./Params";
import { ConfigChips, MatrixModal, useConfigs } from "./Configs";
import { Attachments } from "./Attachments";
import { BugEditor, draftFromCase, type BugDraft } from "./Bugs";
import { CasePicker, RunModal } from "./Runs";

const MARKS: ResultValue[] = ["passed", "failed", "blocked", "skipped"];

// Фактический результат шага из поля ввода важнее сохранённого: живое обновление с сервера могло ещё не прийти
function withActual(steps: Result["steps"], i: number, typed: string | undefined): Result["steps"] {
  if (typed === undefined) return steps;
  const prev = steps?.[i];
  return { ...(steps || {}), [i]: { ...(prev || { result: "failed" }), actual: typed } } as Result["steps"];
}

export function RunPage({ project, num }: { project: Project; num: number }) {
  const data = useData();
  const { write, liveError, me } = useStore();
  const canEdit = useCan("runs.manage");
  const canMark = useCan("runs.execute");
  const canBug = useCan("bugs.create");
  const p = project.id;
  const run = data.runs.find((r) => r.pid === p && r.num === num);
  const [filter, setFilter] = useState<"all" | ResultValue>("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [modal, setModal] = useState<"edit" | "add" | "delete" | "distribute" | "rerun" | null>(null);
  // "" — все, "me" — мои, "none" — без исполнителя, иначе логин
  const [who, setWho] = useState("");
  const nameOf = useNames();
  const [bugDraft, setBugDraft] = useState<BugDraft | null>(null);
  const [matrix, setMatrix] = useState(false);
  const cfgGroups = useConfigs(p);
  // режим выполнения: список кейсов слева, карточка кейса справа, горячие клавиши; выбор запоминается в браузере
  const [exec, setExecState] = useState(() => { try { return localStorage.getItem("tb.runExec") === "1"; } catch { return false; } });
  const setExec = (v: boolean) => { setExecState(v); try { localStorage.setItem("tb.runExec", v ? "1" : "0"); } catch { /* приватный режим */ } };
  // результаты прогона грузятся отдельно и перечитываются вместе с данными проекта
  const loaded = useLoad<RunResults>(run ? paths.runResults(p, num) : null);

  if (!run) {
    return (
      <main className="wrap">
        <div className="banner">Прогон {p}-R{num} не найден: возможно, его удалили.</div>
        <a href={href("p", p, "runs")}>← К списку прогонов</a>
      </main>
    );
  }

  const open = run.state === "open";
  const editable = open && canMark;
  if (!loaded.value) {
    return <main className="wrap">{loaded.error ? <div className="banner">{loaded.error}</div> : <div className="skel">Загружаем прогон…</div>}</main>;
  }
  const results = loaded.value.results;
  const counts = countResults(results);
  const prev = new Map(loaded.value.previous.map((r) => [r.caseNum, r]));
  const runFiles = loaded.value.attachments;
  const caseByNum = new Map(data.cases.map((c) => [c.num, c]));
  const caseOf = (r: Result) => caseByNum.get(r.caseNum)!;
  const needle = q.trim().toLowerCase();
  const rows = results
    .filter((r) => filter === "all" || r.result === filter)
    .filter((r) => !who || (who === "me" ? r.assignee === me?.login : who === "none" ? !r.assignee : r.assignee === who))
    .map((r) => ({ r, c: caseOf(r) }))
    .filter(({ c }) => c && (!needle || c.title.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)))
    .sort((a, b) => a.c.num - b.c.num);
  const bugsOf = (r: Result) => data.bugs.filter((b) => b.pid === p && (b.resultId === r.id || (b.caseNum === r.caseNum && b.runNum === num)));
  const mark = (r: Result, result: ResultValue) =>
    write(() => api("PATCH", paths.result(p, num, r.caseNum), { result: r.result === result ? "untested" : result }), undefined, { queue: true });
  // в режиме выполнения без выбора открыт первый непроверенный кейс
  const autoPick = exec && selected === null ? (rows.find(({ r }) => r.result === "untested") || rows[0])?.r.caseNum ?? null : null;
  const selNum = selected ?? autoPick;
  const sel = selNum !== null ? results.find((r) => r.caseNum === selNum) : undefined;
  const move = (d: number) => {
    const i = rows.findIndex(({ r }) => r.caseNum === selNum);
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + d))];
    if (next) setSelected(next.r.caseNum);
  };
  const done = results.length - counts.untested;

  const chip = (k: "all" | ResultValue, label: string, n: number) => (
    <button key={k} className="stat" aria-pressed={filter === k} onClick={() => setFilter(k)}>
      {k !== "all" && <span className={`pill t-${find(RESULTS, k).tone}`} style={{ padding: "2px 4px" }}><span className="dot" /></span>}
      <span>{label}</span><span className="n">{n}</span>
    </button>
  );

  return (
    <main className="wrap">
      {liveError && <div className="banner">{liveError}</div>}
      <a href={href("p", p, "runs")} className="small">← Прогоны проекта {project.name}</a>
      <div className="head">
        <div>
          <span className="label">{run.id}</span>
          <h1>{run.title}</h1>
          <p className="muted">
            {run.build ? <>Сборка <span className="mono">{run.build}</span></> : "Сборка не указана"}
            {run.env && <> · {run.env}</>} · создал <Who login={run.createdBy} /> {fmt(run.created)}
            {run.rerunOf && <> · перезапуск <a href={href("p", p, "runs", run.rerunOf)}>{p}-R{run.rerunOf}</a></>}
          </p>
          {(run.config || run.batch) && (
            <p style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "4px 0" }}>
              <ConfigChips cfg={run.config} groups={cfgGroups} />
              {run.batch && <button className="btn sm" onClick={() => setMatrix(true)}>Матрица конфигураций</button>}
            </p>
          )}
          <FieldsView entity="run" values={run.fields} />
        </div>
        <div className="spacer" />
        <div className="acts">
          {open ? <Pill tone="info" label="Идёт" /> : <Pill tone="neutral" label={`Закрыт ${fmt(run.closed)}`} />}
          <button className={`btn${exec ? " primary" : ""}`} onClick={() => setExec(!exec)} aria-pressed={exec}
            title="Список кейсов слева, кейс справа; отметки клавишами P, F, B, S, переход — N и стрелками">
            {exec ? "Обычный вид" : "Режим выполнения"}
          </button>
          <a className="btn" href={`${paths.run(p, num)}/report?format=pdf`} download style={{ textDecoration: "none" }} title="Отчёт для руководителя: сводка, упавшие кейсы, баги">Отчёт PDF</a>
          <a className="btn" href={`${paths.run(p, num)}/report?format=xlsx`} download style={{ textDecoration: "none" }}>Excel</a>
          {canEdit && (
            <>
              <button className="btn" onClick={() => setModal("edit")}>Параметры</button>
              {open && !run.planLocked && <button className="btn" onClick={() => setModal("add")}>Добавить кейсы</button>}
              {open && <button className="btn" onClick={() => setModal("distribute")}>Распределить</button>}
              {(run.counts.failed > 0 || run.counts.blocked > 0) && (
                <button className="btn" onClick={() => setModal("rerun")} title="Новый прогон из упавших и заблокированных кейсов — например, на сборке с исправлениями">
                  Перезапустить упавшие
                </button>
              )}
              <button className={`btn${open ? " primary" : ""}`} onClick={() => write(() => api("PATCH", paths.run(p, num), { state: open ? "closed" : "open" }), open ? "Прогон закрыт" : "Прогон снова открыт")}>
                {open ? "Закрыть прогон" : "Открыть снова"}
              </button>
              {!run.planLocked && <button className="btn danger" onClick={() => setModal("delete")} aria-label="Удалить прогон">✕</button>}
            </>
          )}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <ResultBar counts={counts} />
        <span className="muted small">Проверено {done} из {results.length}{results.length ? ` (${Math.round((done / results.length) * 100)}%)` : ""}</span>
      </div>
      {run.planNum && (
        <span className="small muted">
          По тест-плану <a href={href("p", p, "plans", run.planNum)}>{p}-P{run.planNum}</a>
          {run.planLocked && " — план заблокирован: состав прогона и версии кейсов зафиксированы"}
        </span>
      )}
      {!open && <div className="banner">Прогон закрыт: результаты зафиксированы.{canEdit && " Чтобы что-то поменять, откройте его снова."}</div>}
      <div className="stats">
        {chip("all", "Все", results.length)}
        {RESULTS.map((x) => chip(x.key, x.label, counts[x.key]))}
      </div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Поиск по названию или ID кейса" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" aria-label="Исполнитель" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Все исполнители</option>
          <option value="me">Мои кейсы ({results.filter((r) => r.assignee === me?.login).length})</option>
          <option value="none">Без исполнителя ({results.filter((r) => !r.assignee).length})</option>
          {[...new Set(results.map((r) => r.assignee).filter(Boolean) as string[])].filter((u) => u !== me?.login).map((u) => (
            <option key={u} value={u}>{nameOf(u)} ({results.filter((r) => r.assignee === u).length})</option>
          ))}
        </select>
      </div>
      {exec ? (
        <div className="exec-layout">
          <ul className="exec-list" aria-label="Кейсы прогона">
            {rows.map(({ r, c }) => (
              <li key={r.id}>
                <button type="button" aria-current={selNum === r.caseNum ? "true" : undefined} onClick={() => setSelected(r.caseNum)}>
                  <ResultPill r={r.result} sm />
                  <span className="mono small muted">{c.id}</span>
                  <span className="t">{c.kind === "checklist" ? "☑ " : ""}{c.title}</span>
                </button>
              </li>
            ))}
            {!rows.length && <li className="muted small" style={{ padding: 10 }}>Ничего не найдено.</li>}
          </ul>
          {sel && !bugDraft ? (
            <FullCase c={caseOf(sel)}>{(full) => (
              <ResultDrawer key={sel.id} docked run={run} r={sel} c={full} prev={prev.get(sel.caseNum)} files={runFiles}
                onClose={() => setExec(false)} onBug={setBugDraft} onMove={move}
                onNext={() => {
                  const next = rows.find(({ r }) => r.result === "untested" && r.caseNum !== sel.caseNum);
                  if (next) setSelected(next.r.caseNum);
                }} />
            )}</FullCase>
          ) : !bugDraft && <div className="exec-empty muted">Выберите кейс в списке слева.</div>}
        </div>
      ) : (
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 80 }}>Кейс</th><th>Название</th><th style={{ width: 120 }}>Приоритет</th><th style={{ width: 250 }}>Результат</th>
              <th style={{ width: 140 }}>Исполнитель</th>
              <th style={{ width: 120 }} title="Результат в предыдущем прогоне, где проверялся этот кейс">Ранее</th><th style={{ width: 120 }}>Баги</th>
            </tr>
          </thead>
          <tbody>
            <PagedRows items={rows} reset={`${filter}|${who}|${needle}`}>{({ r, c }) => {
              const pr = prev.get(r.caseNum);
              const bugs = bugsOf(r);
              const regress = pr?.result === "passed" && r.result === "failed";
              return (
                <tr key={r.id} className="click" aria-selected={selected === r.caseNum} onClick={() => setSelected(r.caseNum)}>
                  <td className="id">{c.id}</td>
                  <td className="title">{c.kind === "checklist" && <span title="Чек-лист">☑ </span>}{c.title}{r.comment && <div className="muted small" style={{ fontWeight: 400, whiteSpace: "pre-wrap" }}>{r.comment.slice(0, 140)}</div>}</td>
                  <td><Prio p={c.priority} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {c.kind === "checklist" ? (
                      // пункты отмечаются в карточке, здесь — итог и прогресс
                      <button type="button" className="btn ghost sm" onClick={() => setSelected(r.caseNum)} style={{ gap: 8 }}>
                        <ResultPill r={r.result} sm /><span className="muted small">{checkedCount(checklistItems(c), r)} из {checklistItems(c).length}</span>
                      </button>
                    ) : editable ? <ResultButtons value={r.result} onPick={(v) => mark(r, v)} /> : <ResultPill r={r.result} />}
                  </td>
                  <td className="small"><Who login={r.assignee} /></td>
                  <td className="nowrap">
                    {pr ? <span title={`${p}-R${pr.runNum}`}><ResultPill r={pr.result} sm /> <span className="muted small mono">R{pr.runNum}</span></span> : <span className="muted small">—</span>}
                    {regress && <div className="small" style={{ color: "var(--crit)", fontWeight: 600 }}>Регресс</div>}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="chips">
                      {bugs.map((b) => <a key={b.id} className="chip" href={href("p", p, "bugs", b.num)} title={`${b.title} · ${find(BUG_STATUSES, b.status).label}`}>B{b.num}</a>)}
                      {canBug && !bugs.length && (r.result === "failed" || r.result === "blocked") && (
                        <button className="btn sm" onClick={async () => setBugDraft(draftFromCase(await fullCase(c), run, r))}>+ Баг</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            }}</PagedRows>
            {!rows.length && <tr><td colSpan={7} className="nores">Ничего не найдено.</td></tr>}
          </tbody>
        </table>
      </div>
      )}

      {bugDraft ? (
        <BugEditor pid={p} draft={bugDraft} onClose={() => setBugDraft(null)} />
      ) : sel && !exec ? (
        <FullCase c={caseOf(sel)}>{(full) => (
        <ResultDrawer
          key={sel.id}
          onMove={move}
          run={run}
          r={sel}
          c={full}
          prev={prev.get(sel.caseNum)}
          files={runFiles}
          onClose={() => setSelected(null)}
          onBug={setBugDraft}
          onNext={() => {
            const next = rows.find(({ r }) => r.result === "untested" && r.caseNum !== sel.caseNum);
            setSelected(next ? next.r.caseNum : null);
          }}
        />
        )}</FullCase>
      ) : null}
      {modal === "edit" && <RunModal pid={p} run={run} onClose={() => setModal(null)} />}
      {matrix && run.batch && <MatrixModal pid={p} batch={run.batch} onClose={() => setMatrix(false)} />}
      {modal === "add" && <AddCasesModal run={run} inRunNums={results.map((r) => r.caseNum)} onClose={() => setModal(null)} />}
      {modal === "distribute" && <DistributeModal run={run} onClose={() => setModal(null)} />}
      {modal === "rerun" && <RerunModal run={run} onClose={() => setModal(null)} />}
      {modal === "delete" && (
        <Confirm
          title={`Удалить прогон ${run.id}?`}
          text={`Прогон с ${results.length} результатами и вложениями уйдёт в корзину проекта — оттуда его можно восстановить в течение 30 дней.`}
          onClose={() => setModal(null)}
          onYes={async () => {
            setModal(null);
            if (await write(() => api("DELETE", paths.run(p, num), {}), "Прогон удалён")) go("p", p, "runs");
          }}
        />
      )}
    </main>
  );
}

function ResultButtons({ value, onPick, lg, label = "Результат" }: { value: ResultValue; onPick: (v: ResultValue) => void; lg?: boolean; label?: string }) {
  return (
    <div className={`seg${lg ? " lg" : ""}`} role="group" aria-label={label}>
      {MARKS.map((k) => (
        <button key={k} type="button" className={`r-${k}`} aria-pressed={value === k} onClick={() => onPick(k)} title={value === k ? "Нажмите ещё раз, чтобы сбросить" : undefined}>
          {find(RESULTS, k).label}
        </button>
      ))}
    </div>
  );
}

function ResultDrawer(props: {
  run: Run; r: Result; c: TestCase; prev?: Result; files: Attachment[]; onClose: () => void; onBug: (d: BugDraft) => void; onNext: () => void;
  onMove?: (d: number) => void; docked?: boolean;
}) {
  const { run, c, prev } = props;
  // кейс с параметрами: результат и шаги — по выбранному набору данных, итог кейса считается по всем наборам
  const iters = props.r.iterations;
  const [iterSel, setIter] = useState(0);
  const iter = iters && iterSel < iters.length ? iterSel : 0;
  const cell = iters ? props.r.iterResults?.[iter] || { result: "untested" as ResultValue, steps: {} } : null;
  const r: Result = cell ? { ...props.r, result: cell.result, steps: cell.steps } : props.r;
  const it = iters ? { iteration: iter } : {};
  const values = iters?.[iter]?.values;
  const iterNote = iters ? `Набор данных «${iters[iter].name}»: ${Object.entries(values || {}).map(([k, v]) => `${k} = ${v}`).join(", ")}` : "";
  const data = useData();
  const { write } = useStore();
  const canEdit = useCan("runs.execute");
  const canBug = useCan("bugs.create");
  const [comment, setComment] = useState(r.comment);
  const p = run.pid;
  // разработчик видит результат так же, как в закрытом прогоне: без кнопок и правки
  const open = run.state === "open" && canEdit;
  const files = props.files.filter((a) => a.resultId === r.id);
  const bugs = data.bugs.filter((b) => b.pid === p && (b.resultId === r.id || (b.caseNum === c.num && b.runNum === run.num)));
  const dirty = comment.trim() !== r.comment;
  // blur поля и клик по кнопке приходят подряд: второй вызов ждёт уже начатое сохранение
  const saving = useRef<Promise<boolean> | null>(null);
  const saveComment = () => {
    if (saving.current) return saving.current;
    if (!dirty) return Promise.resolve(true);
    saving.current = write(() => api("PATCH", paths.result(p, run.num, c.num), { comment }), "Комментарий сохранён").finally(() => (saving.current = null));
    return saving.current;
  };
  const pick = async (v: ResultValue) => {
    const result = r.result === v ? "untested" : v;
    await write(() => api("PATCH", paths.result(p, run.num, c.num), dirty ? { result, comment, ...it } : { result, ...it }), undefined, { queue: true });
  };
  // пункт чек-листа: повторное нажатие на ту же отметку снимает её
  const items = checklistItems(c);
  const pickItem = (item: string, v: ResultValue) =>
    write(() => api("PATCH", paths.result(p, run.num, c.num), { item, result: itemMark(r, item) === v ? "untested" : v }), undefined, { queue: true });
  const nameOf = useNames();
  // кейс изменили после того, как его добавили в прогон или проверили: показываем текст проверяемой версии
  const outdated = r.caseVersion !== null && r.caseVersion !== c.version;
  const ver = useLoad<CaseVersion>(outdated ? `${paths.versions(p, c.num)}/${r.caseVersion}` : null);
  const shown = outdated && ver.value
    ? { ...c, pre: ver.value.pre, steps: ver.value.steps, expected: ver.value.expected, kind: ver.value.kind, stepList: ver.value.stepList }
    : c;
  const stepList = substSteps(stepsOf(shown), values);
  const shownSub = { ...shown, stepList };
  const withIter = (text: string) => [text, iterNote].filter(Boolean).join("\n");
  // результат шага; повторное нажатие на ту же отметку снимает её
  const pickStep = (i: number, v: ResultValue) =>
    write(() => api("PATCH", paths.result(p, run.num, c.num), { step: i, result: r.steps?.[i]?.result === v ? "untested" : v, ...it }), undefined, { queue: true });
  const [actuals, setActuals] = useState<Record<number, string>>({});
  const saveActual = (i: number) => {
    const text = actuals[i];
    if (text === undefined || text === (r.steps?.[i]?.actual || "")) return;
    write(() => api("PATCH", paths.result(p, run.num, c.num), { step: i, result: r.steps?.[i]?.result || "failed", actual: text, ...it }), "Сохранено", { queue: true });
  };
  const people = executorsOf(data, p);

  // горячие клавиши: P — пройден, F — упал, B — заблокирован, S — пропущен, N — следующий непроверенный, ↑/↓ (J/K) — соседний кейс.
  // По физической клавише (e.code) — работают и в русской раскладке; не мешают вводу текста и окнам поверх
  const keyRef = useRef({ pick, next: props.onNext, move: props.onMove, canMark: open && c.kind !== "checklist", result: r.result });
  keyRef.current = { pick, next: props.onNext, move: props.onMove, canMark: open && c.kind !== "checklist", result: r.result };
  useEffect(() => {
    const MARK: Record<string, ResultValue> = { KeyP: "passed", KeyF: "failed", KeyB: "blocked", KeyS: "skipped" };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || t.isContentEditable)) return;
      if (document.querySelector(".modal")) return;
      const k = keyRef.current;
      if (MARK[e.code] && k.canMark) {
        e.preventDefault();
        if (k.result !== MARK[e.code]) k.pick(MARK[e.code]);
      } else if (e.code === "KeyN") { e.preventDefault(); k.next(); }
      else if ((e.code === "ArrowDown" || e.code === "KeyJ") && k.move) { e.preventDefault(); k.move(1); }
      else if ((e.code === "ArrowUp" || e.code === "KeyK") && k.move) { e.preventDefault(); k.move(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Drawer
      docked={props.docked}
      label="Результат кейса"
      idTag={c.id}
      title={c.title}
      onClose={props.onClose}
      footer={
        <>
          {canBug && c.kind !== "checklist" && (r.result === "failed" || r.result === "blocked") && (
            <button className="btn" onClick={async () => { if (await saveComment()) props.onBug(draftFromCase(shownSub, run, { ...r, comment: withIter(comment.trim()) })); }}>Завести баг</button>
          )}
          <a className="btn ghost" href={href("p", p, "cases", c.num)} style={{ textDecoration: "none" }}>Открыть кейс</a>
          <div className="spacer" />
          {open && <span className="muted small kbd-hint" title="Горячие клавиши работают в любой раскладке">P F B S — отметить · N — следующий · ↑↓ — соседний</span>}
          <button className="btn primary" onClick={async () => { if (await saveComment()) props.onNext(); }}>Следующий непроверенный →</button>
        </>
      }
    >
      <div className="view-block">
        <span className="label">Результат в {run.id}</span>
        {c.kind === "checklist" ? (
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <ResultPill r={r.result} /><span className="muted small">Отмечено {checkedCount(items, r)} из {items.length}. Итог считается по пунктам</span>
          </span>
        ) : iters ? (
          <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <ResultPill r={props.r.result} />
            <span className="muted small">Итог по {iters.length} наборам данных: проверено {Object.values(props.r.iterResults || {}).filter((x) => x.result !== "untested").length}</span>
          </span>
        ) : open ? <ResultButtons value={r.result} onPick={pick} lg /> : <ResultPill r={r.result} />}
        {r.executed && <span className="muted small">Отметил <Who login={r.executedBy} /> · {fmt(r.executed)}</span>}
        {prev && <span className="muted small">В прошлый раз ({p}-R{prev.runNum}): <ResultPill r={prev.result} sm /></span>}
      </div>
      <div className="view-block">
        <span className="label">Исполнитель</span>
        {open ? (
          <select className="input" value={r.assignee || ""} onChange={(e) => write(() => api("PATCH", paths.result(p, run.num, c.num), { assignee: e.target.value || null }), e.target.value ? `Назначен: ${nameOf(e.target.value)}` : "Исполнитель снят")}>
            <option value="">Не назначен</option>
            {[...new Set([...people, ...(r.assignee ? [r.assignee] : [])])].map((u) => <option key={u} value={u}>{nameOf(u)}</option>)}
          </select>
        ) : <Who login={r.assignee} />}
      </div>
      {iters && (
        <div className="view-block">
          <span className="label">Набор данных</span>
          <div className="iter-tabs" role="tablist" aria-label="Наборы данных">
            {iters.map((x, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === iter} className={`iter-tab${i === iter ? " on" : ""}`} onClick={() => { setIter(i); setActuals({}); }}>
                <span>{x.name}</span> <ResultPill r={props.r.iterResults?.[i]?.result || "untested"} sm />
              </button>
            ))}
          </div>
          <div className="small mono muted">{Object.entries(values || {}).map(([k, v]) => `${k} = ${v}`).join(" · ")}</div>
          {shown.kind !== "checklist" && (
            <div style={{ marginTop: 6 }}>{open ? <ResultButtons value={r.result} onPick={pick} label={`Результат набора ${iters[iter].name}`} /> : <ResultPill r={r.result} />}</div>
          )}
        </div>
      )}
      {outdated && (
        <div className="banner small">
          Кейс изменён после {r.result === "untested" ? "добавления в прогон" : "проверки"}: ниже версия v{r.caseVersion}, текущая — v{c.version}.
          {run.planLocked && " Прогон по заблокированному плану проверяет зафиксированную версию."}
        </div>
      )}
      {shown.kind === "checklist" ? (
        <div className="view-block">
          <span className="label">Пункты</span>
          <ol className="items-list">
            {items.map((item) => {
              const m = itemMark(r, item);
              const was = prev && itemMark(prev, item);
              return (
                <li key={item}>
                  <span className="item-text">{item}</span>
                  <div className="item-acts">
                    {open ? <ResultButtons value={m} onPick={(v) => pickItem(item, v)} label={`Результат: ${item}`} /> : <ResultPill r={m} sm />}
                    {was === "passed" && m === "failed" && <span className="small" style={{ color: "var(--crit)", fontWeight: 600 }}>Регресс</span>}
                    {was && was !== "untested" && was !== m && m !== "failed" && <span className="muted small">ранее: <ResultPill r={was} sm /></span>}
                    {canBug && (m === "failed" || m === "blocked") && (
                      <button className="btn sm" onClick={async () => { if (await saveComment()) props.onBug(draftFromCase(c, run, { ...r, comment: comment.trim() }, item)); }}>+ Баг</button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <>
          <TextBlock label="Предусловия" text={shown.pre} empty="Не указаны" />
          <div className="view-block">
            <span className="label">Шаги{stepList.length ? ` · отмечено ${Object.values(r.steps || {}).filter((x) => x.result !== "untested").length} из ${stepList.length}` : ""}</span>
            <StepsView steps={stepList} render={(_, i) => {
              const sr = r.steps?.[i];
              const m: ResultValue = sr?.result || "untested";
              const bad = m === "failed" || m === "blocked";
              const stepFiles = files.filter((a) => a.step === i);
              return (
                <div className="step-mark">
                  {open ? <ResultButtons value={m} onPick={(v) => pickStep(i, v)} label={`Результат шага ${i + 1}`} /> : <ResultPill r={m} sm />}
                  {canBug && bad && (
                    <button className="btn sm" onClick={async () => { if (await saveComment()) props.onBug(draftFromCase(shownSub, run, { ...r, comment: withIter(comment.trim()), steps: withActual(r.steps, i, actuals[i]) }, undefined, i)); }}>+ Баг</button>
                  )}
                  {(bad || sr?.actual) && (
                    <input className="input" aria-label={`Фактический результат шага ${i + 1}`} placeholder="Что произошло на этом шаге" disabled={!open}
                      value={actuals[i] ?? sr?.actual ?? ""} onChange={(e) => setActuals({ ...actuals, [i]: e.target.value })} onBlur={() => open && saveActual(i)} />
                  )}
                  {(bad || stepFiles.length > 0) && (
                    <Attachments list={stepFiles} uploadUrl={open ? `${paths.result(p, run.num, c.num)}/attachments?step=${i}` : undefined} compact />
                  )}
                </div>
              );
            }} />
          </div>
          <TextBlock label="Ожидаемый результат" text={shown.expected} empty="Не указан" />
        </>
      )}
      <div className="field">
        <label htmlFor="rr-comment">Комментарий / фактический результат</label>
        <textarea className="input" id="rr-comment" rows={3} value={comment} disabled={!open} onChange={(e) => setComment(e.target.value)} onBlur={() => open && saveComment()}
          placeholder="Что увидели при проверке. Попадёт в поле «Фактический результат», если заведёте баг" />
      </div>
      <Attachments list={files.filter((a) => a.step == null)} uploadUrl={open ? `${paths.result(p, run.num, c.num)}/attachments` : undefined} paste={open} />
      {bugs.length > 0 && (
        <div className="view-block">
          <span className="label">Баги из этого прогона</span>
          <div className="history">
            {bugs.map((b) => {
              const st = find(BUG_STATUSES, b.status);
              return (
                <div key={b.id}>
                  <a className="chip" href={href("p", p, "bugs", b.num)}>{b.id}</a>
                  <span style={{ flex: 1, minWidth: 120 }}>{b.title}</span>
                  <Pill tone={st.tone} label={st.label} sm />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function AddCasesModal({ run, inRunNums, onClose }: { run: Run; inRunNums: number[]; onClose: () => void }) {
  const data = useData();
  const { write } = useStore();
  const inRun = new Set(inRunNums);
  const cases = data.cases.filter((c) => c.pid === run.pid && !inRun.has(c.num) && c.status !== "deprecated").sort((a, b) => a.num - b.num);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  return (
    <Modal onClose={onClose} wide>
      <h2>Добавить кейсы в {run.id}</h2>
      <CasePicker cases={cases} picked={picked} setPicked={setPicked} />
      <div className="acts">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!picked.size}
          onClick={async () => { if (await write(() => api("POST", `${paths.run(run.pid, run.num)}/cases`, { caseNums: [...picked] }), `Добавлено кейсов: ${picked.size}`)) onClose(); }}>
          Добавить ({picked.size})
        </button>
      </div>
    </Modal>
  );
}

function DistributeModal({ run, onClose }: { run: Run; onClose: () => void }) {
  const { write, toast } = useStore();
  const [assign, setAssign] = useState<Assign>({ users: [], strategy: "balanced" });
  const [onlyUnassigned, setOnlyUnassigned] = useState(true);
  async function go() {
    let out: { assigned: number } = { assigned: 0 };
    if (await write(async () => { out = await api("POST", paths.distribute(run.pid, run.num), { ...assign, onlyUnassigned }); })) {
      toast(`Распределено кейсов: ${out.assigned}`);
      onClose();
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>Распределить {run.id}</h2>
      <p className="muted small" style={{ margin: 0 }}>Распределяются непроверенные кейсы. Уже назначенная работа учитывается в нагрузке.</p>
      <AssignPicker pid={run.pid} value={assign} onChange={setAssign} />
      <label style={{ display: "flex", gap: 8 }}>
        <input type="checkbox" checked={!onlyUnassigned} onChange={(e) => setOnlyUnassigned(!e.target.checked)} /> Перераспределить и уже назначенные непроверенные кейсы
      </label>
      <div className="acts">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!assign.users.length} onClick={go}>Распределить</button>
      </div>
    </Modal>
  );
}

// Перезапуск: новый прогон из кейсов с выбранными результатами. Исполнители и поля переносятся
const RERUN_CHOICES: { key: ResultValue; label: string }[] = [
  { key: "failed", label: "Упал" },
  { key: "blocked", label: "Заблокирован" },
  { key: "skipped", label: "Пропущен" },
  { key: "untested", label: "Не проверен" },
];
function RerunModal({ run, onClose }: { run: Run; onClose: () => void }) {
  const { write, toast } = useStore();
  const [picked, setPicked] = useState<ResultValue[]>(["failed", "blocked"]);
  const [build, setBuild] = useState(run.build);
  const [env, setEnv] = useState(run.env);
  const count = picked.reduce((s, r) => s + (run.counts[r] || 0), 0);
  async function submit() {
    let created: { num: number; cases: number } | null = null;
    const ok = await write(async () => {
      created = await api("POST", `${paths.run(run.pid, run.num)}/rerun`, { results: picked, build, env });
    });
    if (ok && created) {
      const c = created as { num: number; cases: number };
      toast(`Создан прогон ${run.pid}-R${c.num}: ${c.cases} кейсов`);
      onClose();
      go("p", run.pid, "runs", c.num);
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>Перезапустить {run.id}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Будет создан новый прогон из кейсов с выбранными результатами. Исполнители останутся прежними.</p>
      <div className="field">
        <span className="label">Какие кейсы</span>
        {RERUN_CHOICES.map((c) => (
          <label key={c.key} className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={picked.includes(c.key)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.key] : picked.filter((x) => x !== c.key))} />
            {c.label} <span className="muted">({run.counts[c.key] || 0})</span>
          </label>
        ))}
      </div>
      <div className="field"><label htmlFor="rr-build">Сборка</label>
        <input id="rr-build" className="input mono" value={build} onChange={(e) => setBuild(e.target.value)} />
        <span className="muted" style={{ fontSize: 12 }}>Обычно — новая сборка с исправлениями</span></div>
      <div className="field"><label htmlFor="rr-env">Окружение</label>
        <input id="rr-env" className="input" value={env} onChange={(e) => setEnv(e.target.value)} /></div>
      <div className="acts">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!count} onClick={submit}>Создать прогон ({count})</button>
      </div>
    </Modal>
  );
}
