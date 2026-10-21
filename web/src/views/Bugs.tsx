import { useState, type FormEvent } from "react";
import { api, paths } from "../api";
import { BUG_FLOW, BUG_STATUSES, find, isOpenBug, SEVERITIES, transitionLabel } from "../labels";
import { go, href } from "../router";
import { assigneesOf } from "../selectors";
import { useCanEdit, useData, useStore } from "../store";
import type { Bug, BugStatus, Project, Result, Run, Severity, TestCase } from "../types";
import { Confirm, Drawer, Empty, fmt, Modal, Pill, ResultPill, Sev, TextBlock, useNames, Who } from "../ui";
import { Attachments } from "./Attachments";

export interface BugDraft {
  title: string;
  severity: Severity;
  assignee: string;
  env: string;
  steps: string;
  actual: string;
  expected: string;
  caseNum?: number;
  runNum?: number;
}

const SEV_BY_PRIO: Record<TestCase["priority"], Severity> = { critical: "critical", high: "major", medium: "major", low: "minor" };

// Баг из упавшего кейса: шаги, ожидаемый результат и окружение переносятся из кейса и прогона
export function draftFromCase(c: TestCase, run?: Run, result?: Result): BugDraft {
  return {
    title: c.title,
    severity: SEV_BY_PRIO[c.priority],
    assignee: "",
    env: run ? [run.build && `Сборка ${run.build}`, run.env].filter(Boolean).join(", ") : "",
    steps: [c.pre && `Предусловия: ${c.pre}`, c.steps].filter(Boolean).join("\n"),
    actual: result?.comment || "",
    expected: c.expected,
    caseNum: c.num,
    runNum: run?.num,
  };
}

const EMPTY: BugDraft = { title: "", severity: "major", assignee: "", env: "", steps: "", actual: "", expected: "" };

