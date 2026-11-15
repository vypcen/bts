import { useEffect, useState, type FormEvent } from "react";
import { ReleaseSelect } from "./Releases";
import { TagInput, useProjectTags } from "../casekit";
import { api, paths } from "../api";
import { CASE_STATUSES, DIST_STRATEGIES, PRIORITIES, RESULTS } from "../labels";
import { go, href } from "../router";
import { folderTree } from "../selectors";
import { useCan, useData, useLoad, useStore } from "../store";
import type { CaseKind, CaseStatus, Plan, PlanCase, PlanFilter, Priority, Project, ResultValue, State } from "../types";
import { Confirm, Empty, fmt, Modal, Pill, Prio, useNames, Who } from "../ui";
import { CasePicker } from "./Runs";

// Кто может отмечать результаты в проекте: тестировщики (с учётом роли в проекте) и админы
export function executorsOf(data: State, pid: string): string[] {
  const p = data.projects.find((x) => x.id === pid);
  if (!p) return [];
  const members = new Set(p.members);
  return Object.keys(data.users).filter((login) => {
    const global = data.users[login].role;
    if (global === "admin") return true;
    if (!members.has(login)) return false;
    // исполнитель — участник, чья роль в проекте позволяет отмечать результаты (встроенная или своя)
    const role = p.memberRoles?.[login] || global;
    const perms = data.roles?.[role]?.permissions;
    return perms ? perms.includes("runs.execute") : role === "tester";
  }).sort();
}

export type Assign = { users: string[]; strategy: string };

// Выбор исполнителей и стратегии распределения
export function AssignPicker({ pid, value, onChange }: { pid: string; value: Assign; onChange: (a: Assign) => void }) {
  const data = useData();
  const nameOf = useNames();
  const people = executorsOf(data, pid);
  const toggle = (u: string) => onChange({ ...value, users: value.users.includes(u) ? value.users.filter((x) => x !== u) : [...value.users, u] });
  return (
    <div className="field">
      <label>Распределить кейсы между исполнителями</label>
      <div className="chips" style={{ gap: 6 }}>
        {people.map((u) => (
          <label key={u} className="chip" style={{ cursor: "pointer", fontFamily: "inherit", fontSize: 13, padding: "3px 8px" }}>
            <input type="checkbox" checked={value.users.includes(u)} onChange={() => toggle(u)} style={{ margin: "0 6px 0 0" }} />{nameOf(u)}
          </label>
        ))}
        {!people.length && <span className="muted small">В проекте нет тестировщиков</span>}
      </div>
      {value.users.length > 0 && (
        <select className="input" aria-label="Стратегия распределения" value={value.strategy} onChange={(e) => onChange({ ...value, strategy: e.target.value })}>
          {DIST_STRATEGIES.map((s) => <option key={s.key} value={s.key}>{s.label} — {s.hint}</option>)}
        </select>
      )}
      <span className="muted" style={{ fontSize: 12 }}>Не выбрано никого — кейсы останутся без исполнителя, их можно распределить позже.</span>
    </div>
  );
}

const emptyFilter = (): PlanFilter => ({ folders: [], root: false, priorities: [], statuses: ["ready"], kinds: [], text: "", automated: "any", lastResults: [] });

function toggleIn<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

