import { useState } from "react";
import { api, paths } from "../api";
import { useStore } from "../store";
import { Modal } from "../ui";

interface Summary { rows: number; create: number; update: number; unchanged: number; folders: number }
interface Check { summary: Summary | null; errors: { line: number; error: string }[]; errorCount: number }

// 1 строка, 2 строки, 5 строк, 11 строк, 21 строка
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};

// Excel в русской Windows часто сохраняет CSV в Windows-1251: если файл не читается как UTF-8, пробуем её
async function readText(file: File) {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

// Импорт в два шага: сервер проверяет файл и показывает, что изменится, — и только после подтверждения применяет
export function ImportModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const { write, toast } = useStore();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(f: File | undefined) {
    setCheck(null);
    if (!f) return setFile(null);
    if (f.size > 4 * 1024 * 1024) return toast("Файл больше 4 МБ — разбейте его на части");
    const csv = await readText(f);
    setFile({ name: f.name, csv });
    setBusy(true);
    try {
      setCheck(await api<Check>("POST", paths.casesImport(pid), { csv, dryRun: true }));
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!file) return;
    let s: Summary | null = null;
    const ok = await write(async () => {
      s = (await api<{ summary: Summary }>("POST", paths.casesImport(pid), { csv: file.csv })).summary;
    });
    if (ok && s) {
      const { create, update } = s;
      toast(`Импорт готов: создано ${create}, обновлено ${update}`);
      onClose();
    }
  }

  const s = check?.summary;
  const nothing = s && !s.create && !s.update && !s.folders;
  return (
    <Modal onClose={onClose} wide>
      <h2>Импорт тест-кейсов</h2>
      <p className="muted small" style={{ margin: 0 }}>
        CSV из Excel, Google Таблиц, TestRail или Qase. Нужна колонка «Название»; ещё узнаются ID, Папка, Приоритет, Статус, Предусловия, Шаги,
        Ожидаемый результат, Тип («Тест-кейс» или «Чек-лист»; у чек-листа пункты пишутся в «Шаги»). Строка с ID этого проекта ({pid}-12) обновляет кейс, без ID — создаёт новый. Папки вида «Авторизация / Вход» создаются сами.{" "}
        <a href={`${paths.casesExport(pid)}?template=1`}>Скачать шаблон</a>
      </p>
      <div className="field">
        <label htmlFor="imp-file">Файл</label>
        <input className="input" id="imp-file" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {busy && <div className="muted">Проверяем файл…</div>}
      {s && (
        <div className="linkbox">
          В файле {s.rows} {plural(s.rows, "строка", "строки", "строк")}: <b>создать {s.create}</b>, <b>обновить {s.update}</b>
          {s.unchanged > 0 && <>, без изменений {s.unchanged}</>}
          {s.folders > 0 && <>, новых папок {s.folders}</>}.
        </div>
      )}
      {check && check.errorCount > 0 && (
        <div className="banner" style={{ margin: 0 }}>
          <b>Ошибок: {check.errorCount}. Исправьте файл — пока они есть, ничего не импортируется.</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, maxHeight: 220, overflow: "auto" }}>
            {check.errors.map((e, i) => <li key={i}>Строка {e.line}: {e.error}</li>)}
          </ul>
        </div>
      )}
      <div className="acts">
        <button type="button" className="btn" onClick={onClose}>Отмена</button>
        <button type="button" className="btn primary" disabled={!s || !!check?.errorCount || !!nothing || busy} onClick={run}>
          {s && !check?.errorCount ? `Импортировать (${s.create + s.update})` : "Импортировать"}
        </button>
      </div>
    </Modal>
  );
}
