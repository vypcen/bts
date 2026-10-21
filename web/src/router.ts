import { useSyncExternalStore } from "react";

// Маршрутизация по хэшу (#/p/LK/bugs/3): серверу не нужно знать о страницах интерфейса,
// а ссылки на конкретный баг или прогон можно пересылать коллегам.
const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const read = () => window.location.hash.replace(/^#\/?/, "");

export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribe, read);
  return hash.split("/").filter(Boolean).map(decodeURIComponent);
}

export const href = (...parts: (string | number)[]) => "#/" + parts.map((p) => encodeURIComponent(String(p))).join("/");

export function go(...parts: (string | number)[]) {
  window.location.hash = href(...parts);
}
