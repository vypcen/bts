// Корзина проекта: удалённые тест-кейсы, прогоны и баги. Восстанавливают тестировщики, удаляет навсегда админ
import { useState } from "react";
import { api } from "../api";
import { useLoad, useStore } from "../store";
import type { Project } from "../types";
import { Confirm, Empty, fmt, Who } from "../ui";

interface TrashItem { id: number; kind: "case" | "run" | "bug"; num: number; title: string; ref: string; deletedBy: string | null; deleted: number; purgeAt: number }
const KIND = { case: "Тест-кейс", run: "Прогон", bug: "Баг" };

export function TrashTab({ project }: { project: Project }) {
  const url = `/api/projects/${encodeURIComponent(project.id)}/trash`;
  const { value, error } = useLoad<{ items: TrashItem[]; days: number }>(url);
  const { write, me } = useStore();
  const [purging, setPurging] = useState<TrashItem | null>(null);
  if (error) return <div className="banner">{error}</div>;
  if (!value) return <div className="skel">Загружаем корзину…</div>;
  return (
    <section className="card">
      <p className="muted small" style={{ marginTop: 0 }}>
        Удалённое хранится {value.days} дней, потом удаляется навсегда. Восстановленная запись получает прежний номер, результаты, комментарии,
        вложения и историю.
      </p>
      {!value.items.length ? (
        <Empty title="Корзина пуста">Здесь появятся удалённые тест-кейсы, прогоны и баги.</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Что</th><th>ID</th><th>Название</th><th>Удалил</th><th>Когда</th><th>Удалится навсегда</th><th /></tr>
            </thead>
            <tbody>
              {value.items.map((t) => (
                <tr key={t.id}>
                  <td className="small">{KIND[t.kind]}</td>
                  <td className="mono small">{t.ref}</td>
                  <td className="title">{t.title}</td>
                  <td className="small"><Who login={t.deletedBy} /></td>
                  <td className="small muted">{fmt(t.deleted)}</td>
                  <td className="small muted">{fmt(t.purgeAt)}</td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <button className="btn sm" onClick={() => write(() => api("POST", `${url}/${t.id}/restore`), `${t.ref} восстановлен`)}>Восстановить</button>{" "}
                    {me?.role === "admin" && (
                      <button className="btn sm danger" onClick={() => setPurging(t)}>
                        Навсегда
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {purging && (
        <Confirm title={`Удалить ${purging.ref} навсегда?`} text="Запись и её вложения удалятся без возможности восстановления." action="Удалить навсегда"
          onClose={() => setPurging(null)}
          onYes={async () => {
            await write(() => api("DELETE", `${url}/${purging.id}`, {}), "Удалено навсегда");
            setPurging(null);
          }} />
      )}
    </section>
  );
}
