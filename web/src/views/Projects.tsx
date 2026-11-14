import { useState, type FormEvent } from "react";
import { api, paths } from "../api";
import { isOpenBug } from "../labels";
import { go, href } from "../router";
import { lastResults } from "../selectors";
import { useCanEdit, useData, useStore } from "../store";
import type { Project, ResultValue } from "../types";
import { Confirm, Empty, Modal, ResultBar, useNames } from "../ui";

export function Projects({ missing }: { missing?: string }) {
  const data = useData();
  const { liveError } = useStore();
  const canEdit = useCanEdit();
  const nameOf = useNames();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const list = [...data.projects].sort((a, b) => b.created - a.created);

  const card = (p: Project) => {
    const cases = data.cases.filter((c) => c.pid === p.id && c.status !== "deprecated");
    const last = lastResults(data, p.id);
    const counts: Record<ResultValue, number> = { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };
    for (const c of cases) counts[last.get(c.num)?.result || "untested"]++;
    const openBugs = data.bugs.filter((b) => b.pid === p.id && isOpenBug(b.status)).length;
    return (
      <a className="proj" key={p.id} href={href("p", p.id)} style={{ color: "inherit", textDecoration: "none" }}>
        <span className="key">{p.id}</span>
        <h3>{p.name}</h3>
        <p>{p.desc || "Без описания"}</p>
        <ResultBar counts={counts} title="Последние результаты тест-кейсов" />
        <div className="meta">
          <span>{cases.length} тест-кейсов</span>
          <span>Упало: {counts.failed}</span>
          <span style={openBugs ? { color: "var(--crit)" } : undefined}>Открытых багов: {openBugs}</span>
        </div>
        <div className="meta"><span>Создал: {nameOf(p.createdBy)}</span></div>
      </a>
    );
  };

  return (
    <main className="wrap">
      {liveError && <div className="banner">{liveError}</div>}
      {missing && <div className="banner">Проект {missing} не найден: возможно, его удалили.</div>}
      <div className="head">
        <div>
          <h1>Проекты</h1>
          <p className="muted">Проекты, к которым у вас есть доступ</p>
        </div>
        <div className="spacer" />
        {canEdit && <button className="btn" onClick={() => setImporting(true)}>Импорт</button>}
        {canEdit && <button className="btn primary" onClick={() => setCreating(true)}>+ Новый проект</button>}
      </div>
      {list.length ? (
        <div className="grid">{list.map(card)}</div>
      ) : (
        <Empty title="Проектов пока нет">
          {canEdit ? "Создайте первый проект. Коллег в него добавляет администратор в разделе «Пользователи»." : "Вас ещё не добавили ни в один проект. Попросите администратора выдать доступ."}
          {canEdit && <button className="btn primary" onClick={() => setCreating(true)}>+ Новый проект</button>}
        </Empty>
      )}
      {creating && <ProjectModal onClose={() => setCreating(false)} />}
      {importing && <ImportProjectModal onClose={() => setImporting(false)} />}
    </main>
  );
}

export function ProjectModal({ project, onClose }: { project?: Project; onClose: () => void }) {
  const data = useData();
  const { write, toast, reload } = useStore();
  const [name, setName] = useState(project?.name || "");
  const [key, setKey] = useState(project?.id || "");
  const [desc, setDesc] = useState(project?.desc || "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const canDelete = Boolean(project);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErr("Укажите название проекта");
    if (project) {
      if (await write(() => api("PATCH", paths.project(project.id), { name, desc }), "Проект сохранён")) onClose();
      return;
    }
    const k = key.trim().toUpperCase();
    if (!/^[A-Z]{2,6}$/.test(k)) return setErr("Ключ: от 2 до 6 латинских букв");
    if (data.projects.some((p) => p.id === k)) return setErr(`Ключ ${k} уже занят другим проектом`);
    if (busy) return;
    setBusy(true);
    try {
      await api("POST", "/api/projects", { key: k, name, desc });
    } catch (x: any) {
      setBusy(false);
      return setErr(x.message);
    }
    toast("Проект создан");
    await reload();
    onClose();
    go("p", k);
  }

  if (confirmDel && project) {
    const n = (list: { pid: string }[]) => list.filter((x) => x.pid === project.id).length;
    return (
      <Confirm
        title={`Удалить проект «${project.name}»?`}
        text={`Вместе с ним будут удалены ${n(data.cases)} тест-кейсов, ${n(data.runs)} прогонов и ${n(data.bugs)} багов со всеми вложениями. Это действие нельзя отменить.`}
        onClose={() => setConfirmDel(false)}
        onYes={async () => {
          if (await write(() => api("DELETE", paths.project(project.id), {}), "Проект удалён")) go();
        }}
      />
    );
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>{project ? "Настройки проекта" : "Новый проект"}</h2>
        <div className="field">
          <label htmlFor="p-name">Название *</label>
          <input className="input" id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Личный кабинет" autoFocus />
        </div>
        <div className="field">
          <label htmlFor="p-key">Ключ для ID</label>
          <input className="input mono" id="p-key" value={key} onChange={(e) => setKey(e.target.value)} maxLength={6} placeholder="LK" disabled={!!project} />
          <span className="muted" style={{ fontSize: 12 }}>
            {project ? "Ключ нельзя изменить после создания" : "2–6 латинских букв: LK → кейсы LK-1, прогоны LK-R1, баги LK-B1"}
          </span>
        </div>
        <div className="field">
          <label htmlFor="p-desc">Описание</label>
          <textarea className="input" id="p-desc" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <div className="err">{err}</div>
        <div className="acts">
          {canDelete && <button type="button" className="btn danger" style={{ marginRight: "auto" }} onClick={() => setConfirmDel(true)}>Удалить проект</button>}
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">{project ? "Сохранить" : "Создать"}</button>
        </div>
      </form>
    </Modal>
  );
}

