import { useState, type KeyboardEvent } from "react";
import { api, paths } from "../api";
import { useCanComment, useStore } from "../store";
import type { Comment } from "../types";
import { Avatar, Confirm, fmt, useNames } from "../ui";
import { useMentionSuggest } from "./Notifications";

// Обсуждение бага или тест-кейса. Писать может любой участник проекта, менять — автор, удалять — автор или админ
export function Comments({ list, postUrl }: { list: Comment[]; postUrl: string }) {
  const { me, write } = useStore();
  const canComment = useCanComment();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [del, setDel] = useState<Comment | null>(null);
  const pid = list[0]?.pid || /\/api\/projects\/([^/]+)\//.exec(postUrl)?.[1];
  const mention = useMentionSuggest(pid ? decodeURIComponent(pid) : undefined, text, caret);
  const pickMention = (login: string) => {
    const next = `${text.slice(0, mention.start)}@${login} ${text.slice(caret)}`;
    setText(next);
    setCaret(mention.start + login.length + 2);
  };

  async function send() {
    if (!text.trim()) return;
    if (await write(() => api("POST", postUrl, { text }))) setText("");
  }

  return (
    <div className="view-block">
      <span className="label">Комментарии{list.length ? ` · ${list.length}` : ""}</span>
      {list.length > 0 && (
        <div className="comments">
          {list.map((c) => (
            <CommentItem key={c.id} c={c} mine={c.author === me?.login} canDelete={c.author === me?.login || me?.role === "admin"} onDelete={() => setDel(c)} />
          ))}
        </div>
      )}
      {/* наблюдатель (просмотровая лицензия) только читает обсуждение */}
      {canComment && <textarea className="input" rows={2} placeholder="Написать комментарий… @логин — упомянуть коллегу (Ctrl+Enter — отправить)" value={text}
        onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onKeyDown={(e) => submitOnCtrlEnter(e, send)} aria-label="Новый комментарий" />}
      {canComment && mention.list.length > 0 && (
        <div className="mention-list" role="listbox" aria-label="Упомянуть">
          {mention.list.map((m) => (
            <button key={m.login} type="button" role="option" aria-selected="false" onMouseDown={(e) => { e.preventDefault(); pickMention(m.login); }}>
              <b>{m.name}</b> <span className="muted mono small">@{m.login}</span>
            </button>
          ))}
        </div>
      )}
      {!canComment && !list.length && <span className="muted small">Комментариев нет</span>}
      {text.trim() && (
        <div className="flow">
          <button className="btn primary sm" onClick={send}>Отправить</button>
          <button className="btn sm" onClick={() => setText("")}>Отмена</button>
        </div>
      )}
      {del && pid && (
        <Confirm
          title="Удалить комментарий?"
          text="Комментарий будет удалён у всех участников."
          onClose={() => setDel(null)}
          onYes={async () => {
            const c = del;
            setDel(null);
            await write(() => api("DELETE", paths.comment(pid, c.id), {}), "Комментарий удалён");
          }}
        />
      )}
    </div>
  );
}

function CommentItem({ c, mine, canDelete, onDelete }: { c: Comment; mine: boolean; canDelete: boolean; onDelete: () => void }) {
  const { write } = useStore();
  const nameOf = useNames();
  const [edit, setEdit] = useState<string | null>(null);

  async function save() {
    if (edit === null || !edit.trim()) return;
    if (edit.trim() === c.text) return setEdit(null);
    if (await write(() => api("PATCH", paths.comment(c.pid, c.id), { text: edit }), "Комментарий изменён")) setEdit(null);
  }

  return (
    <div className="comment">
      {c.author ? <Avatar login={c.author} /> : <span className="ava" style={{ background: "var(--muted)" }} aria-hidden="true">?</span>}
      <div className="c-body">
        <div className="c-head small">
          <b>{c.author ? nameOf(c.author) : "Удалённый пользователь"}</b>
          <span className="muted" title={c.edited ? `Изменён ${fmt(c.edited)}` : undefined}>{fmt(c.created)}{c.edited ? " · изменён" : ""}</span>
          <div className="spacer" />
          {mine && edit === null && <button className="link small" onClick={() => setEdit(c.text)}>Изменить</button>}
          {canDelete && edit === null && <button className="link small" onClick={onDelete}>Удалить</button>}
        </div>
        {edit === null ? (
          <div className="c-text">{withMentions(c.text)}</div>
        ) : (
          <>
            <textarea className="input" rows={3} value={edit} autoFocus onChange={(e) => setEdit(e.target.value)} onKeyDown={(e) => submitOnCtrlEnter(e, save)} aria-label="Текст комментария" />
            <div className="flow">
              <button className="btn primary sm" onClick={save} disabled={!edit.trim()}>Сохранить</button>
              <button className="btn sm" onClick={() => setEdit(null)}>Отмена</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// @логин в тексте — выделен
function withMentions(text: string) {
  const parts = text.split(/(@[a-z0-9][a-z0-9._-]{1,31})/gi);
  return parts.map((p, i) => (i % 2 ? <span key={i} className="mention">{p}</span> : p));
}

function submitOnCtrlEnter(e: KeyboardEvent, fn: () => void) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    fn();
  }
}
