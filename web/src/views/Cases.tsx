import { useState, type FormEvent } from "react";
import { AI_NOTE, AiBar, useAi, useAiReady } from "../ai";
import { api, paths } from "../api";
import { BUG_STATUSES, CASE_STATUSES, find, isOpenBug, PRIORITIES, RESULTS } from "../labels";
import { go, href } from "../router";
import { countBy, folderPath, lastResults } from "../selectors";
import { useCanEdit, useData, useStore } from "../store";
import type { Project, ResultValue, TestCase } from "../types";
import { CommentCount, Confirm, Drawer, Empty, fmt, Pill, Prio, ResultPill, TextBlock, Who } from "../ui";
import { BugEditor, draftFromCase, type BugDraft } from "./Bugs";
import { Comments } from "./Comments";
import { FolderOptions, FolderTree, inFolder, type FolderSel } from "./Folders";

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
  const [folderSel, setFolderSel] = useState<FolderSel>("all");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [moveTo, setMoveTo] = useState("");
  const { write, toast } = useStore();
  const canEdit = useCanEdit();
  // выбранную папку могли удалить в другой вкладке или другие участники
  const sel: FolderSel = typeof folderSel === "number" && !data.folders.some((f) => f.id === folderSel) ? "all" : folderSel;

  const all = data.cases.filter((c) => c.pid === p);
  const last = lastResults(data, p);
  const resultOf = (c: TestCase): ResultValue => last.get(c.num)?.result || "untested";
  const talk = countBy(data.comments.filter((x) => x.pid === p), (x) => x.caseNum);
  const openBugs = (c: TestCase) => data.bugs.filter((b) => b.pid === p && b.caseNum === c.num && isOpenBug(b.status));
  const scoped = all.filter((c) => (fStatus === "all" || (fStatus === "active" ? c.status !== "deprecated" : c.status === fStatus)) && (fPrio === "all" || c.priority === fPrio));
  const base = scoped.filter(inFolder(data, sel));
  const needle = q.trim().toLowerCase();
  const rows = base
    .filter((c) => (fResult === "all" || resultOf(c) === fResult) && (!needle || c.title.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)))
    .sort((a, b) => a.num - b.num);
  const viewing = openNum !== undefined ? all.find((c) => c.num === openNum) : undefined;
  const close = () => go("p", p, "cases");
  // отмеченные для перемещения — только среди видимых сейчас строк
  const shown = rows.filter((c) => picked.has(c.num));
  const togglePick = (n: number) => {
    const s = new Set(picked);
    s.has(n) ? s.delete(n) : s.add(n);
    setPicked(s);
  };
  const allPicked = rows.length > 0 && shown.length === rows.length;
  const move = async () => {
    const folder = moveTo ? Number(moveTo) : null;
    let moved = 0;
    if (await write(async () => { moved = (await api<{ moved: number }>("POST", paths.moveCases(p), { nums: shown.map((c) => c.num), folder })).moved; })) {
      toast(moved ? `Перемещено кейсов: ${moved}` : "Кейсы уже лежат в этой папке");
      setPicked(new Set());
    }
  };

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
        {canEdit && <button className="btn primary" onClick={() => setEditing("new")}>+ Тест-кейс</button>}
      </div>
      <div className="cases-layout">
      {(all.length > 0 || data.folders.some((f) => f.pid === p)) && <FolderTree pid={p} cases={scoped} sel={sel} onSelect={(s) => { setFolderSel(s); setPicked(new Set()); }} />}
      <div className="cases-main">
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
      {canEdit && shown.length > 0 && (
        <div className="bulk">
          <b>Выбрано: {shown.length}</b>
          <span className="muted">Переместить в</span>
          <select className="input" aria-label="Папка назначения" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <FolderOptions pid={p} rootLabel="— корень проекта (без папки) —" />
          </select>
          <button className="btn primary sm" onClick={move}>Переместить</button>
          <button className="btn sm" onClick={() => setPicked(new Set())}>Снять выделение</button>
        </div>
      )}
      {all.length === 0 ? (
        <Empty title="В проекте нет тест-кейсов">
          {canEdit ? "Добавьте первый: название, шаги и ожидаемый результат." : "Здесь появятся тест-кейсы, которые заведут тестировщики."}
          {canEdit && <button className="btn primary" onClick={() => setEditing("new")}>+ Тест-кейс</button>}
        </Empty>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                {canEdit && <th style={{ width: 36 }}><input type="checkbox" aria-label="Отметить все" checked={allPicked}
                  ref={(el) => { if (el) el.indeterminate = shown.length > 0 && !allPicked; }}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((c) => c.num)))} /></th>}
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
                    {canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Отметить ${c.id}`} checked={picked.has(c.num)} onChange={() => togglePick(c.num)} /></td>}
                    <td className="id">{c.id}</td>
                    <td className="title">
                      {c.title}<CommentCount n={talk.get(c.num)} />
                      {sel === "all" && c.folder !== null && <div className="muted small">{folderPath(data, c.folder)}</div>}
                    </td>
                    <td><Prio p={c.priority} /></td>
                    <td><Pill tone={st.tone} label={st.label} sm /></td>
                    <td className="nowrap">{lr ? <><ResultPill r={lr.result} /> <span className="muted small mono">R{lr.runNum}</span></> : <span className="muted small">Не запускался</span>}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="chips">{bugs.map((b) => <a key={b.id} className="chip" href={href("p", p, "bugs", b.num)} title={b.title}>B{b.num}</a>)}</div>
                    </td>
                    <td className="muted small nowrap">{fmt(c.updated)}</td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      {canEdit && <button className="btn ghost" onClick={() => setEditing(c)} aria-label="Редактировать">✎</button>}
                      {canEdit && <button className="btn ghost" onClick={() => setDeleting(c)} aria-label="Удалить" style={{ color: "var(--crit)" }}>✕</button>}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={canEdit ? 9 : 8} className="nores">{sel !== "all" && !base.length ? "В этой папке нет кейсов." : "Ничего не найдено. Сбросьте фильтры или измените запрос."}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      </div>
      </div>

      {bugDraft ? (
        <BugEditor pid={p} draft={bugDraft} onClose={() => setBugDraft(null)} />
      ) : editing ? (
        <CaseEditor pid={p} c={editing === "new" ? undefined : editing} folder={typeof sel === "number" ? sel : null} onClose={() => setEditing(null)} />
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
  const canEdit = useCanEdit();
  const p = c.pid;
  const history = data.results
    .filter((r) => r.pid === p && r.caseNum === c.num)
    .sort((a, b) => b.runNum - a.runNum);
  const bugs = data.bugs.filter((b) => b.pid === p && b.caseNum === c.num).sort((a, b) => b.num - a.num);
  const latest = history.find((r) => r.result !== "untested");
  const comments = data.comments.filter((x) => x.pid === p && x.caseNum === c.num);
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
        canEdit && (
          <>
            <button className="btn primary" onClick={onEdit}>Редактировать</button>
            <button className="btn" onClick={newBug}>Завести баг</button>
            <div className="spacer" />
            <button className="btn danger" onClick={onDelete}>Удалить</button>
          </>
        )
      }
    >
      {c.folder !== null && <div className="view-block"><span className="label">Папка</span><span>{folderPath(data, c.folder)}</span></div>}
      <div className="row2">
        <div className="view-block"><span className="label">Приоритет</span><Prio p={c.priority} /></div>
        <div className="view-block">
          <span className="label">Статус</span>
          <select className="input" value={c.status} disabled={!canEdit} onChange={(e) => { const status = e.target.value; write(() => api("PATCH", paths.testCase(p, c.num), { status }), `Статус: ${find(CASE_STATUSES, status as TestCase["status"]).label}`); }}>
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
      <Comments list={comments} postUrl={`${paths.testCase(p, c.num)}/comments`} />
    </Drawer>
  );
}

function CaseEditor({ pid, c, folder, onClose }: { pid: string; c?: TestCase; folder: number | null; onClose: () => void }) {
  const { write, toast } = useStore();
  // новый кейс по умолчанию попадает в папку, открытую в дереве
  const [f, setF] = useState({
    title: c?.title || "", priority: c?.priority || "medium", status: c?.status || "draft",
    pre: c?.pre || "", steps: c?.steps || "", expected: c?.expected || "", folder: String((c ? c.folder : folder) ?? ""),
  });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const aiReady = useAiReady();
  const ai = useAi();
  const [beforeAi, setBeforeAi] = useState<typeof f | null>(null);

  async function draft() {
    if (!f.title.trim()) return setErr("Сначала напишите название: по нему модель составит шаги");
    setErr("");
    const r = await ai.run(() => api<{ pre: string; steps: string; expected: string }>("POST", paths.aiCaseDraft(pid), f));
    if (!r) return;
    setBeforeAi(f);
    setF((cur) => ({ ...cur, ...r }));
    toast(AI_NOTE);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setErr("Укажите название тест-кейса");
    const body = { ...f, folder: f.folder ? Number(f.folder) : null };
    if (c) {
      if (await write(() => api("PATCH", paths.testCase(pid, c.num), body), "Изменения сохранены")) {
        onClose();
        go("p", pid, "cases", c.num);
      }
      return;
    }
    let num = 0;
    if (await write(async () => { num = (await api<{ num: number }>("POST", paths.cases(pid), body)).num; })) {
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
        <div className="field"><label htmlFor="c-folder">Папка</label>
          <select className="input" id="c-folder" value={f.folder} onChange={set("folder")}><FolderOptions pid={pid} /></select></div>
        <div className="row2">
          <div className="field"><label htmlFor="c-prio">Приоритет</label>
            <select className="input" id="c-prio" value={f.priority} onChange={set("priority")}>{PRIORITIES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
          <div className="field"><label htmlFor="c-status">Статус</label>
            <select className="input" id="c-status" value={f.status} onChange={set("status")}>{CASE_STATUSES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
        </div>
        {aiReady && (
          <AiBar busy={ai.busy} onRun={draft} label="Заполнить по названию" hint="Модель предложит предусловия, шаги и ожидаемый результат"
            onUndo={beforeAi ? () => { setF(beforeAi); setBeforeAi(null); } : undefined} />
        )}
        <div className="field"><label htmlFor="c-pre">Предусловия</label><textarea className="input" id="c-pre" rows={2} value={f.pre} onChange={set("pre")} /></div>
        <div className="field"><label htmlFor="c-steps">Шаги</label><textarea className="input" id="c-steps" rows={5} placeholder="Каждый шаг с новой строки" value={f.steps} onChange={set("steps")} /></div>
        <div className="field"><label htmlFor="c-exp">Ожидаемый результат</label><textarea className="input" id="c-exp" rows={3} value={f.expected} onChange={set("expected")} /></div>
        <div className="err">{err}</div>
      </form>
    </Drawer>
  );
}
