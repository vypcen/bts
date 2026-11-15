// M-04: резервные копии (#/users/backups): список, «Создать сейчас», скачать, проверить, удалить
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { Confirm, Empty, fmt, fmtSize, Modal } from "../ui";

interface Check { what: string; ok: boolean | null; note?: string }
interface Verify { at: string; ok: boolean; checks: Check[] }
interface Backup {
  id: number;
  name: string;
  status: "running" | "ok" | "failed";
  trigger: "manual" | "schedule" | "cron";
  target: "local" | "s3";
  size: number | null;
  manifest: { version: string; migration: string; counts: Record<string, number | null>; storage: string; attachments: { rows: number; missing: number } } | null;
  verify: Verify | null;
  error: string | null;
  createdBy: string | null;
  startedAt: number;
  finishedAt: number | null;
}
interface Settings { target: "local" | "s3"; dir: string | null; keep: number; everyHours: number; verifyRestore: boolean; attachments: string }

const TRIGGER: Record<Backup["trigger"], string> = { manual: "вручную", schedule: "по расписанию", cron: "CronJob" };
const COUNT_LABEL: Record<string, string> = { projects: "проектов", users: "пользователей", test_cases: "тест-кейсов", test_runs: "прогонов", run_results: "результатов", bugs: "дефектов", attachments: "вложений", comments: "комментариев" };

function hours(n: number) {
  if (!n) return "выключено";
  if (n % 24 === 0) return n === 24 ? "раз в сутки" : `раз в ${n / 24} сут.`;
  return `раз в ${n} ч`;
}

export function Backups() {
  const { toast } = useStore();
  const [list, setList] = useState<Backup[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Backup | null>(null);
  const [del, setDel] = useState<Backup | null>(null);
  const load = () =>
    api<{ backups: Backup[]; settings: Settings }>("GET", "/api/admin/backups").then((r) => {
      setList(r.backups);
      setSettings(r.settings);
      setOpen((o) => (o ? r.backups.find((b) => b.id === o.id) || null : null));
    }, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  // пока копия создаётся или проверяется — обновляем список
  const busy = list?.some((b) => b.status === "running");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy]);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      setTimeout(load, 600);
    } catch (e: any) {
      toast(e.message);
    }
  };
  if (error) return <div className="banner">{error}</div>;
  if (!list || !settings) return null;
  const last = list.find((b) => b.status === "ok");
  return (
    <section className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>Резервные копии</h3>
        <button className="btn primary" disabled={busy} onClick={() => act(() => api("POST", "/api/admin/backups", {}), "Копия создаётся — это может занять несколько минут")}>
          {busy ? "Создаётся…" : "Создать сейчас"}
        </button>
      </div>
      <p className="muted small">
        В копию входят база данных и {settings.attachments === "в S3" ? "проверка, что все файлы вложений на месте в S3 (сами файлы защищают версионирование и репликация бакета)" : settings.attachments === "в копии" ? "файлы вложений" : "только база (BACKUP_ATTACHMENTS=false)"}.
        {" "}Хранилище: {settings.target === "s3" ? "S3, тот же бакет" : <>папка <code>{settings.dir}</code></>} · расписание: {hours(settings.everyHours)} · хранятся последние {settings.keep}
        {" "}· пробное восстановление: {settings.verifyRestore ? "включено" : "не настроено (BACKUP_VERIFY_DATABASE_URL)"}.
      </p>
      {last && Date.now() - last.startedAt > 2 * 86400e3 && <div className="banner">Последней удачной копии больше двух суток.</div>}
      {!last && <div className="banner">Удачных резервных копий пока нет.</div>}
      {list.length === 0 ? (
        <Empty title="Копий ещё не было">Нажмите «Создать сейчас».</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Когда</th><th>Файл</th><th>Размер</th><th>Как</th><th>Проверка</th><th /></tr></thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td className="small">{fmt(b.startedAt)}</td>
                  <td className="wrap"><a href="#" onClick={(e) => { e.preventDefault(); setOpen(b); }}>{b.name}</a></td>
                  <td className="small">{b.size ? fmtSize(b.size) : "—"}</td>
                  <td className="small muted">{TRIGGER[b.trigger]}{b.createdBy ? ` · ${b.createdBy}` : ""}</td>
                  <td className="small">
                    {b.status === "running" ? <span className="muted">создаётся…</span>
                      : b.status === "failed" ? <span className="t-crit" title={b.error || ""}>ошибка</span>
                      : b.verify?.ok ? <span className="t-ok">✓ пройдена</span>
                      : <span className="t-crit">есть замечания</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {b.status === "ok" && <a className="btn sm" href={`/api/admin/backups/${b.id}/download`} download>Скачать</a>}{" "}
                    {b.status !== "running" && <button className="btn ghost sm" onClick={() => setDel(b)}>Удалить</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        Восстановление: остановите приложение и выполните <code>node scripts/backup.js restore testball-….tar --yes</code> (подробно — «Справка → Руководство администратора → Резервные копии»).
      </p>
      {open && (
        <Modal onClose={() => setOpen(null)}>
          <h2>{open.name}</h2>
          {open.status === "failed" && <div className="banner">{open.error}</div>}
          {open.manifest && (
            <p className="small">
              Версия {open.manifest.version}, миграция <code>{open.manifest.migration}</code>.<br />
              {Object.entries(open.manifest.counts).filter(([, n]) => n !== null).map(([t, n]) => `${n} ${COUNT_LABEL[t] || t}`).join(", ")}.
            </p>
          )}
          {open.verify && (
            <>
              <h3>Проверка {fmt(Date.parse(open.verify.at))}</h3>
              <table className="tbl">
                <tbody>
                  {open.verify.checks.map((c, i) => (
                    <tr key={i}>
                      <td style={{ width: 24 }} className={c.ok === false ? "t-crit" : c.ok ? "t-ok" : "muted"}>{c.ok === false ? "✗" : c.ok ? "✓" : "–"}</td>
                      <td>{c.what}</td>
                      <td className="small muted wrap">{c.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <div className="acts">
            {open.status === "ok" && <button className="btn" onClick={() => act(() => api("POST", `/api/admin/backups/${open.id}/verify`, {}), "Проверка запущена")}>Проверить ещё раз</button>}
            <button className="btn ghost" onClick={() => setOpen(null)}>Закрыть</button>
          </div>
        </Modal>
      )}
      {del && (
        <Confirm
          title="Удалить копию?"
          text={`Файл ${del.name} будет удалён из хранилища без возможности восстановления.`}
          action="Удалить"
          onYes={() => act(() => api("DELETE", `/api/admin/backups/${del.id}`), "Копия удалена")}
          onClose={() => setDel(null)}
        />
      )}
    </section>
  );
}
