// Встроенная справка: документы из docs/ и README, отрисованные сервером (GET /api/help/:page).
// Маршрут #/help/<страница>/<якорь>; ссылки внутри документов уже переписаны сервером на такие маршруты
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { href } from "../router";

interface Page { key: string; title: string }
interface Doc { key: string; title: string; html: string }

export function Help({ page = "index", anchor }: { page?: string; anchor?: string }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState("");
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ pages: Page[] }>("GET", "/api/help").then((r) => setPages(r.pages), () => {});
  }, []);
  useEffect(() => {
    setError("");
    api<Doc>("GET", `/api/help/${encodeURIComponent(page)}`).then(setDoc, (e) => setError(e.message));
  }, [page]);
  // прокрутка к разделу после загрузки документа
  useEffect(() => {
    if (!doc || doc.key !== page) return;
    const el = anchor ? document.getElementById(`h-${anchor}`) : null;
    if (el) el.scrollIntoView({ block: "start" });
    else window.scrollTo(0, 0);
  }, [doc, page, anchor]);

  return (
    <main className="wrap help">
      <nav className="help-nav" aria-label="Разделы справки">
        {pages.map((p) => (
          <a key={p.key} href={href("help", p.key)} aria-current={p.key === page ? "page" : undefined}>{p.title}</a>
        ))}
      </nav>
      <article className="card help-doc">
        {error ? <div className="banner">{error}</div> : !doc || doc.key !== page ? <div className="skel">Загружаем…</div> : (
          <div ref={body} dangerouslySetInnerHTML={{ __html: doc.html }} />
        )}
      </article>
    </main>
  );
}
