import { useState, type FormEvent } from "react";
import { api, paths } from "../api";
import { isOpenBug } from "../labels";
import { go, href } from "../router";
import { lastResults } from "../selectors";
import { useData, useStore } from "../store";
import type { Project, ResultValue } from "../types";
import { Confirm, Empty, Modal, ResultBar, useNames } from "../ui";

export function Projects({ missing }: { missing?: string }) {
  const data = useData();
  const { liveError } = useStore();
  const nameOf = useNames();
  const [creating, setCreating] = useState(false);
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
          <p className="muted">Общие для всех участников команды</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ Новый проект</button>
      </div>
      {list.length ? (
        <div className="grid">{list.map(card)}</div>
      ) : (
        <Empty title="Проектов пока нет">
          Создайте первый проект. Он сразу станет виден всем участникам.
          <button className="btn primary" onClick={() => setCreating(true)}>+ Новый проект</button>
        </Empty>
      )}
      {creating && <ProjectModal onClose={() => setCreating(false)} />}
    </main>
  );
}

export function ProjectModal({ project, onClose }: { project?: Project; onClose: () => void }) {
  const data = useData();
  const { me, write, toast, reload } = useStore();
  const [name, setName] = useState(project?.name || "");
  const [key, setKey] = useState(project?.id || "");
  const [desc, setDesc] = useState(project?.desc || "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const canDelete = project && (!project.createdBy || project.createdBy === me?.login);

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
