import { useState } from "react";
import { api } from "./api";
import { go, href, useRoute } from "./router";
import { useStore } from "./store";
import { Avatar } from "./ui";
import { Login } from "./views/Login";
import { PasswordModal } from "./views/Password";
import { ProjectPage } from "./views/ProjectPage";
import { Projects } from "./views/Projects";
import { Users } from "./views/Users";
import { roleOf } from "./labels";

export function App() {
  const { me, bootError, data } = useStore();
  const route = useRoute();

  if (bootError) {
    return (
      <div className="wrap login">
        <div className="login-card">
          <span className="brand"><span className="mark">TB</span>TestBol</span>
          <h1 style={{ fontSize: 22 }}>Сервер недоступен</h1>
          <p className="muted" style={{ margin: 0 }}>Не удалось связаться с сервером TestBol. Проверьте, что он запущен, и обновите страницу.</p>
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
      <Topbar projectName={project?.name} projectKey={project?.id} users={section === "users"} />
      {!data ? (
        <main className="wrap"><div className="skel">Загружаем данные…</div></main>
      ) : section === "users" ? (
        <Users />
      ) : section === "p" && project ? (
        <ProjectPage project={project} tab={tab || "cases"} id={id} />
      ) : (
        <Projects missing={section === "p" ? key : undefined} />
      )}
    </>
  );
}

function Topbar({ projectName, projectKey, users }: { projectName?: string; projectKey?: string; users?: boolean }) {
  const { me, liveError, setMe, toast } = useStore();
  const [password, setPassword] = useState(false);
  const logout = () => {
    api("POST", "/api/auth/logout", {}).catch(() => {});
    setMe(null);
    go();
    toast("Вы вышли из системы");
  };
  return (
    <div className="topbar">
      <div className="wrap">
        <a className="brand" href={href()} style={{ color: "inherit", textDecoration: "none" }}><span className="mark">TB</span>TestBol</a>
        <div className="crumbs">
          <span>/</span>
          {projectName ? (
            <>
              <a className="btn ghost" href={href()} style={{ padding: "4px 6px", color: "inherit", textDecoration: "none" }}>Проекты</a>
              <span>/</span>
              <a href={href("p", projectKey!)} style={{ color: "inherit", textDecoration: "none", minWidth: 0 }}><b>{projectName}</b></a>
            </>
          ) : users ? (
            <>
              <a className="btn ghost" href={href()} style={{ padding: "4px 6px", color: "inherit", textDecoration: "none" }}>Проекты</a>
              <span>/</span>
              <b>Пользователи</b>
            </>
          ) : (
            <b>Проекты</b>
          )}
        </div>
        <div className="spacer" />
        <span className={`live${liveError ? " off" : ""}`} title="Изменения других участников появляются автоматически">
          <span className="dot" />
          {liveError ? "Нет связи" : "Онлайн"}
        </span>
        {me?.role === "admin" && <a className="btn" href={href("users")} style={{ textDecoration: "none" }}>Пользователи</a>}
        {me && (
          <span className="user who" title={roleOf(me.role).hint}>
            <Avatar login={me.login} />
            <span>{me.name}</span>
            <span className="mono" style={{ fontSize: 12 }}>@{me.login} · {roleOf(me.role).label}</span>
          </span>
        )}
        {me && <button className="btn ghost" onClick={() => setPassword(true)}>Пароль</button>}
        <button className="btn" onClick={logout}>Выйти</button>
      </div>
      {password && <PasswordModal onClose={() => setPassword(false)} />}
    </div>
  );
}
