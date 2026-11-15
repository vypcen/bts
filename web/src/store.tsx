import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { api, setPendingHandler, setUnauthorizedHandler } from "./api";
import { useRoute } from "./router";
import type { MetaState, ProjectState, State, User } from "./types";

interface Store {
  me: User | null | undefined; // undefined — ещё не знаем, вошёл ли пользователь
  // Может ли менять данные. Внутри проекта — по роли в этом проекте, вне проекта — по глобальной роли
  canEdit: boolean;
  canComment: boolean; // разработчик комментирует, наблюдатель — нет
  bootError: boolean;
  data: State | null;
  projectLoading: boolean; // данные открытого проекта ещё не пришли
  liveError: string;
  setMe: Dispatch<SetStateAction<User | null | undefined>>;
  reload: () => Promise<void>;
  toast: (msg: string) => void;
  // Выполняет изменение, показывает ошибку тостом и перечитывает состояние. true — если удалось
  write: (fn: () => Promise<unknown>, okMsg?: string, opts?: { queue?: boolean }) => Promise<boolean>;
}

const Ctx = createContext<Store>(null!);
export const useStore = () => useContext(Ctx);
export const useData = () => useContext(Ctx).data!;
export const useCanEdit = () => useContext(Ctx).canEdit;
export const useCanComment = () => useContext(Ctx).canComment;

