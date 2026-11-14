import { useCallback, useState } from "react";
import { api } from "./api";
import { go, href, useRoute } from "./router";
import { useStore } from "./store";
import { Avatar } from "./ui";
import { Login } from "./views/Login";
import { PasswordModal } from "./views/Password";
import { ProjectPage } from "./views/ProjectPage";
import { Projects } from "./views/Projects";
import { Settings } from "./views/Settings";
import { Users } from "./views/Users";
import { SearchPalette, useSearchHotkey } from "./views/Search";
import { roleOf } from "./labels";

export function App() {
  const { me, bootError, data, projectLoading } = useStore();
  const route = useRoute();

  if (bootError) {
    return (
      <div className="wrap login">
        <div className="login-card">
          <span className="brand"><span className="mark">TB</span>TestBall</span>
          <h1 style={{ fontSize: 22 }}>Сервер недоступен</h1>
          <p className="muted" style={{ margin: 0 }}>Не удалось связаться с сервером TestBall. Проверьте, что он запущен, и обновите страницу.</p>
        </div>
      </div>
    );
  }
  if (me === undefined) return <div className="wrap login"><div className="skel">Подключаемся к базе…</div></div>;
  if (!me) return <Login />;

  const [section, key, tab, id] = route;
  const project = section === "p" && data ? data.projects.find((p) => p.id === key) : undefined;
  return (
    <>
      <Topbar projectName={project?.name} projectKey={project?.id} users={section === "users"} settings={section === "settings"} />
      {!data ? (
        <main className="wrap"><div className="skel">Загружаем данные…</div></main>
      ) : section === "users" ? (
        <Users />
      ) : section === "settings" ? (
        <Settings />
      ) : section === "p" && project && projectLoading ? (
        <main className="wrap"><div className="skel">Загружаем проект…</div></main>
      ) : section === "p" && project ? (
        <ProjectPage project={project} tab={tab || "cases"} id={id} />
      ) : (
        <Projects missing={section === "p" ? key : undefined} />
      )}
    </>
  );
}

function Topbar({ projectName, projectKey, users, settings }: { projectName?: string; projectKey?: string; users?: boolean; settings?: boolean }) {
  const { me, liveError, setMe, toast } = useStore();
  const [password, setPassword] = useState(false);
  const [searching, setSearching] = useState(false);
  useSearchHotkey(useCallback(() => setSearching(true), []));
  const logout = () => {
    api("POST", "/api/auth/logout", {}).catch(() => {});
    setMe(null);
    go();
    toast("Вы вышли из системы");
  };
  return (
    <div className="topbar">
      <div className="wrap">
        <a className="brand" href={href()} style={{ color: "inherit", textDecoration: "none" }}><span className="mark">TB</span>TestBall</a>
        <div className="crumbs">
          <span>/</span>
          {projectName ? (
            <>
              <a className="btn ghost" href={href()} style={{ padding: "4px 6px", color: "inherit", textDecoration: "none" }}>Проекты</a>
              <span>/</span>
              <a href={href("p", projectKey!)} style={{ color: "inherit", textDecoration: "none", minWidth: 0 }}><b>{projectName}</b></a>
            </>
          ) : users || settings ? (
            <>
              <a className="btn ghost" href={href()} style={{ padding: "4px 6px", color: "inherit", textDecoration: "none" }}>Проекты</a>
              <span>/</span>
              <b>{users ? "Пользователи" : "Языковая модель"}</b>
            </>
          ) : (
            <b>Проекты</b>
          )}
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setSearching(true)} title="Поиск по всем проектам (Ctrl+K)">Поиск <span className="muted small mono">Ctrl+K</span></button>
        <span className={`live${liveError ? " off" : ""}`} title="Изменения других участников появляются автоматически">
          <span className="dot" />
          {liveError ? "Нет связи" : "Онлайн"}
        </span>
        {me?.role === "admin" && <a className="btn" href={href("users")} style={{ textDecoration: "none" }}>Пользователи</a>}
        {me?.role === "admin" && <a className="btn" href={href("settings")} style={{ textDecoration: "none" }} title="Подключение языковой модели">Настройки</a>}
        {me && (
          <span className="user who" title={roleOf(me.role).hint}>
            <Avatar login={me.login} />
            <span>{me.name}</span>
            <span className="mono" style={{ fontSize: 12 }}>@{me.login} · {roleOf(me.role).label}</span>
          </span>
        )}
        {/* пароль доменной / SSO-учётной записи меняется в каталоге, а не здесь */}
        {me && (!me.provider || me.provider === "local") && <button className="btn ghost" onClick={() => setPassword(true)}>Пароль</button>}
        <button className="btn" onClick={logout}>Выйти</button>
      </div>
      {password && <PasswordModal onClose={() => setPassword(false)} />}
      {searching && <SearchPalette onClose={() => setSearching(false)} />}
    </div>
  );
}
