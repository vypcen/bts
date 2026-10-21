import { useRef, useState } from "react";
import { api, paths } from "../api";
import { BUG_STATUSES, find, RESULTS } from "../labels";
import { go, href } from "../router";
import { countResults, previousResults, runResults } from "../selectors";
import { useCanEdit, useData, useStore } from "../store";
import type { Project, Result, ResultValue, Run, TestCase } from "../types";
import { Confirm, Drawer, fmt, Modal, Pill, Prio, ResultBar, ResultPill, TextBlock, Who } from "../ui";
import { Attachments } from "./Attachments";
import { BugEditor, draftFromCase, type BugDraft } from "./Bugs";
import { CasePicker, RunModal } from "./Runs";

const MARKS: ResultValue[] = ["passed", "failed", "blocked", "skipped"];

export function RunPage({ project, num }: { project: Project; num: number }) {
  const data = useData();
  const { write, liveError } = useStore();
  const canEdit = useCanEdit();
  const p = project.id;
  const run = data.runs.find((r) => r.pid === p && r.num === num);
  const [filter, setFilter] = useState<"all" | ResultValue>("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [modal, setModal] = useState<"edit" | "add" | "delete" | null>(null);
  const [bugDraft, setBugDraft] = useState<BugDraft | null>(null);

  if (!run) {
    return (
      <main className="wrap">
        <div className="banner">Прогон {p}-R{num} не найден: возможно, его удалили.</div>
        <a href={href("p", p, "runs")}>← К списку прогонов</a>
      </main>
    );
  }

  const open = run.state === "open";
  const editable = open && canEdit;
  const results = runResults(data, p, num);
  const counts = countResults(results);
  const prev = previousResults(data, p, num);
  const caseOf = (r: Result) => data.cases.find((c) => c.pid === p && c.num === r.caseNum)!;
  const needle = q.trim().toLowerCase();
  const rows = results
    .filter((r) => filter === "all" || r.result === filter)
    .map((r) => ({ r, c: caseOf(r) }))
    .filter(({ c }) => c && (!needle || c.title.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)))
    .sort((a, b) => a.c.num - b.c.num);
  const bugsOf = (r: Result) => data.bugs.filter((b) => b.pid === p && (b.resultId === r.id || (b.caseNum === r.caseNum && b.runNum === num)));
  const mark = (r: Result, result: ResultValue) =>
    write(() => api("PATCH", paths.result(p, num, r.caseNum), { result: r.result === result ? "untested" : result }));
  const sel = selected !== null ? results.find((r) => r.caseNum === selected) : undefined;
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
          </p>
        </div>
        <div className="spacer" />
        <div className="acts">
          {open ? <Pill tone="info" label="Идёт" /> : <Pill tone="neutral" label={`Закрыт ${fmt(run.closed)}`} />}
          {canEdit && (
            <>
              <button className="btn" onClick={() => setModal("edit")}>Параметры</button>
              {open && <button className="btn" onClick={() => setModal("add")}>Добавить кейсы</button>}
              <button className={`btn${open ? " primary" : ""}`} onClick={() => write(() => api("PATCH", paths.run(p, num), { state: open ? "closed" : "open" }), open ? "Прогон закрыт" : "Прогон снова открыт")}>
                {open ? "Закрыть прогон" : "Открыть снова"}
              </button>
              <button className="btn danger" onClick={() => setModal("delete")} aria-label="Удалить прогон">✕</button>
            </>
          )}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <ResultBar counts={counts} />
        <span className="muted small">Проверено {done} из {results.length}{results.length ? ` (${Math.round((done / results.length) * 100)}%)` : ""}</span>
      </div>
      {!open && <div className="banner">Прогон закрыт: результаты зафиксированы.{canEdit && " Чтобы что-то поменять, откройте его снова."}</div>}
      <div className="stats">
        {chip("all", "Все", results.length)}
        {RESULTS.map((x) => chip(x.key, x.label, counts[x.key]))}
      </div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Поиск по названию или ID кейса" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 80 }}>Кейс</th><th>Название</th><th style={{ width: 120 }}>Приоритет</th><th style={{ width: 250 }}>Результат</th>
              <th style={{ width: 120 }} title="Результат в предыдущем прогоне, где проверялся этот кейс">Ранее</th><th style={{ width: 120 }}>Баги</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, c }) => {
              const pr = prev.get(r.caseNum);
              const bugs = bugsOf(r);
              const regress = pr?.result === "passed" && r.result === "failed";
              return (
                <tr key={r.id} className="click" aria-selected={selected === r.caseNum} onClick={() => setSelected(r.caseNum)}>
                  <td className="id">{c.id}</td>
                  <td className="title">{c.title}{r.comment && <div className="muted small" style={{ fontWeight: 400, whiteSpace: "pre-wrap" }}>{r.comment.slice(0, 140)}</div>}</td>
                  <td><Prio p={c.priority} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {editable ? <ResultButtons value={r.result} onPick={(v) => mark(r, v)} /> : <ResultPill r={r.result} />}
                  </td>
                  <td className="nowrap">
                    {pr ? <span title={`${p}-R${pr.runNum}`}><ResultPill r={pr.result} sm /> <span className="muted small mono">R{pr.runNum}</span></span> : <span className="muted small">—</span>}
                    {regress && <div className="small" style={{ color: "var(--crit)", fontWeight: 600 }}>Регресс</div>}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="chips">
                      {bugs.map((b) => <a key={b.id} className="chip" href={href("p", p, "bugs", b.num)} title={`${b.title} · ${find(BUG_STATUSES, b.status).label}`}>B{b.num}</a>)}
                      {canEdit && !bugs.length && (r.result === "failed" || r.result === "blocked") && (
                        <button className="btn sm" onClick={() => setBugDraft(draftFromCase(c, run, r))}>+ Баг</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={6} className="nores">Ничего не найдено.</td></tr>}
          </tbody>
        </table>
      </div>

      {bugDraft ? (
        <BugEditor pid={p} draft={bugDraft} onClose={() => setBugDraft(null)} />
      ) : sel ? (
        <ResultDrawer
          key={sel.id}
          run={run}
          r={sel}
          c={caseOf(sel)}
          prev={prev.get(sel.caseNum)}
          onClose={() => setSelected(null)}
          onBug={setBugDraft}
          onNext={() => {
            const next = rows.find(({ r }) => r.result === "untested" && r.caseNum !== sel.caseNum);
            setSelected(next ? next.r.caseNum : null);
          }}
        />
      ) : null}
      {modal === "edit" && <RunModal pid={p} run={run} onClose={() => setModal(null)} />}
      {modal === "add" && <AddCasesModal run={run} onClose={() => setModal(null)} />}
      {modal === "delete" && (
        <Confirm
          title={`Удалить прогон ${run.id}?`}
          text={`Будут удалены все ${results.length} результатов и вложения к ним. Связанные баги останутся, но потеряют ссылку на прогон.`}
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

function ResultButtons({ value, onPick, lg }: { value: ResultValue; onPick: (v: ResultValue) => void; lg?: boolean }) {
  return (
    <div className={`seg${lg ? " lg" : ""}`} role="group" aria-label="Результат">
      {MARKS.map((k) => (
        <button key={k} type="button" className={`r-${k}`} aria-pressed={value === k} onClick={() => onPick(k)} title={value === k ? "Нажмите ещё раз, чтобы сбросить" : undefined}>
          {find(RESULTS, k).label}
        </button>
      ))}
    </div>
  );
}

function ResultDrawer(props: { run: Run; r: Result; c: TestCase; prev?: Result; onClose: () => void; onBug: (d: BugDraft) => void; onNext: () => void }) {
  const { run, r, c, prev } = props;
  const data = useData();
  const { write } = useStore();
  const canEdit = useCanEdit();
  const [comment, setComment] = useState(r.comment);
  const p = run.pid;
  // разработчик видит результат так же, как в закрытом прогоне: без кнопок и правки
  const open = run.state === "open" && canEdit;
  const files = data.attachments.filter((a) => a.resultId === r.id);
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
    await write(() => api("PATCH", paths.result(p, run.num, c.num), dirty ? { result, comment } : { result }));
  };

  return (
    <Drawer
      label="Результат кейса"
      idTag={c.id}
      title={c.title}
      onClose={props.onClose}
      footer={
        <>
          {canEdit && (r.result === "failed" || r.result === "blocked") && (
            <button className="btn" onClick={async () => { if (await saveComment()) props.onBug(draftFromCase(c, run, { ...r, comment: comment.trim() })); }}>Завести баг</button>
          )}
          <a className="btn ghost" href={href("p", p, "cases", c.num)} style={{ textDecoration: "none" }}>Открыть кейс</a>
          <div className="spacer" />
          <button className="btn primary" onClick={async () => { if (await saveComment()) props.onNext(); }}>Следующий непроверенный →</button>
        </>
      }
    >
      <div className="view-block">
        <span className="label">Результат в {run.id}</span>
        {open ? <ResultButtons value={r.result} onPick={pick} lg /> : <ResultPill r={r.result} />}
        {r.executed && <span className="muted small">Отметил <Who login={r.executedBy} /> · {fmt(r.executed)}</span>}
        {prev && <span className="muted small">В прошлый раз ({p}-R{prev.runNum}): <ResultPill r={prev.result} sm /></span>}
      </div>
      <TextBlock label="Предусловия" text={c.pre} empty="Не указаны" />
      <TextBlock label="Шаги" text={c.steps} empty="Не указаны" steps />
      <TextBlock label="Ожидаемый результат" text={c.expected} empty="Не указан" />
      <div className="field">
        <label htmlFor="rr-comment">Комментарий / фактический результат</label>
        <textarea className="input" id="rr-comment" rows={3} value={comment} disabled={!open} onChange={(e) => setComment(e.target.value)} onBlur={() => open && saveComment()}
          placeholder="Что увидели при проверке. Попадёт в поле «Фактический результат», если заведёте баг" />
      </div>
      <Attachments list={files} uploadUrl={open ? `${paths.result(p, run.num, c.num)}/attachments` : undefined} paste={open} />
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

function AddCasesModal({ run, onClose }: { run: Run; onClose: () => void }) {
  const data = useData();
  const { write } = useStore();
  const inRun = new Set(runResults(data, run.pid, run.num).map((r) => r.caseNum));
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