// Фильтр динамического плана с живым подсчётом подходящих кейсов
function FilterEditor({ pid, filter, onChange }: { pid: string; filter: PlanFilter; onChange: (f: PlanFilter) => void }) {
  const projectTags = useProjectTags("cases");
  const data = useData();
  const [count, setCount] = useState<number | null>(null);
  const tree = folderTree(data, pid);
  useEffect(() => {
    const t = window.setTimeout(() => {
      api<{ caseNums: number[] }>("POST", `${paths.plans(pid)}/preview`, { filter }).then((r) => setCount(r.caseNums.length), () => setCount(null));
    }, 250);
    return () => clearTimeout(t);
  }, [pid, filter]);
  const chips = <K extends string>(list: { key: K; label: string }[], value: K[], set: (v: K[]) => void) => (
    <div className="chips" style={{ gap: 6 }}>
      {list.map((x) => (
        <button type="button" key={x.key} className="stat" aria-pressed={value.includes(x.key)} onClick={() => set(toggleIn(value, x.key))}>{x.label}</button>
      ))}
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="field">
        <label>Папки (вместе с подпапками). Пусто — все</label>
        <div className="history" style={{ maxHeight: 160, overflow: "auto" }}>
          <label style={{ display: "flex", gap: 8 }}>
            <input type="checkbox" checked={filter.root} onChange={() => onChange({ ...filter, root: !filter.root })} /> <span className="muted">Без папки</span>
          </label>
          {tree.map(({ f, depth }) => (
            <label key={f.id} style={{ display: "flex", gap: 8, paddingLeft: depth * 16 }}>
              <input type="checkbox" checked={filter.folders.includes(f.id)} onChange={() => onChange({ ...filter, folders: toggleIn(filter.folders, f.id) })} /> {f.name}
            </label>
          ))}
        </div>
      </div>
      <div className="field"><label>Приоритет</label>{chips(PRIORITIES, filter.priorities, (v) => onChange({ ...filter, priorities: v as Priority[] }))}</div>
      <div className="field"><label>Статус кейса</label>{chips(CASE_STATUSES, filter.statuses, (v) => onChange({ ...filter, statuses: v as CaseStatus[] }))}</div>
      <div className="field"><label>Вид</label>{chips([{ key: "case", label: "Тест-кейсы" }, { key: "checklist", label: "Чек-листы" }], filter.kinds, (v) => onChange({ ...filter, kinds: v as CaseKind[] }))}</div>
      <div className="field"><label htmlFor="pf-tags">Теги (любой из)</label>
        <TagInput id="pf-tags" value={filter.tags || []} onChange={(tags) => onChange({ ...filter, tags })} suggestions={projectTags} /></div>
      <div className="field"><label>Последний результат</label>{chips(RESULTS, filter.lastResults, (v) => onChange({ ...filter, lastResults: v as ResultValue[] }))}
        <span className="muted" style={{ fontSize: 12 }}>Например, «Упал» + «Заблокирован» — повторная проверка проблемных кейсов</span></div>
      <div className="row2">
        <div className="field"><label htmlFor="pf-text">Название содержит</label>
          <input id="pf-text" className="input" value={filter.text} onChange={(e) => onChange({ ...filter, text: e.target.value })} /></div>
        <div className="field"><label htmlFor="pf-auto">Автоматизация</label>
          <select id="pf-auto" className="input" value={filter.automated} onChange={(e) => onChange({ ...filter, automated: e.target.value as PlanFilter["automated"] })}>
            <option value="any">Любые</option><option value="no">Только без автотестов</option><option value="yes">Только с автотестами</option>
          </select></div>
      </div>
      <span className="small"><b>{count ?? "…"}</b> <span className="muted">кейсов подходит сейчас. Новые кейсы, подходящие под фильтр, попадут в план сами.</span></span>
    </div>
  );
}

