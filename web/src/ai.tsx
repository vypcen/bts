// Подсказки локальной модели. Кнопки видны, только если модель подключена и скачана (GET /api/llm/status)
import { useEffect, useState, type ReactNode } from "react";
import { api, paths } from "./api";
import { useStore } from "./store";
import type { LlmStatus } from "./types";

// Статус спрашиваем один раз за сессию вкладки; ошибка — значит модели нет, кнопки просто не показываем
let cached: Promise<LlmStatus> | null = null;
const OFF: LlmStatus = { enabled: false, model: null, ready: false };

export function useAiReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    cached ??= api<LlmStatus>("GET", paths.llmStatus).catch(() => OFF);
    cached.then((s) => {
      if (!s.ready) cached = null; // модель могла докачаться — при следующем открытии формы спросим снова
      if (alive) setReady(s.ready);
    });
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

// Запрос к модели с состоянием «думает» и ошибкой тостом
export function useAi() {
  const { toast } = useStore();
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busy) return;
    setBusy(true);
    try {
      return await fn();
    } catch (e: any) {
      toast(e.message || "Модель не ответила");
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

export function AiButton({ busy, onClick, children, title }: { busy: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" className="btn sm ai" onClick={onClick} disabled={busy} title={title} aria-busy={busy}>
      {busy ? <><span className="ai-spin" aria-hidden="true" />Модель думает…</> : <>✨ {children}</>}
    </button>
  );
}

// Полоса над формой: кнопка модели, пояснение и «Вернуть как было» после подстановки
export function AiBar(props: { busy: boolean; onRun: () => void; label: string; hint: string; onUndo?: () => void }) {
  return (
    <div className="ai-bar">
      <AiButton busy={props.busy} onClick={props.onRun}>{props.label}</AiButton>
      <span className="muted small">{props.busy ? "Без видеокарты ответ может идти до минуты" : props.hint}</span>
      {props.onUndo && !props.busy && <button type="button" className="link small" onClick={props.onUndo}>Вернуть как было</button>}
    </div>
  );
}

export const AI_NOTE = "Черновик от модели — проверьте перед сохранением";
