import { useState, type FormEvent } from "react";
import { ReleaseSelect } from "./Releases";
import { WatchButton } from "./Notifications";
import { FieldsEditor, FieldsView, missingRequired, TagInput, Tags, useFields, useProjectTags } from "../casekit";
import { AI_NOTE, AiBar, useAi, useAiReady } from "../ai";
import { api, paths } from "../api";
import { BUG_FLOW, BUG_STATUSES, find, isOpenBug, SEVERITIES, transitionLabel } from "../labels";
import { go, href } from "../router";
import { assigneesOf, countBy } from "../selectors";
import { useCan, useData, useLoad, useStore } from "../store";
import type { Bug, BugStatus, FieldValues, Project, Result, Run, Severity, TestCase } from "../types";
import { CommentCount, Confirm, Drawer, Empty, fmt, Modal, Pill, ResultPill, Sev, TextBlock, useNames, Who, PagedRows } from "../ui";
import { Attachments } from "./Attachments";
import { Comments } from "./Comments";
import { SaveAsTemplate, TemplatePicker } from "./Templates";

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
  tags?: string[];
  fields?: FieldValues;
}

const SEV_BY_PRIO: Record<TestCase["priority"], Severity> = { critical: "critical", high: "major", medium: "major", low: "minor" };

// Баг из упавшего кейса: шаги, ожидаемый результат и окружение переносятся из кейса и прогона.
// item — упавший пункт чек-листа: баг про него, а сам пункт и есть ожидаемый результат
export function draftFromCase(c: TestCase, run?: Run, result?: Result, item?: string, step?: number): BugDraft {
  // баг из упавшего шага: шаги до него включительно, фактический — что записали у шага, ожидаемый — ожидаемый шага
  const list = c.stepList?.length ? c.stepList : [];
  if (step !== undefined && list[step]) {
    const st = list[step];
    const sr = result?.steps?.[step];
    return {
      title: `${c.title}: шаг ${step + 1}`.slice(0, 500),
      severity: SEV_BY_PRIO[c.priority],
      assignee: "",
      env: run ? [run.build && `Сборка ${run.build}`, run.env].filter(Boolean).join(", ") : "",
      steps: [c.pre && `Предусловия: ${c.pre}`, ...list.slice(0, step + 1).map((s) => s.action + (s.data ? ` (${s.data})` : ""))].filter(Boolean).join("\n"),
      actual: sr?.actual || result?.comment || "",
      expected: st.expected || c.expected,
      caseNum: c.num,
      runNum: run?.num,
    };
  }
  return {
    title: item ? `${c.title}: ${item}`.slice(0, 500) : c.title,
    severity: SEV_BY_PRIO[c.priority],
    assignee: "",
    env: run ? [run.build && `Сборка ${run.build}`, run.env].filter(Boolean).join(", ") : "",
    steps: item ? `Чек-лист ${c.id} «${c.title}»\nНе выполняется пункт: ${item}` : [c.pre && `Предусловия: ${c.pre}`, c.steps].filter(Boolean).join("\n"),
    actual: result?.comment || "",
    expected: item || c.expected,
    caseNum: c.num,
    runNum: run?.num,
  };
}

const EMPTY: BugDraft = { title: "", severity: "major", assignee: "", env: "", steps: "", actual: "", expected: "" };

export function BugsTab({ project, openNum }: { project: Project; openNum?: number }) {
  const data = useData();
  const { me } = useStore();
  const canEdit = useCan("bugs.create");
  const p = project.id;
  const [q, setQ] = useState("");
  const [fStatus, setFStatus] = useState("open");
  const [fSev, setFSev] = useState("all");
  const [fWho, setFWho] = useState("all");
  const [fTag, setFTag] = useState("");
  const tagList = useProjectTags("bugs");
  const [editing, setEditing] = useState<{ bug?: Bug; draft: BugDraft } | null>(null);
  const nameOf = useNames();

  const all = data.bugs.filter((b) => b.pid === p);
  const needle = q.trim().toLowerCase();
  const rows = all
    .filter((b) =>
      (fStatus === "all" || (fStatus === "open" ? isOpenBug(b.status) : b.status === fStatus)) &&
      (fSev === "all" || b.severity === fSev) &&
      (fWho === "all" || (fWho === "none" ? !b.assignee : b.assignee === fWho)) &&
      (!fTag || b.tags?.includes(fTag)) &&
      (!needle || b.title.toLowerCase().includes(needle) || b.id.toLowerCase().includes(needle)))
    // сначала самые серьёзные, внутри — свежие
    .sort((a, b) => SEVERITIES.findIndex((s) => s.key === a.severity) - SEVERITIES.findIndex((s) => s.key === b.severity) || b.num - a.num);
  const viewing = openNum !== undefined ? all.find((b) => b.num === openNum) : undefined;
  const users = Object.keys(data.users).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const talk = countBy(data.comments.filter((c) => c.pid === p), (c) => c.bugNum);

  return (
    <>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Поиск по заголовку или ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" aria-label="Статус" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="open">Открытые</option>
          <option value="all">Все статусы</option>
          {BUG_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {tagList.length > 0 && (
          <select className="input" aria-label="Тег" value={fTag} onChange={(e) => setFTag(e.target.value)}>
            <option value="">Любой тег</option>
            {tagList.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
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
              <PagedRows items={rows} reset={`${fStatus}|${fSev}|${fWho}|${fTag}|${needle}`}>{(b) => {
                const st = find(BUG_STATUSES, b.status);
                return (
                  <tr key={b.id} className="click" aria-selected={viewing?.num === b.num} onClick={() => go("p", p, "bugs", b.num)}>
                    <td className="id">{b.id}</td>
                    <td className="title">{b.title}<CommentCount n={talk.get(b.num)} /></td>
                    <td><Sev s={b.severity} /></td>
                    <td><Pill tone={st.tone} label={st.label} /></td>
                    <td className="small"><Who login={b.assignee} /></td>
                    <td onClick={(e) => e.stopPropagation()}>{b.caseNum && <a className="chip" href={href("p", p, "cases", b.caseNum)}>{p}-{b.caseNum}</a>}</td>
                    <td className="muted small nowrap">{fmt(b.updated)}</td>
                  </tr>
                );
              }}</PagedRows>
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
          setEditing({ bug: viewing, draft: { title, severity, assignee: assignee || "", env, steps, actual, expected, tags: viewing.tags, fields: viewing.fields } });
        }} />
      ) : null}
    </>
  );
}