function PlanEditor({ pid, plan, onClose }: { pid: string; plan?: Plan; onClose: () => void }) {
  const data = useData();
  const { write, toast } = useStore();
  const cases = data.cases.filter((c) => c.pid === pid && c.status !== "deprecated").sort((a, b) => a.num - b.num);
  const [f, setF] = useState({ title: plan?.title || "", description: plan?.description || "", mode: plan?.mode || "static" });
  const [rel, setRel] = useState(String(plan?.release ?? ""));
  const [filter, setFilter] = useState<PlanFilter>(plan?.filter || emptyFilter());
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setErr("Укажите название плана");
    const body = { ...f, filter, release: rel ? Number(rel) : null };
    if (plan) {
      if (await write(() => api("PATCH", paths.plan(pid, plan.num), body), "План сохранён")) onClose();
      return;
    }
    let num = 0;
    if (await write(async () => { num = (await api<{ num: number }>("POST", paths.plans(pid), { ...body, caseNums: [...picked] })).num; })) {
      toast(`Создан ${pid}-P${num}`);
      onClose();
      go("p", pid, "plans", num);
    }
  }

  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>{plan ? "Параметры тест-плана" : "Новый тест-план"}</h2>
        <div className="field"><label htmlFor="pl-title">Название *</label>
          <input className="input" id="pl-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Регресс релиза 2.0" autoFocus /></div>
        <ReleaseSelect pid={pid} value={rel} onChange={setRel} id="pl-release" />
        <div className="field"><label htmlFor="pl-desc">Описание</label>
          <textarea className="input" id="pl-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={f.mode === "static"} onClick={() => setF({ ...f, mode: "static" })}>Выбрать кейсы вручную</button>
          <button type="button" role="tab" aria-selected={f.mode === "dynamic"} onClick={() => setF({ ...f, mode: "dynamic" })}>Динамический набор по фильтру</button>
        </div>
        {f.mode === "dynamic" ? <FilterEditor pid={pid} filter={filter} onChange={setFilter} />
          : plan ? <span className="muted small">Состав статического плана меняется на странице плана.</span>
          : <CasePicker cases={cases} picked={picked} setPicked={setPicked} />}
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">{plan ? "Сохранить" : "Создать план"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function PlansTab({ project, openNum }: { project: Project; openNum?: number }) {
  const canEdit = useCan("plans.edit");
  const p = project.id;
  const { value, error } = useLoad<{ plans: Plan[] }>(paths.plans(p));
  const [creating, setCreating] = useState(false);
  if (openNum !== undefined) return <PlanPage project={project} num={openNum} />;
  const plans = value?.plans || [];
  return (
    <>
      <div className="toolbar">
        <span className="muted small" style={{ flex: 1 }}>
          План — набор кейсов для проверки: выбранный вручную или собираемый по фильтру. Заблокированный план фиксирует состав и версии кейсов.
        </span>
        {canEdit && <button className="btn primary" onClick={() => setCreating(true)}>+ Новый план</button>}
      </div>
      {error && !value && <div className="banner">Не удалось загрузить планы: {error}</div>}
      {!value && !error ? <div className="skel">Загружаем планы…</div> : !plans.length ? (
        <Empty title="Тест-планов пока нет">Создайте план, чтобы зафиксировать объём проверки релиза и запускать по нему прогоны.</Empty>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th style={{ width: 80 }}>ID</th><th>Название</th><th style={{ width: 150 }}>Тип</th><th style={{ width: 90 }}>Кейсов</th><th style={{ width: 90 }}>Прогонов</th><th style={{ width: 170 }}>Состояние</th></tr></thead>
            <tbody>
              {plans.map((pl) => (
                <tr key={pl.num} className="click" onClick={() => go("p", p, "plans", pl.num)}>
                  <td className="id">{pl.id}</td>
                  <td className="title">{pl.title}{pl.description && <div className="muted small" style={{ fontWeight: 400 }}>{pl.description.slice(0, 120)}</div>}</td>
                  <td>{pl.mode === "dynamic" ? <span className="tag info">Динамический</span> : <span className="tag">Статический</span>}</td>
                  <td className="mono">{pl.caseCount}</td>
                  <td className="mono">{pl.runs}</td>
                  <td>{pl.locked ? <Pill tone="warn" label="Заблокирован" sm /> : <Pill tone="neutral" label="Можно менять" sm />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <PlanEditor pid={p} onClose={() => setCreating(false)} />}
    </>
  );
}

function PlanRunModal({ pid, plan, onClose }: { pid: string; plan: Plan; onClose: () => void }) {
  const { write, toast } = useStore();
  const [f, setF] = useState({ title: plan.title, build: "", env: "" });
  const [assign, setAssign] = useState<Assign>({ users: [], strategy: "balanced" });
  async function submit(e: FormEvent) {
    e.preventDefault();
    let num = 0;
    if (await write(async () => { num = (await api<{ num: number }>("POST", `${paths.plan(pid, plan.num)}/runs`, { ...f, assign })).num; })) {
      toast(`Создан ${pid}-R${num}`);
      go("p", pid, "runs", num);
    }
  }
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} style={{ display: "contents" }}>
        <h2>Прогон по плану {plan.id}</h2>
        {plan.locked && <p className="small muted" style={{ margin: 0 }}>План заблокирован: в прогон попадут зафиксированные версии кейсов, удалить прогон будет нельзя.</p>}
        <div className="field"><label htmlFor="pr-title">Название *</label><input id="pr-title" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div className="row2">
          <div className="field"><label htmlFor="pr-build">Сборка</label><input id="pr-build" className="input mono" value={f.build} onChange={(e) => setF({ ...f, build: e.target.value })} /></div>
          <div className="field"><label htmlFor="pr-env">Окружение</label><input id="pr-env" className="input" value={f.env} onChange={(e) => setF({ ...f, env: e.target.value })} /></div>
        </div>
        <AssignPicker pid={pid} value={assign} onChange={setAssign} />
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">Создать прогон ({plan.caseCount})</button>
        </div>
      </form>
    </Modal>
  );
}

function PlanPage({ project, num }: { project: Project; num: number }) {
  const data = useData();
  const { me, write } = useStore();
  const canEdit = useCan("plans.edit");
  const canRun = useCan("runs.manage");
  const p = project.id;
  const list = useLoad<{ plans: Plan[] }>(paths.plans(p));
  const cases = useLoad<{ cases: PlanCase[] }>(`${paths.plan(p, num)}/cases`);
  const [modal, setModal] = useState<"edit" | "run" | "compose" | "delete" | null>(null);
  const plan = list.value?.plans.find((x) => x.num === num);
  if (!list.value) return <div className="skel">Загружаем план…</div>;
  if (!plan) return <div className="banner">План {p}-P{num} не найден. <a href={href("p", p, "plans")}>К списку планов</a></div>;
  const rows = cases.value?.cases || [];
  const runs = data.runs.filter((r) => r.pid === p && r.planNum === num).sort((a, b) => b.num - a.num);
  const canUnlock = plan.lockedBy === me?.login || me?.role === "admin";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <a href={href("p", p, "plans")} className="small">← Все тест-планы</a>
      <div className="head">
        <div>
          <span className="label">{plan.id} · {plan.mode === "dynamic" ? "динамический" : "статический"}</span>
          <h1 style={{ fontSize: 22 }}>{plan.title}</h1>
          {plan.description && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{plan.description}</p>}
          <p className="muted small">Создал <Who login={plan.createdBy} /> {fmt(plan.created)}</p>
        </div>
        <div className="spacer" />
        <div className="acts" style={{ flexWrap: "wrap" }}>
          {plan.locked ? <Pill tone="warn" label={`Заблокирован ${fmt(plan.lockedAt)}`} /> : null}
          <a className="btn" href={`${paths.plan(p, num)}/export`} style={{ textDecoration: "none" }}>Экспорт CSV</a>
          <a className="btn" href={`${paths.plan(p, num)}/export?format=json`} style={{ textDecoration: "none" }}>JSON</a>
          <a className="btn" href={`${paths.plan(p, num)}/report?format=pdf`} download style={{ textDecoration: "none" }} title="Последний результат каждого кейса во всех прогонах плана">Отчёт PDF</a>
          <a className="btn" href={`${paths.plan(p, num)}/report?format=xlsx`} download style={{ textDecoration: "none" }}>Отчёт Excel</a>
          {canRun && <button className="btn primary" disabled={!plan.caseCount} onClick={() => setModal("run")}>Создать прогон</button>}
          {canEdit && !plan.locked && <button className="btn" onClick={() => setModal("edit")}>Параметры</button>}
          {canEdit && !plan.locked && plan.mode === "static" && <button className="btn" onClick={() => setModal("compose")}>Состав</button>}
          {canEdit && !plan.locked && (
            <button className="btn" disabled={!plan.caseCount} onClick={() => write(() => api("POST", `${paths.plan(p, num)}/lock`, {}), "План заблокирован: состав и версии зафиксированы")}>Заблокировать</button>
          )}
          {canEdit && plan.locked && canUnlock && (
            <button className="btn" onClick={() => write(() => api("POST", `${paths.plan(p, num)}/unlock`, {}), "План разблокирован")}>Разблокировать</button>
          )}
          {canEdit && !plan.locked && <button className="btn danger" onClick={() => setModal("delete")} aria-label="Удалить план">✕</button>}
        </div>
      </div>
      {plan.locked && (
        <div className="banner">
          План заблокирован{plan.lockedBy ? <> пользователем <Who login={plan.lockedBy} /></> : null}: состав и версии кейсов зафиксированы, правки кейсов на план не влияют.
          {!canUnlock && " Разблокировать может тот, кто заблокировал, или администратор."}
        </div>
      )}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th style={{ width: 80 }}>Кейс</th><th>Название</th><th style={{ width: 120 }}>Приоритет</th><th style={{ width: 160 }}>Версия</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.num} className="click" onClick={() => go("p", p, "cases", c.num)}>
                <td className="id">{p}-{c.num}</td>
                <td className="title">{c.kind === "checklist" && "☑ "}{c.title}</td>
                <td><Prio p={c.priority} /></td>
                <td className="small">
                  v{c.version}{c.version !== c.currentVersion && <span className="tag warn" style={{ marginLeft: 6 }} title="Кейс изменили после блокировки плана">сейчас v{c.currentVersion}</span>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="nores">{cases.value ? "В плане нет кейсов" : "Загружаем…"}</td></tr>}
          </tbody>
        </table>
      </div>
      {runs.length > 0 && (
        <div className="view-block">
          <span className="label">Прогоны по плану</span>
          <div className="history">
            {runs.map((r) => (
              <div key={r.id}>
                <a className="chip" href={href("p", p, "runs", r.num)}>R{r.num}</a>
                <span style={{ flex: 1 }}>{r.title}{r.build && <span className="muted"> · {r.build}</span>}</span>
                <span className="muted small">{fmt(r.created)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {modal === "edit" && <PlanEditor pid={p} plan={plan} onClose={() => setModal(null)} />}
      {modal === "run" && <PlanRunModal pid={p} plan={plan} onClose={() => setModal(null)} />}
      {modal === "compose" && <ComposeModal pid={p} plan={plan} current={rows.map((c) => c.num)} onClose={() => setModal(null)} />}
      {modal === "delete" && (
        <Confirm title={`Удалить план ${plan.id}?`} text="Прогоны, созданные по плану, останутся." onClose={() => setModal(null)}
          onYes={async () => { setModal(null); if (await write(() => api("DELETE", paths.plan(p, num), {}), "План удалён")) go("p", p, "plans"); }} />
      )}
    </div>
  );
}

function ComposeModal({ pid, plan, current, onClose }: { pid: string; plan: Plan; current: number[]; onClose: () => void }) {
  const data = useData();
  const { write } = useStore();
  const cases = data.cases.filter((c) => c.pid === pid && (c.status !== "deprecated" || current.includes(c.num))).sort((a, b) => a.num - b.num);
  const [picked, setPicked] = useState<Set<number>>(new Set(current));
  async function save() {
    const add = [...picked].filter((n) => !current.includes(n));
    const remove = current.filter((n) => !picked.has(n));
    if (await write(() => api("POST", `${paths.plan(pid, plan.num)}/cases`, { add, remove }), "Состав плана сохранён")) onClose();
  }
  return (
    <Modal onClose={onClose} wide>
      <h2>Состав плана {plan.id}</h2>
      <CasePicker cases={cases} picked={picked} setPicked={setPicked} />
      <div className="acts">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={save}>Сохранить ({picked.size})</button>
      </div>
    </Modal>
  );
}
