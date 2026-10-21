import { useState, type FormEvent } from "react";
import { api, paths } from "../api";
import { BUG_STATUSES, CASE_STATUSES, find, isOpenBug, PRIORITIES, RESULTS } from "../labels";
import { go, href } from "../router";
import { lastResults } from "../selectors";
import { useData, useStore } from "../store";
import type { Project, ResultValue, TestCase } from "../types";
import { Confirm, Drawer, Empty, fmt, Pill, Prio, ResultPill, TextBlock, Who } from "../ui";
import { BugEditor, draftFromCase, type BugDraft } from "./Bugs";

type ResultFilter = "all" | ResultValue;

export function CasesTab({ project, openNum }: { project: Project; openNum?: number }) {
  const data = useData();
  const p = project.id;
  const [q, setQ] = useState("");
  const [fResult, setFResult] = useState<ResultFilter>("all");
  const [fPrio, setFPrio] = useState("all");
  const [fStatus, setFStatus] = useState("active");
  const [editing, setEditing] = useState<TestCase | "new" | null>(null);
  const [deleting, setDeleting] = useState<TestCase | null>(null);
  const [bugDraft, setBugDraft] = useState<BugDraft | null>(null);
  const { write } = useStore();

  const all = data.cases.filter((c) => c.pid === p);
  const last = lastResults(data, p);
  const resultOf = (c: TestCase): ResultValue => last.get(c.num)?.result || "untested";
  const openBugs = (c: TestCase) => data.bugs.filter((b) => b.pid === p && b.caseNum === c.num && isOpenBug(b.status));
  const base = all.filter((c) => (fStatus === "all" || (fStatus === "active" ? c.status !== "deprecated" : c.status === fStatus)) && (fPrio === "all" || c.priority === fPrio));
  const needle = q.trim().toLowerCase();
  const rows = base
    .filter((c) => (fResult === "all" || resultOf(c) === fResult) && (!needle || c.title.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)))
    .sort((a, b) => a.num - b.num);
  const viewing = openNum !== undefined ? all.find((c) => c.num === openNum) : undefined;
  const close = () => go("p", p, "cases");

  const chip = (k: ResultFilter, label: string) => (
    <button key={k} className="stat" aria-pressed={fResult === k} onClick={() => setFResult(k)}>
      {k !== "all" && <span className={`pill t-${find(RESULTS, k).tone}`} style={{ padding: "2px 4px" }}><span className="dot" /></span>}
      <span>{label}</span>
      <span className="n">{k === "all" ? base.length : base.filter((c) => resultOf(c) === k).length}</span>
    </button>
  );

  return (
    <>
      <div className="head">
        <p className="muted small" style={{ margin: 0 }}>Результат — последний из прогонов. Чтобы проверить кейсы на новой сборке, создайте прогон.</p>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setEditing("new")}>+ Тест-кейс</button>
      </div>
      <div className="stats">
        {chip("all", "Все")}
        {RESULTS.map((r) => chip(r.key, r.key === "untested" ? "Не запускался" : r.label))}
      </div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Поиск по названию или ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" aria-label="Приоритет" value={fPrio} onChange={(e) => setFPrio(e.target.value)}>
          <option value="all">Любой приоритет</option>
          {PRIORITIES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        <select className="input" aria-label="Статус" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="active">Кроме устаревших</option>
          <option value="all">Любой статус</option>
          {CASE_STATUSES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
      </div>
      {all.length === 0 ? (
        <Empty title="В проекте нет тест-кейсов">
          Добавьте первый: название, шаги и ожидаемый результат.
          <button className="btn primary" onClick={() => setEditing("new")}>+ Тест-кейс</button>
        </Empty>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>ID</th><th>Название</th><th style={{ width: 130 }}>Приоритет</th><th style={{ width: 110 }}>Статус</th>
                <th style={{ width: 150 }}>Результат</th><th style={{ width: 110 }}>Баги</th><th style={{ width: 120 }}>Обновлён</th><th style={{ width: 96 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const lr = last.get(c.num);
                const bugs = openBugs(c);
                const st = find(CASE_STATUSES, c.status);
                return (
                  <tr key={c.id} className="click" aria-selected={viewing?.num === c.num} onClick={() => go("p", p, "cases", c.num)}>
                    <td className="id">{c.id}</td>
                    <td className="title">{c.title}</td>
                    <td><Prio p={c.priority} /></td>
                    <td><Pill tone={st.tone} label={st.label} sm /></td>
                    <td className="nowrap">{lr ? <><ResultPill r={lr.result} /> <span className="muted small mono">R{lr.runNum}</span></> : <span className="muted small">Не запускался</span>}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="chips">{bugs.map((b) => <a key={b.id} className="chip" href={href("p", p, "bugs", b.num)} title={b.title}>B{b.num}</a>)}</div>
                    </td>
                    <td className="muted small nowrap">{fmt(c.updated)}</td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn ghost" onClick={() => setEditing(c)} aria-label="Редактировать">✎</button>
                      <button className="btn ghost" onClick={() => setDeleting(c)} aria-label="Удалить" style={{ color: "var(--crit)" }}>✕</button>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={8} className="nores">Ничего не найдено. Сбросьте фильтры или измените запрос.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {bugDraft ? (
        <BugEditor pid={p} draft={bugDraft} onClose={() => setBugDraft(null)} />
      ) : editing ? (
        <CaseEditor pid={p} c={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />
      ) : viewing ? (
        <CaseDrawer c={viewing} onClose={close} onEdit={() => setEditing(viewing)} onDelete={() => setDeleting(viewing)} onBug={setBugDraft} />
      ) : null}
      {deleting && (
        <Confirm
          title={`Удалить ${deleting.id}?`}
          text={`Тест-кейс «${deleting.title}» и его результаты во всех прогонах будут удалены у всех участников. Связанные баги останутся.`}
          onClose={() => setDeleting(null)}
          onYes={async () => {
            const c = deleting;
            setDeleting(null);
            if (await write(() => api("DELETE", paths.testCase(p, c.num), {}), "Тест-кейс удалён") && viewing?.num === c.num) close();
          }}
        />
      )}
    </>
  );
}

function CaseDrawer({ c, onClose, onEdit, onDelete, onBug }: { c: TestCase; onClose: () => void; onEdit: () => void; onDelete: () => void; onBug: (d: BugDraft) => void }) {
  const data = useData();
  const { write } = useStore();
  const p = c.pid;
  const history = data.results
    .filter((r) => r.pid === p && r.caseNum === c.num)
    .sort((a, b) => b.runNum - a.runNum);
  const bugs = data.bugs.filter((b) => b.pid === p && b.caseNum === c.num).sort((a, b) => b.num - a.num);
  const latest = history.find((r) => r.result !== "untested");
  const run = (n: number) => data.runs.find((r) => r.pid === p && r.num === n);

  const newBug = () => {
    const failed = latest && (latest.result === "failed" || latest.result === "blocked") ? latest : undefined;
    onBug(draftFromCase(c, failed && run(failed.runNum), failed));
  };

  return (
    <Drawer
      label="Тест-кейс"
      idTag={c.id}
      title={c.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn primary" onClick={onEdit}>Редактировать</button>
          <button className="btn" onClick={newBug}>Завести баг</button>
          <div className="spacer" />
          <button className="btn danger" onClick={onDelete}>Удалить</button>
        </>
      }
    >
      <div className="row2">
        <div className="view-block"><span className="label">Приоритет</span><Prio p={c.priority} /></div>
        <div className="view-block">
          <span className="label">Статус</span>
          <select className="input" value={c.status} onChange={(e) => { const status = e.target.value; write(() => api("PATCH", paths.testCase(p, c.num), { status }), `Статус: ${find(CASE_STATUSES, status as TestCase["status"]).label}`); }}>
            {CASE_STATUSES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </div>
      </div>
      <TextBlock label="Предусловия" text={c.pre} empty="Не указаны" />
      <TextBlock label="Шаги" text={c.steps} empty="Не указаны" steps />
      <TextBlock label="Ожидаемый результат" text={c.expected} empty="Не указан" />

      <div className="view-block">
        <span className="label">История прогонов</span>
        {history.length ? (
          <div className="history">
            {history.map((r) => {
              const rn = run(r.runNum);
              return (
                <div key={r.id}>
                  <a className="chip" href={href("p", p, "runs", r.runNum)}>R{r.runNum}</a>
                  <span style={{ flex: 1, minWidth: 120 }}>{rn?.title}{rn?.build ? <span className="muted"> · {rn.build}</span> : null}</span>
                  <ResultPill r={r.result} sm />
                  <span className="muted">{fmt(r.executed)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <span className="muted small">Кейс ещё не входил ни в один прогон</span>
        )}
      </div>

      <div className="view-block">
        <span className="label">Связанные баги</span>
        {bugs.length ? (
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
        ) : (
          <span className="muted small">Багов нет</span>
        )}
      </div>

      <div className="row2 small">
        <div className="view-block"><span className="label">Создал</span><Who login={c.createdBy} /><span className="muted">{fmt(c.created)}</span></div>
        <div className="view-block"><span className="label">Изменил</span><Who login={c.updatedBy} /><span className="muted">{fmt(c.updated)}</span></div>
      </div>
    </Drawer>
  );
}

function CaseEditor({ pid, c, onClose }: { pid: string; c?: TestCase; onClose: () => void }) {
  const { write, toast } = useStore();
  const [f, setF] = useState({
    title: c?.title || "", priority: c?.priority || "medium", status: c?.status || "draft",
    pre: c?.pre || "", steps: c?.steps || "", expected: c?.expected || "",
  });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setErr("Укажите название тест-кейса");
    if (c) {
      if (await write(() => api("PATCH", paths.testCase(pid, c.num), f), "Изменения сохранены")) {
        onClose();
        go("p", pid, "cases", c.num);
      }
      return;
    }
    let num = 0;
    if (await write(async () => { num = (await api<{ num: number }>("POST", paths.cases(pid), f)).num; })) {
      toast(`Создан ${pid}-${num}`);
      onClose();
      go("p", pid, "cases", num);
    }
  }

  return (
    <Drawer label={c ? "Редактирование" : "Новый тест-кейс"} idTag={c?.id} title={c ? "Редактирование" : "Новый тест-кейс"} onClose={onClose}
      footer={<><button className="btn primary" type="submit" form="caseForm">{c ? "Сохранить" : "Создать"}</button><button className="btn" type="button" onClick={onClose}>Отмена</button></>}>
      <form id="caseForm" onSubmit={submit} noValidate>
        <div className="field"><label htmlFor="c-title">Название *</label><input className="input" id="c-title" value={f.title} onChange={set("title")} placeholder="Например: Вход с неверным паролем" autoFocus /></div>
        <div className="row2">
          <div className="field"><label htmlFor="c-prio">Приоритет</label>
            <select className="input" id="c-prio" value={f.priority} onChange={set("priority")}>{PRIORITIES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
          <div className="field"><label htmlFor="c-status">Статус</label>
            <select className="input" id="c-status" value={f.status} onChange={set("status")}>{CASE_STATUSES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
        </div>
        <div className="field"><label htmlFor="c-pre">Предусловия</label><textarea className="input" id="c-pre" rows={2} value={f.pre} onChange={set("pre")} /></div>
        <div className="field"><label htmlFor="c-steps">Шаги</label><textarea className="input" id="c-steps" rows={5} placeholder="Каждый шаг с новой строки" value={f.steps} onChange={set("steps")} /></div>
        <div className="field"><label htmlFor="c-exp">Ожидаемый результат</label><textarea className="input" id="c-exp" rows={3} value={f.expected} onChange={set("expected")} /></div>
        <div className="err">{err}</div>
      </form>
    </Drawer>
  );
}
