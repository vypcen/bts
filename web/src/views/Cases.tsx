import { useState, type FormEvent } from "react";
import { AI_NOTE, AiBar, useAi, useAiReady } from "../ai";
import { emptyStep, isRef, useSharedSteps, FieldsEditor, FieldsView, missingRequired, StepsEditor, StepsView, stepsOf, TagInput, Tags, useFields, useProjectTags } from "../casekit";
import { api, paths } from "../api";
import { checklistItems, doneCount, itemsWord } from "../checklist";
import { BUG_STATUSES, CASE_STATUSES, find, isOpenBug, PRIORITIES, RESULTS } from "../labels";
import { go, href } from "../router";
import { countBy, folderPath, lastResults } from "../selectors";
import { useCan, useData, useLoad, useStore } from "../store";
import type { CaseKind, CaseVersion, Project, Result, ResultValue, TestCase } from "../types";
import { CaseRequirements } from "./Requirements";
import { SaveAsTemplate, TemplatePicker } from "./Templates";
import { SharedStepsModal } from "./SharedSteps";
import { DatasetsModal, ParamsEditor, paramsBody, paramsForm, paramsOf, ParamsView } from "./Params";
import { ReviewBlock, statusOptions, useMyReviews, useReviewGate } from "./Review";
import { CommentCount, Confirm, Drawer, Empty, fmt, FullCase, Modal, PagedRows, Pill, Prio, ResultPill, TextBlock, useNames, Who } from "../ui";
import { BugEditor, draftFromCase, type BugDraft } from "./Bugs";
import { ImportModal } from "./CaseImport";
import { Comments } from "./Comments";
import { FolderOptions, FolderTree, inFolder, type FolderSel } from "./Folders";

type ResultFilter = "all" | ResultValue;

