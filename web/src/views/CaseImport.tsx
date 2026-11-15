// Импорт тест-кейсов (M-06): Excel (xlsx) или CSV — из своих таблиц, Zephyr Scale, Xray, TestRail, Qase.
// Мастер: файл → лист и сопоставление колонок (предлагается само) → проверка (что создастся и ошибки по строкам) → импорт.
import { useMemo, useState } from "react";
import { api, paths } from "../api";
import { useStore } from "../store";
import { Modal } from "../ui";

interface Summary { rows: number; create: number; update: number; unchanged: number; folders: number }
interface Check { summary: Summary | null; errors: { line: number; error: string }[]; errorCount: number; preview?: { title: string; folder?: string; steps: number; update: boolean }[] }
interface Sheet { name: string; headerRow: number; header: string[]; sample: string[][]; total: number; suggest: { map: Record<string, number>; fields: Record<string, number> } }
interface Table { targets: { key: string; label: string }[]; fields: { id: number; name: string; type: string }[]; sheets: Sheet[] }

// 1 строка, 2 строки, 5 строк
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};

// Excel в русской Windows часто сохраняет CSV в Windows-1251: такой файл перекодируем в UTF-8 перед отправкой
async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let data = bytes;
  if (!/\.xls[xm]$/i.test(file.name)) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = new TextDecoder("windows-1251").decode(bytes); }
    data = new TextEncoder().encode(text);
  }
  let bin = "";
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(bin);
}

const HINT: Record<string, string> = {
  steps: "по строке на шаг; строки без названия ниже кейса — тоже его шаги",
  stepExpected: "напротив каждого шага", stepData: "напротив каждого шага", folder: "«Авторизация / Вход» — вложенные папки",
  id: "номер этого проекта — обновить кейс", tags: "через запятую",
};

