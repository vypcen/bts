import { useState, type FormEvent } from "react";
import { api, paths } from "../api";
import { href, go } from "../router";
import { countResults, runResults } from "../selectors";
import { useCanEdit, useData, useStore } from "../store";
import type { Project, Run, TestCase } from "../types";
import { Empty, fmt, Modal, Pill, Prio, ResultBar, Who } from "../ui";

export function RunsTab({ project }: { project: Project }) {
  const data = useData();
  const canEdit = useCanEdit();
  const p = project.id;
  const [creating, setCreating] = useState(false);
  const runs = data.runs.filter((r) => r.pid === p).sort((a, b) => b.num - a.num);

  return (
    <>
      <div className="head">
        <p className="muted small" style={{ margin: 0 }}>Прогон фиксирует, что и на какой сборке проверяли. Результаты прошлых прогонов не перезаписываются.</p>
        <div className="spacer" />
        {canEdit && <button className="btn primary" onClick={() => setCreating(true)}>+ Новый прогон</button>}
      </div>
      {runs.length === 0 ? (
        <Empty title="Прогонов пока нет">
          {canEdit ? "Создайте прогон: выберите кейсы и укажите сборку, на которой проверяете." : "Здесь появятся прогоны, которые создадут тестировщики."}
          {canEdit && <button className="btn primary" onClick={() => setCreating(true)}>+ Новый прогон</button>}
        </Empty>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>ID</th><th>Название</th><th style={{ width: 130 }}>Сборка</th><th style={{ width: 200 }}>Прогресс</th>
                <th style={{ width: 110 }}>Состояние</th><th style={{ width: 170 }}>Создал</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const c = countResults(runResults(data, p, r.num));
                const total = Object.values(c).reduce((a, b) => a + b, 0);
                return (
                  <tr key={r.id} className="click" onClick={() => go("p", p, "runs", r.num)}>
                    <td className="id"><a href={href("p", p, "runs", r.num)} style={{ color: "inherit" }}>{r.id}</a></td>
                    <td className="title">{r.title}{r.env && <div className="muted small" style={{ fontWeight: 400 }}>{r.env}</div>}</td>
                    <td className="mono small">{r.build || <span className="muted">—</span>}</td>
                    <td>
                      <ResultBar counts={c} />
                      <div className="muted small mono" style={{ marginTop: 4 }}>
                        {total - c.untested}/{total}{c.failed ? <span style={{ color: "var(--crit)" }}> · упало {c.failed}</span> : null}
                      </div>
                    </td>
                    <td>{r.state === "open" ? <Pill tone="info" label="Идёт" /> : <Pill tone="neutral" label="Закрыт" />}</td>
                    <td className="small"><Who login={r.createdBy} /><div className="muted">{fmt(r.created)}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <RunModal pid={p} onClose={() => setCreating(false)} />}
    </>
  );
}

// Создание прогона или правка его названия/сборки/окружения
export function RunModal({ pid, run, onClose }: { pid: string; run?: Run; onClose: () => void }) {
  const data = useData();
  const { write, toast } = useStore();
  const cases = data.cases.filter((c) => c.pid === pid && c.status !== "deprecated").sort((a, b) => a.num - b.num);
  const lastRun = data.runs.filter((r) => r.pid === pid).sort((a, b) => b.num - a.num)[0];
  const [f, setF] = useState({ title: run?.title || "", build: run?.build || "", env: run?.env ?? lastRun?.env ?? "" });
  // по умолчанию — все кейсы, готовые к прогону
  const [picked, setPicked] = useState<Set<number>>(() => new Set(cases.filter((c) => c.status === "ready").map((c) => c.num)));
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setErr("Укажите название прогона");
    if (run) {
      if (await write(() => api("PATCH", paths.run(pid, run.num), f), "Прогон сохранён")) onClose();
      return;
    }
    if (!picked.size) return setErr("Выберите хотя бы один тест-кейс");
    let num = 0;
    if (await write(async () => { num = (await api<{ num: number }>("POST", paths.runs(pid), { ...f, caseNums: [...picked] })).num; })) {
      toast(`Создан ${pid}-R${num}`);
      onClose();
      go("p", pid, "runs", num);
    }
  }

  return (
    <Modal onClose={onClose} wide={!run}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <h2>{run ? "Параметры прогона" : "Новый прогон"}</h2>
        <div className="field"><label htmlFor="r-title">Название *</label>
          <input className="input" id="r-title" value={f.title} onChange={set("title")} placeholder="Например: Регресс перед релизом 1.4" autoFocus /></div>
        <div className="row2">
          <div className="field"><label htmlFor="r-build">Сборка / версия</label><input className="input mono" id="r-build" value={f.build} onChange={set("build")} placeholder="1.4.0-rc2" /></div>
          <div className="field"><label htmlFor="r-env">Окружение</label><input className="input" id="r-env" value={f.env} onChange={set("env")} placeholder="staging, Chrome 130" /></div>
        </div>
        {!run && <CasePicker cases={cases} picked={picked} setPicked={setPicked} />}
        <div className="err">{err}</div>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="submit">{run ? "Сохранить" : `Создать прогон (${picked.size})`}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CasePicker({ cases, picked, setPicked }: { cases: TestCase[]; picked: Set<number>; setPicked: (s: Set<number>) => void }) {
  const toggle = (n: number) => {
    const s = new Set(picked);
    s.has(n) ? s.delete(n) : s.add(n);
    setPicked(s);
  };
  if (!cases.length) return <p className="muted" style={{ margin: 0 }}>Нет кейсов для добавления.</p>;
  return (
    <div className="field">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ flex: 1 }}>Тест-кейсы · выбрано {picked.size} из {cases.length}</label>
        <button type="button" className="btn sm" onClick={() => setPicked(new Set(cases.map((c) => c.num)))}>Все</button>
        <button type="button" className="btn sm" onClick={() => setPicked(new Set(cases.filter((c) => c.status === "ready").map((c) => c.num)))}>Только готовые</button>
        <button type="button" className="btn sm" onClick={() => setPicked(new Set())}>Снять</button>
      </div>
      <div className="checklist">
        {cases.map((c) => (
          <label key={c.num}>
            <input type="checkbox" checked={picked.has(c.num)} onChange={() => toggle(c.num)} />
            <span className="mono muted small" style={{ width: 64 }}>{c.id}</span>
            <span style={{ flex: 1, minWidth: 0 }}>{c.title}{c.status === "draft" && <span className="muted small"> · черновик</span>}</span>
            <Prio p={c.priority} />
          </label>
        ))}
      </div>
    </div>
  );
}
