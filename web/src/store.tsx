import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "./api";
import type { State, User } from "./types";

interface Store {
  me: User | null | undefined; // undefined — ещё не знаем, вошёл ли пользователь
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

  return (
    <Ctx.Provider value={{ me, bootError, data, liveError, setMe, reload, toast, write }}>
      {children}
      <div className="toast" hidden={!toastMsg} role="status">
        {toastMsg}
      </div>
    </Ctx.Provider>
  );
}
