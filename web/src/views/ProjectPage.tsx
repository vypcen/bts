import { useState } from "react";
import { isOpenBug } from "../labels";
import { href } from "../router";
import { useCanEdit, useData, useStore } from "../store";
import type { Project } from "../types";
import { AnalyticsTab } from "./Analytics";
import { AutoRunPage, AutotestsTab } from "./Autotests";
import { IntegrationsTab } from "./Integrations";
import { PlansTab } from "./Plans";
import { BugsTab } from "./Bugs";
import { CasesTab } from "./Cases";
import { ProjectModal } from "./Projects";
import { RunPage } from "./RunPage";
import { RunsTab } from "./Runs";
import { TrashTab } from "./Trash";
import { RequirementsTab } from "./Requirements";

export function ProjectPage({ project, tab, id }: { project: Project; tab: string; id?: string }) {
  const data = useData();
  const { liveError } = useStore();
  const canEdit = useCanEdit();
  const [settings, setSettings] = useState(false);
  const p = project.id;
  const n = id && /^\d+$/.test(id) ? Number(id) : undefined;

  // Страница прогона — отдельный экран: на ней идёт сама работа тестировщика
  if (tab === "runs" && n !== undefined) return <RunPage project={project} num={n} />;
  if (tab === "auto" && n !== undefined) return <AutoRunPage project={project} num={n} />;

  const count = {
    cases: data.cases.filter((c) => c.pid === p).length,
    runs: data.runs.filter((r) => r.pid === p).length,
    bugs: data.bugs.filter((b) => b.pid === p && isOpenBug(b.status)).length,
    auto: data.autoruns.filter((r) => r.pid === p).length,
    plans: data.plans.filter((x) => x.pid === p).length,
  };
  const tabs: [string, string, number | null][] = [
    ["cases", "Тест-кейсы", count.cases],
    ["reqs", "Требования", null],
    ["plans", "Тест-планы", count.plans],
    ["runs", "Прогоны", count.runs],
    ["bugs", "Баги", count.bugs],
    ["auto", "Автотесты", count.auto],
    ["analytics", "Аналитика", null],
    ...(canEdit ? [["integrations", "Настройки", null] as [string, string, null], ["trash", "Корзина", null] as [string, string, null]] : []),
  ];

  return (
    <main className="wrap">
      {liveError && <div className="banner">{liveError}</div>}
      <div className="head">
        <div>
          <span className="label">{p}</span>
          <h1>{project.name}</h1>
          {project.desc && <p className="muted">{project.desc}</p>}
        </div>
        <div className="spacer" />
        {canEdit && <button className="btn" onClick={() => setSettings(true)}>Настройки проекта</button>}
      </div>
      <nav className="nav">
        {tabs.map(([k, label, c]) => (
          <a key={k} href={href("p", p, k)} aria-current={tab === k ? "page" : undefined} title={k === "bugs" ? "Открытые баги" : k === "auto" ? "Запуски автотестов" : undefined}>
            {label}
            {c !== null && <span className="n">{c}</span>}
          </a>
        ))}
      </nav>
      {tab === "plans" ? <PlansTab project={project} openNum={n} />
        : tab === "reqs" ? <RequirementsTab project={project} openNum={n} />
        : tab === "analytics" ? <AnalyticsTab project={project} />
        : tab === "integrations" ? <IntegrationsTab project={project} />
        : tab === "trash" ? <TrashTab project={project} />
        : tab === "runs" ? <RunsTab project={project} />
        : tab === "bugs" ? <BugsTab project={project} openNum={n} />
        : tab === "auto" ? <AutotestsTab project={project} view={id === "tests" ? "tests" : "runs"} />
        : <CasesTab project={project} openNum={n} />}
      {settings && <ProjectModal project={project} onClose={() => setSettings(false)} />}
    </main>
  );
}