function BugDrawer({ bug, onClose, onEdit }: { bug: Bug; onClose: () => void; onEdit: () => void }) {
  const data = useData();
  const { write } = useStore();
  const canEdit = useCan("bugs.edit");
  const canStatus = useCan("bugs.status");
  const canDelete = useCan("bugs.delete");
  const canAttach = useCan("bugs.create") || canEdit;
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
  const comments = data.comments.filter((c) => c.pid === p && c.bugNum === bug.num);

  const patch = (body: object, msg: string) => write(() => api("PATCH", paths.bug(p, bug.num), body), msg);
  const move = (to: BugStatus) => (to === "duplicate" ? setDupOpen(true) : patch({ status: to }, `Статус: ${find(BUG_STATUSES, to).label}`));

  return (
    <Drawer
      label="Баг"
      idTag={bug.id}
      title={bug.title}
      onClose={onClose}
      footer={
        (canEdit || canDelete) && (
          <>
            {canEdit && <button className="btn primary" onClick={onEdit}>Редактировать</button>}
            <div className="spacer" />
            {canDelete && <button className="btn danger" onClick={() => setDeleting(true)}>Удалить</button>}
          </>
        )
      }
    >
      <div className="view-block">
        <span className="label">Статус</span>
        <div className="flow" style={{ alignItems: "center" }}>
          <Pill tone={st.tone} label={st.label} />
          {canStatus && <span className="muted">→</span>}
          {canStatus && BUG_FLOW[bug.status].map((to) => (
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
      <ExternalIssue bug={bug} />
      <TextBlock label="Окружение / версия" text={bug.env} />
      <TextBlock label="Шаги воспроизведения" text={bug.steps} empty="Не указаны" steps />
      {bug.tags?.length > 0 && <div className="view-block"><span className="label">Теги</span><Tags tags={bug.tags} /></div>}
      <FieldsView entity="bug" values={bug.fields} />
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
      <Attachments list={files} uploadUrl={canAttach ? `${paths.bug(p, bug.num)}/attachments` : undefined} paste={canAttach} />
      {resultFiles.length > 0 && <Attachments list={resultFiles} label={`Вложения из прогона ${run?.id || ""}`} />}
      <div className="row2 small">
        <div className="view-block"><span className="label">Создал</span><Who login={bug.createdBy} /><span className="muted">{fmt(bug.created)}</span></div>
        <div className="view-block"><span className="label">Изменил</span><Who login={bug.updatedBy} /><span className="muted">{fmt(bug.updated)}</span></div>
      </div>
      <div><WatchButton pid={p} kind="bugs" num={bug.num} /></div>
      <Comments list={comments} postUrl={`${paths.bug(p, bug.num)}/comments`} />

      {dupOpen && <DuplicateModal bug={bug} onClose={() => setDupOpen(false)} />}
      {deleting && (
        <Confirm
          title={`Удалить ${bug.id}?`}
          text={`Баг «${bug.title}» уйдёт в корзину проекта (восстановить можно в течение 30 дней). Обычно вместо удаления баг закрывают или отклоняют.`}
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
  // релиз: у нового бага из прогона без выбора возьмётся релиз прогона
  const [rel, setRel] = useState(String(bug?.release ?? ""));
  const [err, setErr] = useState("");
  const fieldDefs = useFields("bug");
  const bugTags = useProjectTags("bugs");
  const set = (k: keyof BugDraft) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const linkedCase = draft.caseNum ? data.cases.find((c) => c.pid === pid && c.num === draft.caseNum) : undefined;
  const aiReady = useAiReady();
  const ai = useAi();
  const [beforeAi, setBeforeAi] = useState<BugDraft | null>(null);

  async function improve() {
    const r = await ai.run(() => api<Pick<BugDraft, "title" | "steps" | "actual" | "expected"> & { severity: Severity | null }>("POST", paths.aiBugDraft(pid), f));
    if (!r) return;
    setBeforeAi(f);
    setF((cur) => ({ ...cur, title: r.title, steps: r.steps, actual: r.actual, expected: r.expected, severity: r.severity || cur.severity }));
    toast(AI_NOTE);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setErr("Укажите заголовок бага");
    const missing = missingRequired(fieldDefs, f.fields || {});
    if (missing) return setErr(missing);
    if (bug) {
      if (await write(() => api("PATCH", paths.bug(pid, bug.num), { ...f, release: rel ? Number(rel) : null }), "Изменения сохранены")) onClose();
      return;
    }
    let num = 0;
    if (await write(async () => { num = (await api<{ num: number }>("POST", paths.bugs(pid), { ...f, ...(rel ? { release: Number(rel) } : {}) })).num; })) {
      toast(`Создан ${pid}-B${num}. Можно приложить скриншоты`);
      onClose();
      go("p", pid, "bugs", num);
    }
  }

  return (
    <Drawer label={bug ? "Редактирование бага" : "Новый баг"} idTag={bug?.id} title={bug ? "Редактирование" : "Новый баг"} onClose={onClose}
      footer={<>
        <button className="btn primary" type="submit" form="bugForm">{bug ? "Сохранить" : "Создать баг"}</button>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
        <div className="spacer" />
        <SaveAsTemplate pid={pid} kind="bug" data={{ severity: f.severity, env: f.env, steps: f.steps, actual: f.actual, expected: f.expected, tags: f.tags, fields: f.fields }} />
      </>}>
      <form id="bugForm" onSubmit={submit} noValidate>
        {!bug && linkedCase && (
          <div className="linkbox">
            Баг будет связан с кейсом <b>{linkedCase.id}</b>{draft.runNum ? <> и прогоном <b>{pid}-R{draft.runNum}</b></> : null}. Поля заполнены из кейса, поправьте их под то, что случилось.
          </div>
        )}
        {aiReady && (
          <AiBar busy={ai.busy} onRun={improve} label="Оформить с ИИ" hint="Перепишет заголовок, шаги и результаты из ваших заметок"
            onUndo={beforeAi ? () => { setF(beforeAi); setBeforeAi(null); } : undefined} />
        )}
        <div className="field"><label htmlFor="b-title">Заголовок *</label><input className="input" id="b-title" value={f.title} onChange={set("title")} placeholder="Что сломалось, коротко" autoFocus /></div>
        {!bug && <TemplatePicker pid={pid} kind="bug" form={f} setForm={setF} />}
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
        <div className="field"><label htmlFor="b-tags">Теги</label><TagInput id="b-tags" value={f.tags || []} onChange={(tags) => setF({ ...f, tags })} suggestions={bugTags} /></div>
        <ReleaseSelect pid={pid} value={rel} onChange={setRel} id="b-release" />
        <FieldsEditor entity="bug" values={f.fields || {}} onChange={(fields) => setF({ ...f, fields })} />
        <div className="err">{err}</div>
      </form>
    </Drawer>
  );
}

// Задача во внешнем трекере (Jira, YouTrack, GitLab, GitHub, Redmine)
function ExternalIssue({ bug }: { bug: Bug }) {
  const canEdit = useCan("bugs.edit");
  const { write } = useStore();
  const [key, setKey] = useState("");
  const tracker = useLoad<{ tracker: { kind: string } | null }>(canEdit ? paths.tracker(bug.pid) : null);
  const url = paths.bugExternal(bug.pid, bug.num);
  const ext = bug.external;
  if (!ext && (!canEdit || !tracker.value?.tracker)) return null;
  return (
    <div className="view-block">
      <span className="label">Задача в трекере</span>
      {ext ? (
        <div className="flow" style={{ alignItems: "center" }}>
          <a className="chip" href={ext.url} target="_blank" rel="noreferrer noopener">{ext.key} ↗</a>
          {ext.status && <span className="tag">{ext.status}</span>}
          {canEdit && <button className="btn sm" onClick={() => write(() => api("POST", `${url}/sync`, {}), "Статус задачи обновлён")}>Обновить статус</button>}
          {canEdit && <button className="btn ghost sm" onClick={() => write(() => api("DELETE", url, {}), "Связь с задачей снята")}>Отвязать</button>}
        </div>
      ) : (
        <div className="flow" style={{ alignItems: "center" }}>
          <button className="btn sm primary" onClick={() => write(() => api("POST", url, { create: true }), "Задача создана в трекере")}>Создать задачу</button>
          <span className="muted small">или</span>
          <input className="input mono" style={{ width: 140 }} placeholder="PROJ-12 / #34" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Ключ задачи" />
          <button className="btn sm" disabled={!key.trim()} onClick={async () => { if (await write(() => api("POST", url, { key: key.trim() }), "Задача привязана")) setKey(""); }}>Привязать</button>
        </div>
      )}
    </div>
  );
}