export function CasesTab({ project, openNum }: { project: Project; openNum?: number }) {
  const data = useData();
  const p = project.id;
  const [q, setQ] = useState("");
  const [fResult, setFResult] = useState<ResultFilter>("all");
  const [fPrio, setFPrio] = useState("all");
  const [fTag, setFTag] = useState("");
  // фильтры по полям-спискам: {id поля: значение}
  const [fFields, setFFields] = useState<Record<number, string>>({});
  const projectTags = useProjectTags("cases");
  const listFields = useFields("case").filter((d) => d.type === "select" || d.type === "multiselect" || d.type === "user");
  const fieldMatch = (c: TestCase) =>
    Object.entries(fFields).every(([id, want]) => {
      const v = c.fields?.[id];
      return !want || (Array.isArray(v) ? v.includes(want) : String(v ?? "") === want);
    });
  const [fStatus, setFStatus] = useState("active");
  // новый тест-кейс или чек-лист — по виду, существующий — сам кейс
  const [editing, setEditing] = useState<TestCase | CaseKind | null>(null);
  const [deleting, setDeleting] = useState<TestCase | null>(null);
  const [bugDraft, setBugDraft] = useState<BugDraft | null>(null);
  const [folderSel, setFolderSel] = useState<FolderSel>("all");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [moveTo, setMoveTo] = useState("");
  const [bulk, setBulk] = useState<"edit" | "delete" | null>(null);
  const [sharedOpen, setSharedOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const { write, toast } = useStore();
  const canEdit = useCan("cases.edit");
  const canDelete = useCan("cases.delete");
  const myReviews = useMyReviews(p);
  // выбранную папку могли удалить в другой вкладке или другие участники
  const sel: FolderSel = typeof folderSel === "number" && !data.folders.some((f) => f.id === folderSel) ? "all" : folderSel;

  const all = data.cases.filter((c) => c.pid === p);
  const last = lastResults(data, p);
  const resultOf = (c: TestCase): ResultValue => last.get(c.num)?.result || "untested";
  const talk = countBy(data.comments.filter((x) => x.pid === p), (x) => x.caseNum);
  // открытые баги по кейсам: один проход по багам вместо фильтра на каждую строку таблицы
  const bugsByCase = new Map<number, typeof data.bugs>();
  for (const b of data.bugs) if (b.pid === p && b.caseNum !== null && isOpenBug(b.status)) bugsByCase.set(b.caseNum, [...(bugsByCase.get(b.caseNum) || []), b]);
  const openBugs = (c: TestCase) => bugsByCase.get(c.num) || [];
  const scoped = all.filter((c) => (fStatus === "all" || (fStatus === "active" ? c.status !== "deprecated" : fStatus === "my-review" ? Boolean(myReviews?.has(c.num)) : c.status === fStatus)) && (fPrio === "all" || c.priority === fPrio)
    && (!fTag || c.tags?.includes(fTag)) && fieldMatch(c));
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
        {/* выгружается то, что выбрано в дереве папок: весь проект, кейсы без папки или папка с подпапками */}
        {all.length > 0 && (
          <a className="btn" href={`${paths.casesExport(p)}?folder=${sel}`} style={{ textDecoration: "none" }}
            title={sel === "all" ? "Все кейсы проекта в CSV" : "Кейсы выбранной папки в CSV"}>Экспорт</a>
        )}
        <button className="btn" onClick={() => setSharedOpen(true)} title="Блоки шагов, которые повторяются в разных кейсах">Общие шаги</button>
        <button className="btn" onClick={() => setDataOpen(true)} title="Таблицы значений для кейсов с параметрами">Наборы данных</button>
        {canEdit && <button className="btn" onClick={() => setImporting(true)}>Импорт</button>}
        {canEdit && <button className="btn primary" onClick={() => setEditing("case")}>+ Тест-кейс</button>}
      </div>
      {sharedOpen && <SharedStepsModal pid={p} onClose={() => setSharedOpen(false)} />}
      {dataOpen && <DatasetsModal pid={p} onClose={() => setDataOpen(false)} />}
      {bulk === "edit" && <BulkEditModal pid={p} nums={shown.map((c) => c.num)} tags={projectTags} onClose={(done) => { setBulk(null); if (done) setPicked(new Set()); }} />}
      {bulk === "delete" && (
        <Confirm
          title={`Удалить кейсы (${shown.length})?`}
          text="Кейсы уйдут в корзину проекта вместе с версиями, результатами и комментариями — их можно восстановить в течение 30 дней. Кейсы из заблокированных тест-планов останутся."
          action="Удалить"
          onClose={() => setBulk(null)}
          onYes={async () => {
            setBulk(null);
            let r = { deleted: 0, locked: [] as number[] };
            if (await write(async () => { r = await api("POST", `${paths.cases(p)}/bulk-delete`, { nums: shown.map((c) => c.num) }); })) {
              toast(`Удалено в корзину: ${r.deleted}${r.locked.length ? `, в заблокированных планах (остались): ${r.locked.length}` : ""}`);
              setPicked(new Set());
            }
          }}
        />
      )}
      {importing && <ImportModal pid={p} onClose={() => setImporting(false)} />}
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
          {myReviews && <option value="my-review">Мне на ревью{myReviews.size ? ` (${myReviews.size})` : ""}</option>}
        </select>
        {projectTags.length > 0 && (
          <select className="input" aria-label="Тег" value={fTag} onChange={(e) => setFTag(e.target.value)}>
            <option value="">Любой тег</option>
            {projectTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {listFields.map((d) => (
          <select key={d.id} className="input" aria-label={d.name} value={fFields[d.id] || ""} onChange={(e) => setFFields({ ...fFields, [d.id]: e.target.value })}>
            <option value="">{d.name}: любое</option>
            {(d.type === "user" ? Object.keys(data.users) : d.options).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ))}
      </div>
      {canEdit && shown.length > 0 && (
        <div className="bulk">
          <b>Выбрано: {shown.length}</b>
          <span className="muted">Переместить в</span>
          <select className="input" aria-label="Папка назначения" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <FolderOptions pid={p} rootLabel="— корень проекта (без папки) —" />
          </select>
          <button className="btn primary sm" onClick={move}>Переместить</button>
          <button className="btn sm" onClick={() => setBulk("edit")}>Изменить…</button>
          {canDelete && <button className="btn sm danger" onClick={() => setBulk("delete")}>Удалить</button>}
          <button className="btn sm" onClick={() => setPicked(new Set())}>Снять выделение</button>
        </div>
      )}
      {all.length === 0 ? (
        <Empty title="В проекте нет тест-кейсов">
          {canEdit ? "Добавьте первый: тест-кейс с шагами и ожидаемым результатом или чек-лист — список коротких проверок." : "Здесь появятся тест-кейсы, которые заведут тестировщики."}
          {canEdit && (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" onClick={() => setEditing("case")}>+ Тест-кейс</button>
              <button className="btn" onClick={() => setEditing("checklist")}>+ Чек-лист</button>
            </div>
          )}
        </Empty>
      ) : (
        // два блока с одними и теми же папками и фильтрами: тест-кейсы, под ними — чек-листы
        (["case", "checklist"] as const).map((kind) => {
          const list = rows.filter((c) => c.kind === kind);
          const inScope = base.filter((c) => c.kind === kind).length;
          const anyInProject = all.some((c) => c.kind === kind);
          const pickedHere = list.filter((c) => picked.has(c.num)).length;
          const allHere = list.length > 0 && pickedHere === list.length;
          const pickAll = () => {
            const s = new Set(picked);
            for (const c of list) {
              if (allHere) s.delete(c.num);
              else s.add(c.num);
            }
            setPicked(s);
          };
          const isList = kind === "checklist";
          return (
            <section key={kind} className="case-block" aria-label={isList ? "Чек-листы" : "Тест-кейсы"}>
              <div className="block-head">
                <h2>{isList ? "Чек-листы" : "Тест-кейсы"}<span className="n">{list.length}</span></h2>
                {isList && <span className="muted small">короткие списки проверок: смоук, регресс, приёмка</span>}
                <div className="spacer" />
                {canEdit && isList && <button className="btn sm" onClick={() => setEditing("checklist")}>+ Чек-лист</button>}
              </div>
              {!anyInProject ? (
                <div className="nores block-empty">
                  {isList
                    ? <>Чек-листов пока нет. Это список коротких проверок без подробных шагов — в прогоне каждый пункт отмечается отдельно.</>
                    : <>Тест-кейсов пока нет.</>}
                </div>
              ) : (
                <div className="tbl-wrap">
                  <table>
                    <thead>
                      <tr>
                        {canEdit && <th style={{ width: 36 }}><input type="checkbox" aria-label={isList ? "Отметить все чек-листы" : "Отметить все тест-кейсы"} checked={allHere}
                          ref={(el) => { if (el) el.indeterminate = pickedHere > 0 && !allHere; }} onChange={pickAll} /></th>}
                        <th style={{ width: 90 }}>ID</th><th>Название</th><th style={{ width: 130 }}>Приоритет</th><th style={{ width: 110 }}>Статус</th>
                        <th style={{ width: 150 }}>Результат</th><th style={{ width: 110 }}>Баги</th><th style={{ width: 120 }}>Обновлён</th><th style={{ width: 96 }} />
                      </tr>
                    </thead>
                    <tbody>
                      <PagedRows items={list} reset={`${kind}|${sel}|${needle}|${fResult}|${fPrio}|${fStatus}|${fTag}|${JSON.stringify(fFields)}`}>{(c) => {
                        const lr = last.get(c.num);
                        const bugs = openBugs(c);
                        const st = find(CASE_STATUSES, c.status);
                        const n = checklistItems(c).length;
                        const done = doneCount(c);
                        return (
                          <tr key={c.id} className="click" aria-selected={viewing?.num === c.num} onClick={() => go("p", p, "cases", c.num)}>
                            {canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Отметить ${c.id}`} checked={picked.has(c.num)} onChange={() => togglePick(c.num)} /></td>}
                            <td className="id">{c.id}</td>
                            <td className="title">
                              {c.title}<CommentCount n={talk.get(c.num)} /> <Tags tags={c.tags} />
                              {isList && (
                                <span className="muted small" style={{ fontWeight: 400 }}>
                                  {" · "}{done ? `выполнено ${done} из ${n}` : `${n} ${itemsWord(n)}`}
                                </span>
                              )}
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
                              {canDelete && <button className="btn ghost" onClick={() => setDeleting(c)} aria-label="Удалить" style={{ color: "var(--crit)" }}>✕</button>}
                            </td>
                          </tr>
                        );
                      }}</PagedRows>
                      {!list.length && (
                        <tr><td colSpan={canEdit ? 9 : 8} className="nores">
                          {sel !== "all" && !inScope ? `В этой папке нет ${isList ? "чек-листов" : "тест-кейсов"}.` : "Ничего не найдено. Сбросьте фильтры или измените запрос."}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })
      )}
      </div>
      </div>

      {bugDraft ? (
        <BugEditor pid={p} draft={bugDraft} onClose={() => setBugDraft(null)} />
      ) : editing ? (
        typeof editing === "string" ? (
          <CaseEditor pid={p} kind={editing} folder={typeof sel === "number" ? sel : null} onClose={() => setEditing(null)} />
        ) : (
          // редактор открывается только с полным текстом кейса: иначе сохранение затёрло бы шаги пустыми
          <FullCase c={editing}>{(full) => <CaseEditor pid={p} c={full} kind={full.kind} folder={null} onClose={() => setEditing(null)} />}</FullCase>
        )
      ) : viewing ? (
        <FullCase c={viewing}>{(full) => <CaseDrawer c={full} onClose={close} onEdit={() => setEditing(full)} onDelete={() => setDeleting(viewing)} onBug={setBugDraft} />}</FullCase>
      ) : null}
      {deleting && (
        <Confirm
          title={`Удалить ${deleting.id}?`}
          text={`Тест-кейс «${deleting.title}» с историей результатов уйдёт в корзину проекта — оттуда его можно восстановить в течение 30 дней.`}
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
  const canEdit = useCan("cases.edit");
  const canDelete = useCan("cases.delete");
  const canMark = useCan("runs.execute");
  const canBug = useCan("bugs.create");
  const reviewGate = useReviewGate(c.pid);
  const { reload, toast } = useStore();
  const nameOf = useNames();
  const [resetting, setResetting] = useState(false);
  const p = c.pid;
  const items = checklistItems(c);
  // флажок переключается сразу, не дожидаясь сервера; каждый пункт сохраняется своим запросом,
  // поэтому быстрые клики по нескольким пунктам не теряются. При ошибке отметка вернётся как была
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const isDone = (item: string) => pending[item] ?? Boolean(c.checked?.[item]);
  const done = items.filter(isDone).length;
  const check = async (item: string, value: boolean) => {
    setPending((s) => ({ ...s, [item]: value }));
    try {
      await api("POST", `${paths.testCase(p, c.num)}/check`, { item, done: value });
      await reload();
    } catch (e: any) {
      toast(e.message || "Не удалось сохранить отметку");
    } finally {
      setPending((s) => {
        const next = { ...s };
        delete next[item];
        return next;
      });
    }
  };
  // история по прогонам грузится отдельно: в данных проекта только последний результат кейса
  const historyLoad = useLoad<{ results: Result[] }>(paths.caseHistory(p, c.num));
  const history = historyLoad.value?.results || data.results.filter((r) => r.pid === p && r.caseNum === c.num);
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
      label={c.kind === "checklist" ? "Чек-лист" : "Тест-кейс"}
      idTag={c.id}
      title={c.title}
      onClose={onClose}
      footer={
        (canEdit || canBug || canDelete) && (
          <>
            {canEdit && <button className="btn primary" onClick={onEdit}>Редактировать</button>}
            {canBug && <button className="btn" onClick={newBug}>Завести баг</button>}
            <div className="spacer" />
            {canDelete && <button className="btn danger" onClick={onDelete}>Удалить</button>}
          </>
        )
      }
    >
      {c.folder !== null && <div className="view-block"><span className="label">Папка</span><span>{folderPath(data, c.folder)}</span></div>}
      <CaseRequirements pid={p} caseNum={c.num} />
      <ReviewBlock c={c} />
      <div className="row2">
        <div className="view-block"><span className="label">Приоритет</span><Prio p={c.priority} /></div>
        <div className="view-block">
          <span className="label">Статус</span>
          <select className="input" aria-label="Статус кейса" value={c.status} disabled={!canEdit} onChange={(e) => { const status = e.target.value; write(() => api("PATCH", paths.testCase(p, c.num), { status }), `Статус: ${find(CASE_STATUSES, status as TestCase["status"]).label}`); }}>
            {statusOptions(c.status, reviewGate)}
          </select>
        </div>
      </div>
      {c.kind === "checklist" ? (
        <div className="view-block">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="label">Пункты · выполнено {done} из {items.length}</span>
            <div className="spacer" />
            {canMark && done > 0 && <button className="btn ghost sm" onClick={() => setResetting(true)}>Снять все отметки</button>}
          </div>
          <div className="done-list">
            {items.map((item) => {
              const mark = c.checked?.[item];
              return (
                <label key={item} className={isDone(item) ? "is-done" : undefined}
                  title={mark ? `Отметил ${nameOf(mark.by)} · ${fmt(new Date(mark.at).getTime())}` : undefined}>
                  <input type="checkbox" checked={isDone(item)} disabled={!canMark} onChange={(e) => check(item, e.target.checked)} />
                  <span className="item-text">{item}</span>
                </label>
              );
            })}
          </div>
          <span className="muted small">Отметки видны всем участникам. Чтобы проверить сборку и сохранить историю результатов, добавьте чек-лист в прогон.</span>
        </div>
      ) : (
        <>
          <TextBlock label="Предусловия" text={c.pre} empty="Не указаны" />
          <div className="view-block"><span className="label">Шаги</span><StepsView steps={stepsOf(c)} /></div>
          {paramsOf(c) && (
            <div className="view-block">
              <span className="label">Параметры{c.dataset ? ` · набор «${c.dataset.name}»` : ""} · {paramsOf(c)!.rows.length} наб.</span>
              <ParamsView table={paramsOf(c)!} />
              <span className="muted small">В прогоне кейс проверяется по разу на каждый набор</span>
            </div>
          )}
          <TextBlock label="Ожидаемый результат" text={c.expected} empty="Не указан" />
        </>
      )}
      {c.tags?.length > 0 && <div className="view-block"><span className="label">Теги</span><Tags tags={c.tags} /></div>}
      <FieldsView entity="case" values={c.fields} />

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
      <Versions c={c} />
      <Comments list={comments} postUrl={`${paths.testCase(p, c.num)}/comments`} />
      {resetting && (
        <Confirm title="Снять все отметки?" text={`Все ${done} отмеченных пунктов станут невыполненными — у всех участников.`} action="Снять"
          onClose={() => setResetting(false)}
          onYes={async () => {
            setResetting(false);
            await write(() => api("POST", `${paths.testCase(p, c.num)}/check`, { reset: true }), "Отметки сняты");
          }} />
      )}
    </Drawer>
  );
}

function CaseEditor({ pid, c, kind, folder, onClose }: { pid: string; c?: TestCase; kind: CaseKind; folder: number | null; onClose: () => void }) {
  const { write, toast } = useStore();
  const reviewGate = useReviewGate(pid);
  // новый кейс по умолчанию попадает в папку, открытую в дереве
  const [f, setF] = useState({
    kind, title: c?.title || "", priority: c?.priority || "medium", status: c?.status || "draft",
    pre: c?.pre || "", steps: c?.steps || "", expected: c?.expected || "", folder: String((c ? c.folder : folder) ?? ""),
    stepList: c ? c.stepSource || stepsOf(c) : [emptyStep()], tags: c?.tags || [], fields: c?.fields || {},
  });
  const [prm, setPrm] = useState(() => paramsForm(c));
  const fieldDefs = useFields("case");
  const tagSuggestions = useProjectTags("cases");
  const sharedSteps = useSharedSteps(pid);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const list = f.kind === "checklist";
  const aiReady = useAiReady();
  const ai = useAi();
  const [beforeAi, setBeforeAi] = useState<typeof f | null>(null);

  async function draft() {
    if (!f.title.trim()) return setErr(`Сначала напишите название: по нему модель составит ${list ? "пункты" : "шаги"}`);
    setErr("");
    const r = await ai.run(() => api<{ pre: string; steps: string; expected: string }>("POST", paths.aiCaseDraft(pid), { ...f, steps: list ? f.steps : f.stepList.map((s) => s.action).filter(Boolean).join("\n") }));
    if (!r) return;
    setBeforeAi(f);
    setF((cur) => ({ ...cur, ...r, stepList: list ? cur.stepList : stepsOf({ steps: r.steps }) }));
    toast(AI_NOTE);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setErr(list ? "Укажите название чек-листа" : "Укажите название тест-кейса");
    if (list && !f.steps.trim()) return setErr("Добавьте хотя бы один пункт");
    const missing = missingRequired(fieldDefs, f.fields);
    if (missing) return setErr(missing);
    // у тест-кейса шаги уходят структурой, у чек-листа — пункты текстом
    const { stepList, ...rest } = f;
    if (!list && prm.mode === "dataset" && !prm.dataset) return setErr("Выберите набор данных или отключите параметры");
    if (!list && prm.mode === "own" && (!prm.table.columns.length || !prm.table.rows.length)) return setErr("Параметры: добавьте хотя бы один параметр и один набор или выберите «Без параметров»");
    const body = { ...rest, ...(list ? {} : { stepList: stepList.filter((s) => isRef(s) || s.action.trim() || s.expected.trim()).map((s) => (isRef(s) ? { shared: s.shared } : s)) }), folder: f.folder ? Number(f.folder) : null,
      ...(list ? { params: null, dataset: null } : paramsBody(prm)) };
    if (c) {
      // baseVersion: если кейс успели поменять, сервер не даст затереть чужую правку
      let reset = false;
      if (await write(async () => { reset = Boolean((await api<{ statusReset?: string }>("PATCH", paths.testCase(pid, c.num), { ...body, baseVersion: c.version })).statusReset); },
        "Изменения сохранены")) {
        if (reset) toast("Кейс изменён после утверждения и снова стал черновиком — отправьте его на ревью");
        onClose();
        go("p", pid, "cases", c.num);
      }
      return;
    }
    let num = 0;
    if (await write(async () => { num = (await api<{ num: number }>("POST", paths.cases(pid), body)).num; })) {
      toast(`${list ? "Создан чек-лист" : "Создан"} ${pid}-${num}`);
      onClose();
      go("p", pid, "cases", num);
    }
  }

  return (
    <Drawer label={c ? "Редактирование" : list ? "Новый чек-лист" : "Новый тест-кейс"} idTag={c?.id}
      title={c ? "Редактирование" : list ? "Новый чек-лист" : "Новый тест-кейс"} onClose={onClose}
      footer={<>
        <button className="btn primary" type="submit" form="caseForm">{c ? "Сохранить" : "Создать"}</button>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
        <div className="spacer" />
        <SaveAsTemplate pid={pid} kind="case" data={{ priority: f.priority, status: f.status, pre: f.pre, expected: f.expected, tags: f.tags, fields: f.fields, ...(list ? { steps: f.steps } : { stepList: f.stepList.map((st) => (isRef(st) ? { shared: st.shared } : st)) }) }} />
      </>}>
      <form id="caseForm" onSubmit={submit} noValidate>
        <div className="field"><label htmlFor="c-title">Название *</label><input className="input" id="c-title" value={f.title} onChange={set("title")}
          placeholder={list ? "Например: Смоук перед релизом" : "Например: Вход с неверным паролем"} autoFocus /></div>
        {!c && <TemplatePicker pid={pid} kind="case" form={f} setForm={setF} defaults={{ priority: "medium", status: "draft" }} />}
        <div className="row2">
          <div className="field"><label htmlFor="c-kind">Вид</label>
            <select className="input" id="c-kind" value={f.kind} onChange={set("kind")}>
              <option value="case">Тест-кейс</option>
              <option value="checklist">Чек-лист</option>
            </select></div>
          <div className="field"><label htmlFor="c-folder">Папка</label>
            <select className="input" id="c-folder" value={f.folder} onChange={set("folder")}><FolderOptions pid={pid} /></select></div>
        </div>
        <div className="row2">
          <div className="field"><label htmlFor="c-prio">Приоритет</label>
            <select className="input" id="c-prio" value={f.priority} onChange={set("priority")}>{PRIORITIES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
          <div className="field"><label htmlFor="c-status">Статус</label>
            <select className="input" id="c-status" value={f.status} onChange={set("status")}>{statusOptions(f.status as TestCase["status"], reviewGate && c?.status !== "ready")}</select></div>
        </div>
        {aiReady && (
          <AiBar busy={ai.busy} onRun={draft} label="Заполнить по названию"
            hint={list ? "Модель предложит пункты проверки" : "Модель предложит предусловия, шаги и ожидаемый результат"}
            onUndo={beforeAi ? () => { setF(beforeAi); setBeforeAi(null); } : undefined} />
        )}
        {list ? (
          <div className="field"><label htmlFor="c-steps">Пункты</label>
            <textarea className="input" id="c-steps" rows={10} placeholder={"Каждый пункт с новой строки, например:\nГлавная страница открывается\nВход и выход работают"} value={f.steps} onChange={set("steps")} />
            <span className="muted" style={{ fontSize: 12 }}>В прогоне каждый пункт отмечается отдельно, итог чек-листа считается сам</span></div>
        ) : (
          <>
            <div className="field"><label htmlFor="c-pre">Предусловия</label><textarea className="input" id="c-pre" rows={2} value={f.pre} onChange={set("pre")} /></div>
            <div className="field"><span className="label-like">Шаги</span>
              <StepsEditor value={f.stepList} onChange={(stepList) => setF({ ...f, stepList })} shared={sharedSteps} />
              <span className="muted" style={{ fontSize: 12 }}>Enter в последнем шаге добавляет следующий. В прогоне каждый шаг отмечается отдельно</span></div>
            <div className="field"><label htmlFor="c-exp">Итоговый ожидаемый результат</label><textarea className="input" id="c-exp" rows={2} value={f.expected} onChange={set("expected")} /></div>
            <ParamsEditor pid={pid} value={prm} onChange={setPrm} />
          </>
        )}
        <div className="field"><label htmlFor="c-tags">Теги</label><TagInput id="c-tags" value={f.tags} onChange={(tags) => setF({ ...f, tags })} suggestions={tagSuggestions} /></div>
        <FieldsEditor entity="case" values={f.fields} onChange={(fields) => setF({ ...f, fields })} />
        <div className="err">{err}</div>
      </form>
    </Drawer>
  );
}

// История версий: что менялось и кем; любую прежнюю версию можно вернуть (создастся новая версия)
const FIELDS: [keyof CaseVersion, string][] = [["title", "Название"], ["priority", "Приоритет"], ["status", "Статус"], ["pre", "Предусловия"], ["steps", "Шаги"], ["expected", "Ожидаемый результат"]];
function Versions({ c }: { c: TestCase }) {
  const canEdit = useCan("cases.edit");
  const { write } = useStore();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<number | null>(null);
  const { value } = useLoad<{ versions: CaseVersion[] }>(open ? paths.versions(c.pid, c.num) : null);
  const list = value?.versions || [];
  const label = (k: keyof CaseVersion, v: string) =>
    k === "priority" ? find(PRIORITIES, v as TestCase["priority"]).label : k === "status" ? find(CASE_STATUSES, v as TestCase["status"]).label : v;
  return (
    <div className="view-block">
      <span className="label">Версии · текущая v{c.version}</span>
      {!open ? (
        <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)} disabled={c.version < 2}>
          {c.version < 2 ? "Кейс ещё не менялся" : "Показать историю изменений"}
        </button>
      ) : !value ? <span className="muted small">Загружаем…</span> : (
        <div className="history">
          {list.map((v, i) => {
            const prev = list[i + 1];
            const changed = prev ? FIELDS.filter(([k]) => v[k] !== prev[k]) : [];
            return (
              <div key={v.version} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="chip">v{v.version}</span>
                  <Who login={v.changedBy} /><span className="muted small">{fmt(v.changed)}</span>
                  <span className="muted small" style={{ flex: 1 }}>{prev ? `изменено: ${changed.map(([, l]) => l.toLowerCase()).join(", ") || "—"}` : "создан"}</span>
                  {prev && <button className="btn ghost sm" onClick={() => setShown(shown === v.version ? null : v.version)}>{shown === v.version ? "Скрыть" : "Что изменилось"}</button>}
                  {canEdit && v.version !== c.version && (
                    <button className="btn sm" onClick={() => write(() => api("POST", `${paths.versions(c.pid, c.num)}/${v.version}/restore`, {}), `Восстановлена v${v.version}`)}>Вернуть</button>
                  )}
                </div>
                {shown === v.version && prev && changed.map(([k, l]) => (
                  <div key={k} className="small" style={{ display: "grid", gap: 2 }}>
                    <span className="label">{l}</span>
                    <pre className="code diff-old">{label(k, String(prev[k])) || "—"}</pre>
                    <pre className="code diff-new">{label(k, String(v[k])) || "—"}</pre>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Массовое изменение выбранных кейсов: каждый изменённый кейс получает новую версию
function BulkEditModal({ pid, nums, tags, onClose }: { pid: string; nums: number[]; tags: string[]; onClose: (done: boolean) => void }) {
  const { write, toast } = useStore();
  const reviewGate = useReviewGate(pid);
  const [f, setF] = useState({ status: "", priority: "", add: [] as string[], remove: [] as string[] });
  const empty = !f.status && !f.priority && !f.add.length && !f.remove.length;
  async function submit(e: FormEvent) {
    e.preventDefault();
    let r = { changed: 0, skipped: 0 };
    const body = { nums, status: f.status || undefined, priority: f.priority || undefined, addTags: f.add, removeTags: f.remove };
    if (await write(async () => { r = await api("POST", `${paths.cases(pid)}/bulk`, body); })) {
      toast(`Изменено кейсов: ${r.changed}${r.skipped ? `, без изменений: ${r.skipped}` : ""}`);
      onClose(true);
    }
  }
  return (
    <Modal onClose={() => onClose(false)}>
      <form onSubmit={submit} id="bulkForm">
        <h2>Изменить выбранные кейсы ({nums.length})</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Пустые поля не меняются. Каждый изменённый кейс получит новую версию.</p>
        <div className="row2">
          <div className="field"><label htmlFor="bk-status">Статус</label>
            <select id="bk-status" className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="">Не менять</option>
              {CASE_STATUSES.filter((s) => s.key !== "review").map((s) => <option key={s.key} value={s.key} disabled={reviewGate && s.key === "ready"}>{s.label}{reviewGate && s.key === "ready" ? " — через ревью" : ""}</option>)}
            </select></div>
          <div className="field"><label htmlFor="bk-prio">Приоритет</label>
            <select id="bk-prio" className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="">Не менять</option>
              {PRIORITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select></div>
        </div>
        <div className="field"><label htmlFor="bk-add">Добавить теги</label><TagInput id="bk-add" value={f.add} onChange={(v) => setF({ ...f, add: v })} suggestions={tags} /></div>
        <div className="field"><label htmlFor="bk-rm">Убрать теги</label><TagInput id="bk-rm" value={f.remove} onChange={(v) => setF({ ...f, remove: v })} suggestions={tags} /></div>
        <div className="acts">
          <button type="button" className="btn" onClick={() => onClose(false)}>Отмена</button>
          <button type="submit" className="btn primary" disabled={empty}>Применить</button>
        </div>
      </form>
    </Modal>
  );
}