export function BugsTab({ project, openNum }: { project: Project; openNum?: number }) {
  const data = useData();
  const { me } = useStore();
  const canEdit = useCanEdit();
  const p = project.id;
  const [q, setQ] = useState("");
  const [fStatus, setFStatus] = useState("open");
  const [fSev, setFSev] = useState("all");
  const [fWho, setFWho] = useState("all");
  const [editing, setEditing] = useState<{ bug?: Bug; draft: BugDraft } | null>(null);
  const nameOf = useNames();

  const all = data.bugs.filter((b) => b.pid === p);
  const needle = q.trim().toLowerCase();
  const rows = all
    .filter((b) =>
      (fStatus === "all" || (fStatus === "open" ? isOpenBug(b.status) : b.status === fStatus)) &&
      (fSev === "all" || b.severity === fSev) &&
      (fWho === "all" || (fWho === "none" ? !b.assignee : b.assignee === fWho)) &&
      (!needle || b.title.toLowerCase().includes(needle) || b.id.toLowerCase().includes(needle)))
    // сначала самые серьёзные, внутри — свежие
    .sort((a, b) => SEVERITIES.findIndex((s) => s.key === a.severity) - SEVERITIES.findIndex((s) => s.key === b.severity) || b.num - a.num);
  const viewing = openNum !== undefined ? all.find((b) => b.num === openNum) : undefined;
  const users = Object.keys(data.users).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  return (
    <>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Поиск по заголовку или ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" aria-label="Статус" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="open">Открытые</option>
          <option value="all">Все статусы</option>
          {BUG_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="input" aria-label="Серьёзность" value={fSev} onChange={(e) => setFSev(e.target.value)}>
          <option value="all">Любая серьёзность</option>
          {SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="input" aria-label="Исполнитель" value={fWho} onChange={(e) => setFWho(e.target.value)}>
          <option value="all">Любой исполнитель</option>
          {me && <option value={me.login}>Назначены мне</option>}
          <option value="none">Не назначены</option>
          {users.filter((u) => u !== me?.login).map((u) => <option key={u} value={u}>{nameOf(u)}</option>)}
        </select>
        {canEdit && <button className="btn primary" onClick={() => setEditing({ draft: EMPTY })}>+ Баг</button>}
      </div>
      {all.length === 0 ? (
        <Empty title="Багов пока нет">
          {canEdit ? "Заведите баг вручную или прямо из упавшего кейса в прогоне: шаги и ожидаемый результат подставятся сами." : "Здесь появятся баги, которые заведут тестировщики."}
          {canEdit && <button className="btn primary" onClick={() => setEditing({ draft: EMPTY })}>+ Баг</button>}
        </Empty>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>ID</th><th>Заголовок</th><th style={{ width: 150 }}>Серьёзность</th><th style={{ width: 130 }}>Статус</th>
                <th style={{ width: 170 }}>Исполнитель</th><th style={{ width: 90 }}>Кейс</th><th style={{ width: 120 }}>Обновлён</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const st = find(BUG_STATUSES, b.status);
                return (
                  <tr key={b.id} className="click" aria-selected={viewing?.num === b.num} onClick={() => go("p", p, "bugs", b.num)}>
                    <td className="id">{b.id}</td>
                    <td className="title">{b.title}</td>
                    <td><Sev s={b.severity} /></td>
                    <td><Pill tone={st.tone} label={st.label} /></td>
                    <td className="small"><Who login={b.assignee} /></td>
                    <td onClick={(e) => e.stopPropagation()}>{b.caseNum && <a className="chip" href={href("p", p, "cases", b.caseNum)}>{p}-{b.caseNum}</a>}</td>
                    <td className="muted small nowrap">{fmt(b.updated)}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={7} className="nores">Ничего не найдено. Сбросьте фильтры или измените запрос.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <BugEditor pid={p} bug={editing.bug} draft={editing.draft} onClose={() => setEditing(null)} />
      ) : viewing ? (
        <BugDrawer bug={viewing} onClose={() => go("p", p, "bugs")} onEdit={() => {
          const { title, severity, assignee, env, steps, actual, expected } = viewing;
          setEditing({ bug: viewing, draft: { title, severity, assignee: assignee || "", env, steps, actual, expected } });
        }} />
      ) : null}
    </>
  );
}

function BugDrawer({ bug, onClose, onEdit }: { bug: Bug; onClose: () => void; onEdit: () => void }) {
  const data = useData();
  const { write } = useStore();
  const canEdit = useCanEdit();
  const nameOf = useNames();
  const [dupOpen, setDupOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const p = bug.pid;
  const st = find(BUG_STATUSES, bug.status);
  const linkedCase = bug.caseNum ? data.cases.find((c) => c.pid === p && c.num === bug.caseNum) : undefined;
  const run = bug.runNum ? data.runs.find((r) => r.pid === p && r.num === bug.runNum) : undefined;
  const result = bug.resultId ? data.results.find((r) => r.id === bug.resultId) : undefined;
  const original = bug.duplicateOf ? data.bugs.find((b) => b.pid === p && b.num === bug.duplicateOf) : undefined;
  const duplicates = data.bugs.filter((b) => b.pid === p && b.duplicateOf === bug.num);
  const files = data.attachments.filter((a) => a.pid === p && a.bugNum === bug.num);
  const resultFiles = result ? data.attachments.filter((a) => a.resultId === result.id) : [];

  const patch = (body: object, msg: string) => write(() => api("PATCH", paths.bug(p, bug.num), body), msg);
  const move = (to: BugStatus) => (to === "duplicate" ? setDupOpen(true) : patch({ status: to }, `Статус: ${find(BUG_STATUSES, to).label}`));

  return (
    <Drawer
      label="Баг"
      idTag={bug.id}
      title={bug.title}
      onClose={onClose}
      footer={
        canEdit && (
          <>
            <button className="btn primary" onClick={onEdit}>Редактировать</button>
            <div className="spacer" />
            <button className="btn danger" onClick={() => setDeleting(true)}>Удалить</button>
          </>
        )
      }
    >
      <div className="view-block">
        <span className="label">Статус</span>
        <div className="flow" style={{ alignItems: "center" }}>
          <Pill tone={st.tone} label={st.label} />
          {canEdit && <span className="muted">→</span>}
          {canEdit && BUG_FLOW[bug.status].map((to) => (
            <button key={to} className={`btn sm${to === "fixed" || to === "verified" || to === "closed" ? " primary" : ""}`} onClick={() => move(to)}>
              {transitionLabel(bug.status, to)}
            </button>
          ))}
        </div>
        {original && <span className="small">Дубликат <a href={href("p", p, "bugs", original.num)}>{original.id}</a> «{original.title}»</span>}
        {duplicates.length > 0 && (
          <span className="small muted">
            Дубликаты: {duplicates.map((d, i) => <span key={d.id}>{i > 0 && ", "}<a href={href("p", p, "bugs", d.num)}>{d.id}</a></span>)}
          </span>
        )}
      </div>
      <div className="row2">
        <div className="view-block">
          <span className="label">Серьёзность</span>
          <select className="input" value={bug.severity} disabled={!canEdit} onChange={(e) => patch({ severity: e.target.value }, "Серьёзность изменена")}>
            {SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        <div className="view-block">
          <span className="label">Исполнитель</span>
          <select className="input" value={bug.assignee || ""} disabled={!canEdit} onChange={(e) => patch({ assignee: e.target.value }, e.target.value ? `Назначен: ${nameOf(e.target.value)}` : "Исполнитель снят")}>
            <option value="">Не назначен</option>
            {/* прежний исполнитель остаётся в списке, даже если его убрали из проекта */}
            {[...new Set([...assigneesOf(data, p), ...(bug.assignee ? [bug.assignee] : [])])].map((u) => <option key={u} value={u}>{nameOf(u)}</option>)}
          </select>
        </div>
      </div>
      <TextBlock label="Окружение / версия" text={bug.env} />
      <TextBlock label="Шаги воспроизведения" text={bug.steps} empty="Не указаны" steps />
      <div className="row2">
        <TextBlock label="Фактический результат" text={bug.actual} empty="Не указан" />
        <TextBlock label="Ожидаемый результат" text={bug.expected} empty="Не указан" />
      </div>
      {(linkedCase || run) && (
        <div className="linkbox">
          {linkedCase && <>Найден по кейсу <a href={href("p", p, "cases", linkedCase.num)}>{linkedCase.id}</a> «{linkedCase.title}»</>}
          {run && <> в прогоне <a href={href("p", p, "runs", run.num)}>{run.id}</a>{run.build && ` (сборка ${run.build})`}</>}
          {result && <> · сейчас: <ResultPill r={result.result} sm /></>}
        </div>
      )}
      <Attachments list={files} uploadUrl={canEdit ? `${paths.bug(p, bug.num)}/attachments` : undefined} paste={canEdit} />
      {resultFiles.length > 0 && <Attachments list={resultFiles} label={`Вложения из прогона ${run?.id || ""}`} />}
      <div className="row2 small">
        <div className="view-block"><span className="label">Создал</span><Who login={bug.createdBy} /><span className="muted">{fmt(bug.created)}</span></div>
        <div className="view-block"><span className="label">Изменил</span><Who login={bug.updatedBy} /><span className="muted">{fmt(bug.updated)}</span></div>
      </div>

      {dupOpen && <DuplicateModal bug={bug} onClose={() => setDupOpen(false)} />}
      {deleting && (
        <Confirm
          title={`Удалить ${bug.id}?`}
          text={`Баг «${bug.title}» и его вложения будут удалены у всех участников. Обычно вместо удаления баг закрывают или отклоняют.`}
          onClose={() => setDeleting(false)}
          onYes={async () => {
            setDeleting(false);
            if (await write(() => api("DELETE", paths.bug(p, bug.num), {}), "Баг удалён")) onClose();
          }}
        />
      )}
    </Drawer>
  );
}

function DuplicateModal({ bug, onClose }: { bug: Bug; onClose: () => void }) {
  const data = useData();
  const { write } = useStore();
  const others = data.bugs.filter((b) => b.pid === bug.pid && b.num !== bug.num && b.status !== "duplicate").sort((a, b) => b.num - a.num);
  const [target, setTarget] = useState(others[0]?.num ?? 0);
  return (
    <Modal onClose={onClose}>
      <h2>Дубликат какого бага?</h2>
      {others.length ? (
        <select className="input" value={target} onChange={(e) => setTarget(Number(e.target.value))} autoFocus>
          {others.map((b) => <option key={b.num} value={b.num}>{b.id} — {b.title}</option>)}
        </select>
      ) : (
        <p className="muted" style={{ margin: 0 }}>В проекте нет других багов.</p>
      )}
      <div className="acts">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!others.length}
          onClick={async () => { if (await write(() => api("PATCH", paths.bug(bug.pid, bug.num), { status: "duplicate", duplicateOf: target }), "Отмечен как дубликат")) onClose(); }}>
          Отметить дубликатом
        </button>
      </div>
    </Modal>
  );
}

export function BugEditor({ pid, bug, draft, onClose }: { pid: string; bug?: Bug; draft: BugDraft; onClose: () => void }) {
  const data = useData();
  const { write, toast } = useStore();
  const nameOf = useNames();
  const [f, setF] = useState(draft);
  const [err, setErr] = useState("");
  const set = (k: keyof BugDraft) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const linkedCase = draft.caseNum ? data.cases.find((c) => c.pid === pid && c.num === draft.caseNum) : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setErr("Укажите заголовок бага");
    if (bug) {
      if (await write(() => api("PATCH", paths.bug(pid, bug.num), f), "Изменения сохранены")) onClose();
      return;
    }
    let num = 0;
    if (await write(async () => { num = (await api<{ num: number }>("POST", paths.bugs(pid), f)).num; })) {
      toast(`Создан ${pid}-B${num}. Можно приложить скриншоты`);
      onClose();
      go("p", pid, "bugs", num);
    }
  }

  return (
    <Drawer label={bug ? "Редактирование бага" : "Новый баг"} idTag={bug?.id} title={bug ? "Редактирование" : "Новый баг"} onClose={onClose}
      footer={<><button className="btn primary" type="submit" form="bugForm">{bug ? "Сохранить" : "Создать баг"}</button><button className="btn" type="button" onClick={onClose}>Отмена</button></>}>
      <form id="bugForm" onSubmit={submit} noValidate>
        {!bug && linkedCase && (
          <div className="linkbox">
            Баг будет связан с кейсом <b>{linkedCase.id}</b>{draft.runNum ? <> и прогоном <b>{pid}-R{draft.runNum}</b></> : null}. Поля заполнены из кейса, поправьте их под то, что случилось.
          </div>
        )}
        <div className="field"><label htmlFor="b-title">Заголовок *</label><input className="input" id="b-title" value={f.title} onChange={set("title")} placeholder="Что сломалось, коротко" autoFocus /></div>
        <div className="row2">
          <div className="field"><label htmlFor="b-sev">Серьёзность</label>
            <select className="input" id="b-sev" value={f.severity} onChange={set("severity")}>{SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
          <div className="field"><label htmlFor="b-who">Исполнитель</label>
            <select className="input" id="b-who" value={f.assignee} onChange={set("assignee")}>
              <option value="">Не назначен</option>
              {[...new Set([...assigneesOf(data, pid), ...(draft.assignee ? [draft.assignee] : [])])].map((u) => <option key={u} value={u}>{nameOf(u)}</option>)}
            </select></div>
        </div>
        <div className="field"><label htmlFor="b-env">Окружение / версия</label><input className="input" id="b-env" value={f.env} onChange={set("env")} placeholder="Сборка 1.4.2, Chrome 130, staging" /></div>
        <div className="field"><label htmlFor="b-steps">Шаги воспроизведения</label><textarea className="input" id="b-steps" rows={5} placeholder="Каждый шаг с новой строки" value={f.steps} onChange={set("steps")} /></div>
        <div className="field"><label htmlFor="b-act">Фактический результат</label><textarea className="input" id="b-act" rows={3} value={f.actual} onChange={set("actual")} placeholder="Что произошло на самом деле" /></div>
        <div className="field"><label htmlFor="b-exp">Ожидаемый результат</label><textarea className="input" id="b-exp" rows={3} value={f.expected} onChange={set("expected")} /></div>
        <div className="err">{err}</div>
      </form>
    </Drawer>
  );
}
