import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, paths, upload } from "../api";
import { useStore } from "../store";
import type { Attachment } from "../types";
import { Confirm, fmt, fmtSize, useNames } from "../ui";

const isImage = (m: string) => /^image\/(png|jpeg|gif|webp)$/.test(m);

// Список вложений с загрузкой: кнопка, перетаскивание и вставка скриншота из буфера (Ctrl+V)
export function Attachments({ list, uploadUrl, paste, label = "Вложения" }: { list: Attachment[]; uploadUrl?: string; paste?: boolean; label?: string }) {
  const { write, toast, reload } = useStore();
  const nameOf = useNames();
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const [del, setDel] = useState<Attachment | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function send(files: File[]) {
    if (!uploadUrl || !files.length) return;
    setBusy((b) => b + files.length);
    let ok = 0;
    for (const f of files) {
      try {
        await upload(uploadUrl, f);
        ok++;
      } catch (e: any) {
        toast(`${f.name}: ${e.message}`);
      } finally {
        setBusy((b) => b - 1);
      }
    }
    if (ok) {
      toast(ok === 1 ? "Файл загружен" : `Загружено файлов: ${ok}`);
      await reload();
    }
  }

  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!paste || !uploadUrl) return;
    const h = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (!files.length) return;
      e.preventDefault();
      // у вставленного скриншота нет осмысленного имени
      sendRef.current(files.map((f) => (f.name === "image.png" ? new File([f], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`, { type: f.type }) : f)));
    };
    document.addEventListener("paste", h);
    return () => document.removeEventListener("paste", h);
  }, [paste, uploadUrl]);

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    send(Array.from(e.dataTransfer.files));
  };

  return (
    <div className="view-block">
      <span className="label">{label}{list.length ? ` · ${list.length}` : ""}</span>
      {list.length > 0 && (
        <div className="files">
          {list.map((a) => (
            <div className="file" key={a.id} title={`${a.name}\n${fmtSize(a.size)} · ${nameOf(a.uploadedBy)} · ${fmt(a.created)}`}>
              <a className="thumb" href={paths.file(a.id)} target="_blank" rel="noopener">
                {isImage(a.mime) ? <img src={paths.file(a.id)} alt={a.name} loading="lazy" /> : (a.name.split(".").pop() || "файл").slice(0, 6).toUpperCase()}
              </a>
              <div className="meta">
                <span>{a.name}</span>
                {uploadUrl && <button onClick={() => setDel(a)} aria-label={`Удалить ${a.name}`}>✕</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {uploadUrl && (
        <div className={`drop${over ? " over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          {busy ? `Загружаем… (${busy})` : (
            <>
              Перетащите файлы сюда, {paste ? "вставьте скриншот (Ctrl+V) " : ""}или{" "}
              <button type="button" className="link" onClick={() => input.current?.click()}>выберите на диске</button>
            </>
          )}
          <input ref={input} type="file" multiple hidden onChange={(e) => { send(Array.from(e.target.files || [])); e.target.value = ""; }} />
        </div>
      )}
      {!uploadUrl && !list.length && <span className="muted small">Нет вложений</span>}
      {del && (
        <Confirm
          title={`Удалить «${del.name}»?`}
          text="Файл будет удалён у всех участников."
          onClose={() => setDel(null)}
          onYes={async () => {
            const a = del;
            setDel(null);
            await write(() => api("DELETE", paths.file(a.id), {}), "Файл удалён");
          }}
        />
      )}
    </div>
  );
}