const SOURCES = [
  { key: "testball", label: "TestBall (экспорт проекта)", accept: ".json", hint: "Файл *.testball.json из «Интеграции → Экспорт проекта» другой установки" },
  { key: "testrail", label: "TestRail (XML)", accept: ".xml", hint: "Test Cases → Export → XML. Разделы станут папками, отдельные шаги — шагами и ожидаемыми результатами" },
  { key: "testlink", label: "TestLink (XML)", accept: ".xml", hint: "Экспорт тестового набора в XML. Наборы станут папками" },
  { key: "qase", label: "Qase (JSON)", accept: ".json", hint: "Project → Export → JSON. Сьюты станут папками" },
] as const;

type ImportSummary = Record<string, number>;

// Новый проект из файла: перенос между установками TestBall или миграция из другой TMS. Для CSV — импорт во вкладке кейсов
function ImportProjectModal({ onClose }: { onClose: () => void }) {
  const { toast, reload } = useStore();
  const [source, setSource] = useState<(typeof SOURCES)[number]["key"]>("testball");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const def = SOURCES.find((x) => x.key === source)!;

  const body = (dryRun: boolean) => {
    if (source === "testball") {
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error("Файл не является JSON"); }
      return { source, data, key: key.trim().toUpperCase(), name: name.trim(), dryRun };
    }
    return { source, text, key: key.trim().toUpperCase(), name: name.trim(), dryRun };
  };

  async function pick(file: File) {
    setErr("");
    setPreview(null);
    setFileName(file.name);
    const t = await file.text();
    setText(t);
    try {
      setBusy(true);
      const r = await api<{ summary: ImportSummary; project: { key: string; name: string } }>("POST", paths.projectImport, (() => {
        const b = source === "testball" ? { source, data: JSON.parse(t), dryRun: true } : { source, text: t, dryRun: true };
        return b;
      })());
      setPreview(r.summary);
      if (!key) setKey(r.project.key);
      if (!name) setName(r.project.name);
    } catch (x: any) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const k = key.trim().toUpperCase();
    if (!/^[A-Z]{2,6}$/.test(k)) return setErr("Ключ нового проекта: от 2 до 6 латинских букв");
    if (!text) return setErr("Выберите файл");
    setBusy(true);
    try {
      await api("POST", paths.projectImport, body(false));
    } catch (x: any) {
      setBusy(false);
      return setErr(x.message);
    }
    toast(`Проект ${k} создан из файла`);
    await reload();
    onClose();
    go("p", k);
  }

  const LABELS: Record<string, string> = { folders: "папок", cases: "кейсов", plans: "планов", runs: "прогонов", bugs: "багов", comments: "комментариев", autotests: "автотестов", autoruns: "запусков автотестов", files: "файлов" };
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>Импорт проекта</h2>
        <div className="field"><label htmlFor="ip-src">Откуда</label>
          <select id="ip-src" className="input" value={source} onChange={(e) => { setSource(e.target.value as typeof source); setText(""); setFileName(""); setPreview(null); }}>
            {SOURCES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>{def.hint}</span></div>
        <div className="field"><label htmlFor="ip-file">Файл</label>
          <input id="ip-file" type="file" accept={def.accept} onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
          {fileName && <span className="muted small">{fileName}</span>}</div>
        {preview && (
          <div className="linkbox small">
            В файле: {Object.entries(preview).filter(([k, v]) => v && LABELS[k]).map(([k, v]) => `${v} ${LABELS[k]}`).join(", ") || "ничего"}
          </div>
        )}
        <div className="row2">
          <div className="field"><label htmlFor="ip-key">Ключ нового проекта *</label>
            <input id="ip-key" className="input mono" maxLength={6} value={key} onChange={(e) => setKey(e.target.value)} placeholder="NEW" /></div>
          <div className="field"><label htmlFor="ip-name">Название</label>
            <input id="ip-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        </div>
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit" disabled={busy || !text}>{busy ? "Подождите…" : "Создать проект"}</button>
        </div>
      </form>
    </Modal>
  );
}