export function ImportModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const { write, toast } = useStore();
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [table, setTable] = useState<Table | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  // сопоставление: номер колонки → «t:ключ» (колонка TestBall) | «f:id» (поле) | ""
  const [map, setMap] = useState<Record<number, string>>({});
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);

  const sheet = table?.sheets[sheetIdx];
  const applySuggest = (sh: Sheet) => {
    const m: Record<number, string> = {};
    for (const [k, i] of Object.entries(sh.suggest.map)) m[i] = `t:${k}`;
    for (const [id, i] of Object.entries(sh.suggest.fields)) m[i] = `f:${id}`;
    setMap(m);
    setCheck(null);
  };

  async function pick(f: File | undefined) {
    setTable(null); setCheck(null);
    if (!f) return setFile(null);
    if (f.size > 15 * 1024 * 1024) return toast("Файл больше 15 МБ — разбейте его на части");
    setBusy(true);
    try {
      const b64 = await fileBase64(f);
      const t = await api<Table>("POST", `${paths.casesImport(pid)}/table`, { file: b64, name: f.name });
      setFile({ name: f.name, b64 });
      setTable(t);
      // лист с данными: первый, где есть строки и найдено название
      const best = Math.max(0, t.sheets.findIndex((s) => s.total > 0 && s.suggest.map.title !== undefined));
      setSheetIdx(best);
      applySuggest(t.sheets[best]);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  const body = useMemo(() => {
    const m: Record<string, number> = {};
    const fl: Record<string, number> = {};
    for (const [i, v] of Object.entries(map)) {
      if (v.startsWith("t:")) m[v.slice(2)] = Number(i);
      else if (v.startsWith("f:")) fl[v.slice(2)] = Number(i);
    }
    return { file: file?.b64, name: file?.name, sheet: sheetIdx, headerRow: sheet?.headerRow ?? 0, map: m, fields: fl };
  }, [map, file, sheetIdx, sheet]);
  const hasTitle = body.map.title !== undefined;

  async function verify() {
    setBusy(true);
    try {
      setCheck(await api<Check>("POST", `${paths.casesImport(pid)}/mapped`, { ...body, dryRun: true }));
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    let s: Summary | null = null;
    const ok = await write(async () => { s = (await api<{ summary: Summary }>("POST", `${paths.casesImport(pid)}/mapped`, body)).summary; });
    if (ok && s) {
      const { create, update } = s;
      toast(`Импорт готов: создано ${create}, обновлено ${update}`);
      onClose();
    }
  }
  const setCol = (i: number, v: string) => {
    const next = { ...map };
    // одна цель — одна колонка: предыдущая колонка с той же целью освобождается
    if (v) for (const [k, x] of Object.entries(next)) if (x === v) delete next[Number(k)];
    if (v) next[i] = v; else delete next[i];
    setMap(next);
    setCheck(null);
  };

  const s = check?.summary;
  const nothing = s && !s.create && !s.update && !s.folders;
  return (
    <Modal onClose={onClose} wide>
      <h2>Импорт тест-кейсов</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Excel (.xlsx) или CSV: свои таблицы, выгрузки Zephyr Scale, Xray, TestRail, Qase. Колонки сопоставятся сами — проверьте и поправьте.
        Шаги можно держать в одной ячейке (по строке на шаг) или по строкам таблицы: строки без названия ниже кейса считаются его шагами.{" "}
        <a href={`${paths.casesExport(pid)}?template=1`}>Скачать шаблон</a>
      </p>
      <div className="field">
        <label htmlFor="imp-file">Файл</label>
        <input className="input" id="imp-file" type="file" accept=".xlsx,.xlsm,.csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {busy && <div className="muted">Читаем файл…</div>}
      {table && sheet && (
        <>
          {table.sheets.length > 1 && (
            <div className="field">
              <label htmlFor="imp-sheet">Лист</label>
              <select className="input" id="imp-sheet" value={sheetIdx} onChange={(e) => { const i = Number(e.target.value); setSheetIdx(i); applySuggest(table.sheets[i]); }}>
                {table.sheets.map((x, i) => <option key={i} value={i}>{x.name} · {x.total} {plural(x.total, "строка", "строки", "строк")}</option>)}
              </select>
            </div>
          )}
          <div className="tbl-wrap" style={{ maxHeight: 360, overflow: "auto" }}>
            <table>
              <thead><tr><th>Колонка файла</th><th>Примеры</th><th>Куда в TestBall</th></tr></thead>
              <tbody>
                {sheet.header.map((h, i) => {
                  const cur = map[i] || "";
                  const tkey = cur.startsWith("t:") ? cur.slice(2) : "";
                  return (
                    <tr key={i}>
                      <td className="wrap"><b>{h || `Колонка ${i + 1}`}</b></td>
                      <td className="small muted wrap" style={{ maxWidth: 280 }}>{sheet.sample.map((r) => r[i]).filter((x) => x && x.trim()).slice(0, 3).map((x) => x.slice(0, 60)).join(" · ") || "—"}</td>
                      <td>
                        <select className="input" aria-label={`Куда: ${h || `колонка ${i + 1}`}`} value={cur} onChange={(e) => setCol(i, e.target.value)}>
                          <option value="">Не импортировать</option>
                          {table.targets.map((t) => <option key={t.key} value={`t:${t.key}`}>{t.label}</option>)}
                          {table.fields.length > 0 && <optgroup label="Пользовательские поля">{table.fields.map((f) => <option key={f.id} value={`f:${f.id}`}>{f.name}</option>)}</optgroup>}
                        </select>
                        {tkey && HINT[tkey] && <div className="small muted">{HINT[tkey]}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!hasTitle && <div className="err">Выберите колонку с названием кейса.</div>}
        </>
      )}
      {s && (
        <div className="linkbox">
          В файле {s.rows} {plural(s.rows, "кейс", "кейса", "кейсов")}: <b>создать {s.create}</b>, <b>обновить {s.update}</b>
          {s.unchanged > 0 && <>, без изменений {s.unchanged}</>}
          {s.folders > 0 && <>, новых папок {s.folders}</>}.
          {check?.preview?.length ? (
            <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {check.preview.map((p, i) => <li key={i}>{p.update ? "обновить: " : ""}{p.title}{p.folder ? <span className="muted"> · {p.folder}</span> : null}{p.steps ? <span className="muted"> · шагов {p.steps}</span> : null}</li>)}
            </ul>
          ) : null}
        </div>
      )}
      {check && check.errorCount > 0 && (
        <div className="banner" style={{ margin: 0 }}>
          <b>Ошибок: {check.errorCount}. Исправьте файл или сопоставление — пока они есть, ничего не импортируется.</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, maxHeight: 220, overflow: "auto" }}>
            {check.errors.map((e, i) => <li key={i}>Строка {e.line}: {e.error}</li>)}
          </ul>
        </div>
      )}
      <div className="acts">
        <button type="button" className="btn" onClick={onClose}>Отмена</button>
        {!s || check?.errorCount ? (
          <button type="button" className="btn primary" disabled={!table || !hasTitle || busy} onClick={verify}>Проверить</button>
        ) : (
          <button type="button" className="btn primary" disabled={!!nothing || busy} onClick={run}>Импортировать ({s.create + s.update})</button>
        )}
      </div>
    </Modal>
  );
}
