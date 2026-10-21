export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function parse<T>(res: Response, url: string): Promise<T> {
  let json: any = {};
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) onUnauthorized();
    throw new ApiError(res.status, json.error || `Ошибка сервера (${res.status})`);
  }
  return json as T;
}

const NO_NET = "Нет связи с сервером. Проверьте подключение и повторите попытку.";

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, NO_NET);
  }
  return parse<T>(res, url);
}

// Файл уходит «сырым» телом; X-Upload нужен серверной защите от CSRF
export async function upload(url: string, file: File): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name || "file"),
        "X-Upload": "1",
      },
      body: file,
    });
  } catch {
    throw new ApiError(0, NO_NET);
  }
  return parse(res, url);
}

const e = encodeURIComponent;
export const paths = {
  project: (k: string) => `/api/projects/${e(k)}`,
  cases: (k: string) => `/api/projects/${e(k)}/cases`,
  testCase: (k: string, n: number) => `/api/projects/${e(k)}/cases/${n}`,
  runs: (k: string) => `/api/projects/${e(k)}/runs`,
  run: (k: string, n: number) => `/api/projects/${e(k)}/runs/${n}`,
  result: (k: string, run: number, caseNum: number) => `/api/projects/${e(k)}/runs/${run}/results/${caseNum}`,
  bugs: (k: string) => `/api/projects/${e(k)}/bugs`,
  bug: (k: string, n: number) => `/api/projects/${e(k)}/bugs/${n}`,
  file: (id: string) => `/api/attachments/${e(id)}`,
};