// Загружает данные, которых нет в общем состоянии, и перечитывает их при каждом обновлении состояния
// url null — ничего не загружать
export function useLoad<T>(url: string | null) {
  const data = useData();
  const [s, setS] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    if (!url) return setS({});
    let alive = true;
    api<T>("GET", url).then(
      (value) => alive && setS({ value }),
      (e) => alive && setS((prev) => ({ ...prev, error: e.message }))
    );
    return () => {
      alive = false;
    };
  }, [url, data]);
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [bootError, setBootError] = useState(false);
  const [meta, setMeta] = useState<MetaState | null>(null);
  const [proj, setProj] = useState<ProjectState | null>(null);
  const [liveError, setLiveError] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const toastTimer = useRef<number>();
  const busy = useRef(false);
  const lost = useRef(false);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(""), 2600);
  }, []);

  // открытый проект (#/p/KEY/...): его данные грузятся отдельно и перечитываются только по его сигналам
  const [section, key] = useRoute();
  const pid = section === "p" && key ? key : null;
  const pidRef = useRef(pid);
  pidRef.current = pid;

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await api<MetaState>("GET", "/api/state"));
      setLiveError("");
    } catch (e: any) {
      if (e.status !== 401) setLiveError(e.message);
    }
  }, []);

  const loadProject = useCallback(async (k: string | null = pidRef.current) => {
    if (!k) return setProj(null);
    try {
      const next = await api<ProjectState>("GET", `/api/projects/${encodeURIComponent(k)}/state`);
      if (pidRef.current === k) setProj(next);
      setLiveError("");
    } catch (e: any) {
      // проект удалили или забрали доступ — экраны покажут «не найден»
      if (e.status === 404) setProj((cur) => (cur?.pid === k ? null : cur));
      else if (e.status !== 401) setLiveError(e.message);
    }
  }, []);

  const reload = useCallback(async () => {
    await Promise.all([loadMeta(), loadProject()]);
  }, [loadMeta, loadProject]);

  // Пока идёт сохранение, повторный вызов игнорируется: защита от двойной отправки формы.
  // Отметки в прогоне (queue: true) не теряются, а встают в очередь: быстрые клики по шагам и пунктам сохранятся по порядку
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const write = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string, opts?: { queue?: boolean }) => {
      if (opts?.queue) {
        const run = queue.current.then(async () => {
          try {
            await fn();
            if (okMsg) toast(okMsg);
            return true;
          } catch (e: any) {
            toast(e.message || "Не удалось сохранить");
            return false;
          }
        });
        queue.current = run;
        const ok = await run;
        // перечитываем, когда очередь опустела: одно обновление на пачку кликов
        if (queue.current === run) await reload();
        return ok;
      }
      if (busy.current) return false;
      busy.current = true;
      try {
        await fn();
        if (okMsg) toast(okMsg);
        await reload();
        return true;
      } catch (e: any) {
        toast(e.message || "Не удалось сохранить");
        return false;
      } finally {
        busy.current = false;
      }
    },
    [reload, toast]
  );

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    setPendingHandler((code) => setMe((m) => (m ? { ...m, pending: code === "password_change_required" ? "password" : "2fa" } : m)));
    api<{ user: User | null }>("GET", "/api/auth/me")
      .then((r) => setMe(r.user))
      .catch(() => setBootError(true));
  }, []);

  // Пока пользователь в системе: загружаем состояние и слушаем изменения других участников
  // пока не сменён пароль или не включена 2FA, данные не загружаются: сервер их всё равно не отдаст
  const login = me?.pending ? undefined : me?.login;
  useEffect(() => {
    if (!login) {
      setMeta(null);
      setProj(null);
      return;
    }
    loadMeta();
    // сигналы копятся 150 мс: пачка изменений — одно перечитывание
    let timer: number | undefined;
    let needMeta = false;
    let needProject = false;
    const flush = () => {
      if (needMeta) loadMeta();
      if (needProject) loadProject();
      needMeta = needProject = false;
    };
    // то, что видно вне проекта: список проектов, сводка, пользователи, планы
    const META = new Set(["projects", "users", "plans", "cases", "runs", "bugs"]);
    const es = new EventSource("/api/events");
    es.addEventListener("change", (ev) => {
      let msg: { type?: string; pid?: string | null } = {};
      try {
        msg = JSON.parse((ev as MessageEvent).data);
      } catch {}
      if (!msg.pid || msg.pid === pidRef.current) needProject = true;
      if (!msg.pid ? true : META.has(msg.type || "") && (!pidRef.current || ["projects", "users", "plans"].includes(msg.type || ""))) needMeta = true;
      clearTimeout(timer);
      timer = window.setTimeout(flush, 150);
    });
    es.onopen = () => {
      if (lost.current) {
        lost.current = false;
        reload();
      }
    };
    es.onerror = () => {
      lost.current = true;
      setLiveError("Связь с сервером прервана. Переподключаемся…");
    };
    return () => {
      es.close();
      clearTimeout(timer);
    };
  }, [login, reload, loadMeta, loadProject]);

  // перешли в другой проект — грузим его данные, старые не показываем
  useEffect(() => {
    if (!login) return;
    setProj((cur) => (cur?.pid === pid ? cur : null));
    loadProject(pid);
  }, [login, pid, loadProject]);

  const data: State | null = !meta
    ? null
    : {
        projects: meta.projects,
        users: meta.users,
        plans: proj ? proj.plans : meta.plans,
        cases: proj?.cases || [],
        folders: proj?.folders || [],
        runs: proj?.runs || [],
        results: proj?.results || [],
        bugs: proj?.bugs || [],
        attachments: proj?.attachments || [],
        autoruns: proj?.autoruns || [],
        comments: proj?.comments || [],
        customFields: proj?.customFields || [],
      };
  // данные проекта ещё грузятся: экраны проекта ждут, чтобы не мигнуть «пусто»
  const projectLoading = Boolean(pid && meta?.projects.some((p) => p.id === pid) && proj?.pid !== pid);

  // роль могут поменять, пока вкладка открыта: свежая приходит с каждым обновлением состояния
  const role = me && data?.users[me.login]?.role;
  const user = me && role && role !== me.role ? { ...me, role } : me;
  // роль в открытом проекте (#/p/KEY/...) может отличаться от глобальной
  const projectRole = section === "p" ? data?.projects.find((p) => p.id === key)?.myRole : undefined;
  const effective = projectRole || user?.role;
  const canEdit = effective === "tester" || effective === "admin";
  const canComment = canEdit || effective === "developer";

  return (
    <Ctx.Provider value={{ me: user, canEdit, canComment, bootError, data, projectLoading, liveError, setMe, reload, toast, write }}>
      {children}
      <div className="toast" hidden={!toastMsg} role="status">
        {toastMsg}
      </div>
    </Ctx.Provider>
  );
}
