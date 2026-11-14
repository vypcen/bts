import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "./api";
import { useRoute } from "./router";
import type { State, User } from "./types";

interface Store {
  me: User | null | undefined; // undefined — ещё не знаем, вошёл ли пользователь
  // Может ли менять данные. Внутри проекта — по роли в этом проекте, вне проекта — по глобальной роли
  canEdit: boolean;
  canComment: boolean; // разработчик комментирует, наблюдатель — нет
  bootError: boolean;
  data: State | null;
  liveError: string;
  setMe: (u: User | null) => void;
  reload: () => Promise<void>;
  toast: (msg: string) => void;
  // Выполняет изменение, показывает ошибку тостом и перечитывает состояние. true — если удалось
  write: (fn: () => Promise<unknown>, okMsg?: string) => Promise<boolean>;
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
  const [data, setData] = useState<State | null>(null);
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

  const reload = useCallback(async () => {
    try {
      setData(await api<State>("GET", "/api/state"));
      setLiveError("");
    } catch (e: any) {
      if (e.status !== 401) setLiveError(e.message);
    }
  }, []);

  const write = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string) => {
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
    api<{ user: User | null }>("GET", "/api/auth/me")
      .then((r) => setMe(r.user))
      .catch(() => setBootError(true));
  }, []);

  // Пока пользователь в системе: загружаем состояние и слушаем изменения других участников
  const login = me?.login;
  useEffect(() => {
    if (!login) {
      setData(null);
      return;
    }
    reload();
    let timer: number | undefined;
    const es = new EventSource("/api/events");
    es.addEventListener("change", () => {
      clearTimeout(timer);
      timer = window.setTimeout(reload, 150);
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
  }, [login, reload]);

  // роль могут поменять, пока вкладка открыта: свежая приходит с каждым обновлением состояния
  const role = me && data?.users[me.login]?.role;
  const user = me && role && role !== me.role ? { ...me, role } : me;
  // роль в открытом проекте (#/p/KEY/...) может отличаться от глобальной
  const [section, key] = useRoute();
  const projectRole = section === "p" ? data?.projects.find((p) => p.id === key)?.myRole : undefined;
  const effective = projectRole || user?.role;
  const canEdit = effective === "tester" || effective === "admin";
  const canComment = canEdit || effective === "developer";

  return (
    <Ctx.Provider value={{ me: user, canEdit, canComment, bootError, data, liveError, setMe, reload, toast, write }}>
      {children}
      <div className="toast" hidden={!toastMsg} role="status">
        {toastMsg}
      </div>
    </Ctx.Provider>
  );
}
