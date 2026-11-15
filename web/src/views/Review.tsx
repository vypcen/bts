// Ревью и согласование тест-кейсов: блок в карточке кейса, отправка на ревью, решение рецензента,
// настройка проекта «Готов только после ревью». Права проверяет сервер (server/review.js)
import { useState } from "react";
import { api } from "../api";
import { useCan, useData, useLoad, useStore } from "../store";
import { CASE_STATUSES } from "../labels";
import type { CaseStatus, TestCase } from "../types";
import { fmt, Modal, useNames } from "../ui";

interface Review {
  id: number; version: number; status: "pending" | "approved" | "changes" | "cancelled"; reviewer: string | null; requestedBy: string | null;
  requestComment: string; comment: string; decidedBy: string | null; created: number; decided: number | null;
}
const base = (pid: string) => `/api/projects/${encodeURIComponent(pid)}`;
const STATUS: Record<Review["status"], string> = { pending: "ждёт решения", approved: "утвердил", changes: "вернул на доработку", cancelled: "отменено" };

// Блок «Ревью» в карточке кейса
export function ReviewBlock({ c }: { c: TestCase }) {
  const { me, write } = useStore();
  const canEdit = useCan("cases.edit");
  const canReview = useCan("cases.review");
  const nameOf = useNames();
  const [asking, setAsking] = useState(false);
  const [deciding, setDeciding] = useState<"approve" | "changes" | null>(null);
  const [comment, setComment] = useState("");
  const hist = useLoad<{ reviews: Review[] }>(`${base(c.pid)}/cases/${c.num}/reviews`).value?.reviews || [];
  const pending = c.review || [];
  const mine = me && pending.some((r) => r.reviewer === me.login || (r.reviewer === null && r.by !== me.login));
  const decided = hist.filter((r) => r.status === "approved" || r.status === "changes").slice(0, 5);
  const decide = async () => {
    const d = deciding!;
    if (await write(() => api("POST", `${base(c.pid)}/cases/${c.num}/review/decision`, { decision: d, comment: comment.trim() }), d === "approve" ? "Кейс утверждён" : "Кейс возвращён на доработку")) {
      setDeciding(null); setComment("");
    }
  };
  if (c.status !== "review" && !decided.length && !(canEdit && c.status !== "deprecated")) return null;
  return (
    <div className="view-block">
      <span className="label">Ревью</span>
      {c.status === "review" ? (
        <div className="small">
          На ревью у {pending.map((r) => (r.reviewer ? nameOf(r.reviewer) : "любого с правом ревью")).join(", ")}
          {pending[0]?.by && <span className="muted"> · отправил {nameOf(pending[0].by)}</span>}
        </div>
      ) : null}
      {decided.length > 0 && (
        <ul className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>
          {decided.map((r) => (
            <li key={r.id}>
              <b>{nameOf(r.decidedBy || "")}</b> {STATUS[r.status]} <span className="muted">v{r.version} · {fmt(r.decided)}</span>
              {r.comment && <div style={{ whiteSpace: "pre-wrap" }}>{r.comment}</div>}
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {canEdit && c.status !== "review" && c.status !== "deprecated" && <button className="btn sm" onClick={() => setAsking(true)}>Отправить на ревью</button>}
        {canEdit && c.status === "review" && <button className="btn sm" onClick={() => setAsking(true)}>Переназначить</button>}
        {canReview && c.status === "review" && mine && (
          <>
            <button className="btn primary sm" onClick={() => setDeciding("approve")}>Утвердить</button>
            <button className="btn sm" onClick={() => setDeciding("changes")}>Вернуть на доработку</button>
          </>
        )}
      </div>
      {asking && <AskReview c={c} onClose={() => setAsking(false)} />}
      {deciding && (
        <Modal onClose={() => setDeciding(null)}>
          <h2>{deciding === "approve" ? "Утвердить кейс" : "Вернуть на доработку"}</h2>
          <div className="field">
            <label htmlFor="rv-comment">{deciding === "approve" ? "Комментарий (необязательно)" : "Что поправить"}</label>
            <textarea id="rv-comment" className="input" rows={4} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
          </div>
          <div className="acts">
            <button className="btn" onClick={() => setDeciding(null)}>Отмена</button>
            <button className="btn primary" disabled={deciding === "changes" && !comment.trim()} onClick={decide}>{deciding === "approve" ? "Утвердить" : "Вернуть"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AskReview({ c, onClose }: { c: TestCase; onClose: () => void }) {
  const { me, write } = useStore();
  const list = (useLoad<{ reviewers: { login: string; name: string }[] }>(`${base(c.pid)}/reviewers`).value?.reviewers || []).filter((r) => r.login !== me?.login);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [comment, setComment] = useState("");
  const toggle = (l: string) => { const s = new Set(picked); s.has(l) ? s.delete(l) : s.add(l); setPicked(s); };
  const send = async () => {
    if (await write(() => api("POST", `${base(c.pid)}/cases/${c.num}/review`, { reviewers: [...picked], comment: comment.trim() }), "Кейс отправлен на ревью")) onClose();
  };
  return (
    <Modal onClose={onClose}>
      <h2>Отправить на ревью</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Кейс станет «На ревью». Когда утвердят все выбранные рецензенты — «Готов». Если никого не выбрать, утвердить сможет любой участник с правом ревью.</p>
      <div className="field">
        <span className="label">Рецензенты</span>
        {!list.length ? <span className="muted small">В проекте нет других участников с правом «Проводить ревью».</span> : (
          <div className="done-list">
            {list.map((r) => (
              <label key={r.login}><input type="checkbox" checked={picked.has(r.login)} onChange={() => toggle(r.login)} /> <span>{r.name}</span></label>
            ))}
          </div>
        )}
      </div>
      <div className="field"><label htmlFor="rv-ask">Комментарий для рецензента</label><textarea id="rv-ask" className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
      <div className="acts">
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!list.length} onClick={send}>Отправить</button>
      </div>
    </Modal>
  );
}

// Кейсы, ожидающие решения текущего пользователя (для фильтра «Мне на ревью»)
export function useMyReviews(pid: string): Set<number> | null {
  const canReview = useCan("cases.review");
  const v = useLoad<{ items: { num: number }[] }>(canReview ? `${base(pid)}/reviews` : null).value;
  return v ? new Set(v.items.map((i) => i.num)) : null;
}

// Настройка проекта (вкладка «Настройки»)
export function ReviewSettings({ pid }: { pid: string }) {
  const data = useData();
  const { write } = useStore();
  const project = data.projects.find((p) => p.id === pid);
  const on = Boolean(project?.reviewRequired);
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Ревью тест-кейсов</h3>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input type="checkbox" checked={on} onChange={(e) => { const required = e.target.checked; write(() => api("PUT", `${base(pid)}/review-settings`, { required }), required ? "Кейсы становятся готовыми только после ревью" : "Ревью необязательно"); }} />
        <span>
          Кейс становится «Готов» только после ревью
          <div className="muted small">Участники без права «Проводить ревью» отправляют кейс на ревью вместо того, чтобы ставить «Готов». Если такой участник меняет готовый кейс, он снова становится черновиком.</div>
        </span>
      </label>
    </section>
  );
}

// Режим «готов только после ревью» действует для текущего пользователя: включён в проекте, а права ревью нет
export function useReviewGate(pid: string): boolean {
  const data = useData();
  const canReview = useCan("cases.review");
  return Boolean(data.projects.find((p) => p.id === pid)?.reviewRequired) && !canReview;
}

// Варианты статуса кейса для выпадающего списка: «На ревью» — только кнопкой, «Готов» в режиме согласования — через ревью
export function statusOptions(current: CaseStatus, gate: boolean) {
  return CASE_STATUSES.filter((x) => x.key !== "review" || current === "review").map((x) => (
    <option key={x.key} value={x.key} disabled={x.key === "review" || (gate && x.key === "ready" && current !== "ready")}>
      {x.label}{gate && x.key === "ready" && current !== "ready" ? " — через ревью" : ""}
    </option>
  ));
}
