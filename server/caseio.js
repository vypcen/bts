// Импорт и экспорт тест-кейсов в CSV. Монтируется на /api/projects/:key
// Формат открывается в Excel и Google Таблицах; понимает и выгрузки TestRail/Qase (английские заголовки и значения).
// Импорт идёт в два шага: dryRun показывает, что будет создано и обновлено, затем тот же файл применяется одной транзакцией
const express = require("express");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const checklist = require("./checklist");
const { wrap, str } = require("./util");

const router = express.Router({ mergeParams: true });
const MAX_ROWS = 5000;
const SEP = " / "; // разделитель вложенных папок в колонке «Папка»

// Колонки файла: заголовок при экспорте и варианты, которые узнаются при импорте (без учёта регистра)
const COLUMNS = [
  { key: "id", header: "ID", aliases: ["id", "ид", "номер"] },
  { key: "folder", header: "Папка", aliases: ["папка", "раздел", "folder", "section", "suite"] },
  { key: "title", header: "Название", aliases: ["название", "заголовок", "title", "name", "summary"] },
  { key: "priority", header: "Приоритет", aliases: ["приоритет", "priority"] },
  { key: "status", header: "Статус", aliases: ["статус", "status", "state"] },
  { key: "pre", header: "Предусловия", aliases: ["предусловия", "preconditions", "precondition"] },
  { key: "steps", header: "Шаги", aliases: ["шаги", "steps", "steps (text)"] },
  { key: "expected", header: "Ожидаемый результат", aliases: ["ожидаемый результат", "expected", "expected result", "expected result(s)"] },
  // в конце, чтобы файлы, выгруженные до появления чек-листов, читались так же
  { key: "kind", header: "Тип", aliases: ["тип", "вид", "type", "kind"] },
];

// Значения → ключи. Свои подписи, ключи API и привычные слова других систем
const PRIORITY = {
  critical: "critical", "критический": "critical", blocker: "critical", highest: "critical",
  high: "high", "высокий": "high", major: "high",
  medium: "medium", "средний": "medium", normal: "medium",
  low: "low", "низкий": "low", minor: "low", trivial: "low", lowest: "low",
};
const STATUS = {
  draft: "draft", "черновик": "draft",
  ready: "ready", "готов": "ready", actual: "ready", active: "ready", approved: "ready",
  deprecated: "deprecated", "устарел": "deprecated", outdated: "deprecated",
};
const KIND = {
  "тест-кейс": "case", "кейс": "case", case: "case", "test case": "case", testcase: "case",
  "чек-лист": "checklist", "чеклист": "checklist", checklist: "checklist", "check list": "checklist", "check-list": "checklist",
};
const LABEL = {
  kind: { case: "Тест-кейс", checklist: "Чек-лист" },
  priority: { critical: "Критический", high: "Высокий", medium: "Средний", low: "Низкий" },
  status: { draft: "Черновик", ready: "Готов", deprecated: "Устарел" },
};

// ---------- CSV ----------
// Разделитель — тот, которого больше всего в строке заголовков (Excel в русской локали пишет «;»)
function detectDelimiter(text) {
  const head = text.slice(0, text.search(/\r?\n|$/));
  const count = (ch) => head.split(ch).length - 1;
  return [";", ",", "\t"].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ";");
}

// RFC 4180: кавычки, удвоенные кавычки, переносы строк внутри ячейки. Запомнив строку начала записи, ошибку можно показать по номеру строки
function parseCsv(text) {
  const d = detectDelimiter(text);
  const rows = [];
  let row = [], cell = "", quoted = false, line = 1, start = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === d) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push({ cells: row, line: start });
      row = [];
      cell = "";
      start = ++line;
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push({ cells: row, line: start });
  }
  // пустые строки (в том числе в конце файла) пропускаем
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ""));
}

// Ячейка, начинающаяся с = + - @, в Excel выполнится как формула (CSV-инъекция) — экспортируем её с апострофом
const FORMULA = /^[=+\-@\t\r]/;
const csvCell = (v) => {
  let s = String(v ?? "");
  if (FORMULA.test(s)) s = "'" + s;
  return /[;"\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// …а при импорте этот апостроф снимаем: файл, выгруженный отсюда же, возвращается без изменений
const unescapeCell = (s) => (s.startsWith("'") && FORMULA.test(s.slice(1)) ? s.slice(1) : s);

// ---------- папки ----------
async function folderPaths(db, key) {
  const { rows } = await db.query("SELECT id, parent_id, name FROM case_folders WHERE project_key=$1", [key]);
  const byId = new Map(rows.map((f) => [f.id, f]));
  const pathOf = (id) => {
    const parts = [];
    for (let f = byId.get(id); f && parts.length < 50; f = byId.get(f.parent_id)) parts.unshift(f.name);
    return parts.join(SEP);
  };
  return { byId, pathOf, idByPath: new Map(rows.map((f) => [pathOf(f.id), f.id])) };
}

// «Авторизация / Вход» → ["Авторизация", "Вход"]. TestRail пишет вложенные разделы через «>»: «Auth > Login»
const splitPath = (raw) => raw.split(/[/>]/).map((s) => s.trim()).filter(Boolean);

// ---------- экспорт ----------
// ?folder=all (по умолчанию) | none — без папки | <id> — папка с подпапками. ?template=1 — пустой шаблон с примером
router.get("/cases/export", wrap(async (req, res) => {
  const key = req.params.key;
  const { byId, pathOf } = await folderPaths(pool, key);
  let rows = [];
  if (req.query.template) {
    rows = [
      { id: "", folder: "Авторизация / Вход", title: "Вход с неверным паролем", priority: "Высокий", status: "Готов", kind: "Тест-кейс",
        pre: "Есть зарегистрированный пользователь", steps: "Открыть страницу входа\nВвести неверный пароль\nНажать «Войти»",
        expected: "Сообщение «Неверный логин или пароль», вход не выполнен" },
      { id: "", folder: "Релиз", title: "Смоук перед релизом", priority: "Критический", status: "Готов", kind: "Чек-лист", pre: "", expected: "",
        steps: "Главная страница открывается\nВход и выход работают\nКорзина оформляется" },
    ];
  } else {
    const sel = String(req.query.folder || "all");
    const { rows: cases } = await pool.query(
      "SELECT num, kind, folder_id, title, priority, status, preconditions, steps, expected FROM test_cases WHERE project_key=$1 ORDER BY num", [key]
    );
    // папка вместе со всеми вложенными
    const inside = (id) => {
      for (let f = byId.get(id); f; f = byId.get(f.parent_id)) if (String(f.id) === sel) return true;
      return false;
    };
    rows = cases
      .filter((c) => sel === "all" || (sel === "none" ? c.folder_id === null : c.folder_id !== null && inside(c.folder_id)))
      .map((c) => ({
        id: `${key}-${c.num}`, folder: c.folder_id ? pathOf(c.folder_id) : "", title: c.title,
        priority: LABEL.priority[c.priority], status: LABEL.status[c.status], pre: c.preconditions, steps: c.steps, expected: c.expected,
        kind: LABEL.kind[c.kind],
      }));
  }
  const lines = [COLUMNS.map((c) => c.header), ...rows.map((r) => COLUMNS.map((c) => r[c.key]))].map((cells) => cells.map(csvCell).join(";"));
  const name = req.query.template ? `${key}-шаблон.csv` : `${key}-кейсы.csv`;
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${key}-cases.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  // BOM — чтобы Excel понял, что файл в UTF-8, а не показал кириллицу «кракозябрами»
  res.send("﻿" + lines.join("\r\n") + "\r\n");
}));

// ---------- импорт ----------
// Разбирает файл и сверяет с базой. Ничего не пишет: план, по которому потом работает apply()
async function plan(db, key, text) {
  const errors = [];
  const records = parseCsv(text.replace(/^﻿/, ""));
  if (!records.length) return { errors: [{ line: 1, error: "Файл пустой" }] };
  const head = records[0].cells.map((h) => h.trim().toLowerCase().replace(/\s*\*$/, ""));
  const col = {};
  for (const c of COLUMNS) {
    const i = head.findIndex((h) => c.aliases.includes(h));
    if (i >= 0) col[c.key] = i;
  }
  if (col.title === undefined) {
    return { errors: [{ line: 1, error: `Нет колонки «Название». Заголовки файла: ${records[0].cells.join(", ").slice(0, 300)}` }] };
  }
  const data = records.slice(1);
  if (data.length > MAX_ROWS) return { errors: [{ line: 1, error: `Больше ${MAX_ROWS} кейсов за раз — разбейте файл` }] };

  const { rows: existing } = await db.query(
    "SELECT num, kind, folder_id, title, priority, status, preconditions AS pre, steps, expected FROM test_cases WHERE project_key=$1", [key]
  );
  const byNum = new Map(existing.map((c) => [c.num, c]));
  const folders = await folderPaths(db, key);
  const newFolders = new Set();
  const seen = new Set();
  const items = [];

  for (const { cells, line } of data) {
    const get = (k) => (col[k] === undefined ? undefined : unescapeCell((cells[col[k]] ?? "").trim()));
    const err = (error) => errors.push({ line, error });
    const item = { line, title: str(get("title"), 500) };
    if (!item.title) {
      err("Пустое название");
      continue;
    }
    // ID этого проекта — обновить кейс; чужой проект или неизвестный номер — создать новый
    const id = get("id") || "";
    const m = /^([A-Za-z]{2,6})-(\d{1,9})$/.exec(id);
    if (m && m[1].toUpperCase() === key && byNum.has(Number(m[2]))) {
      if (seen.has(id)) {
        err(`${id} встречается в файле дважды`);
        continue;
      }
      seen.add(id);
      item.num = Number(m[2]);
    }
    for (const [k, map] of [["priority", PRIORITY], ["status", STATUS], ["kind", KIND]]) {
      const raw = get(k);
      if (raw === undefined || raw === "") continue; // пусто — у нового кейса значение по умолчанию, у старого прежнее
      const v = map[raw.toLowerCase()];
      if (!v) err(`Неизвестное значение «${raw.slice(0, 50)}» в колонке «${COLUMNS.find((c) => c.key === k).header}»`);
      else item[k] = v;
    }
    for (const k of ["pre", "steps", "expected"]) if (get(k) !== undefined) item[k] = str(get(k));
    // чек-лист: шаги — это пункты; предусловий и ожидаемого результата у него нет
    const kind = item.kind || (item.num !== undefined ? byNum.get(item.num).kind : "case");
    if (kind === "checklist") {
      if (item.steps !== undefined || item.num === undefined || item.kind) {
        const { steps, error } = checklist.check(item.steps ?? byNum.get(item.num)?.steps ?? "");
        if (error) err(error);
        else item.steps = steps;
      }
      if (item.pre !== undefined || item.kind) item.pre = "";
      if (item.expected !== undefined || item.kind) item.expected = "";
    }
    if (get("folder") !== undefined) {
      const parts = splitPath(get("folder"));
      if (parts.some((p) => p.length > 200)) err("Название папки длиннее 200 символов");
      item.folder = parts.join(SEP);
      // недостающие папки по пути: «А / Б / В» → «А», «А / Б», «А / Б / В»
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join(SEP);
        if (!folders.idByPath.has(path)) newFolders.add(path);
      }
    }
    items.push(item);
  }

  const toUpdate = items.filter((i) => i.num !== undefined);
  const changed = toUpdate.filter((i) => {
    const c = byNum.get(i.num);
    const folderChanged = i.folder !== undefined && i.folder !== (c.folder_id ? folders.pathOf(c.folder_id) : "");
    return folderChanged || ["kind", "title", "priority", "status", "pre", "steps", "expected"].some((k) => i[k] !== undefined && i[k] !== c[k]);
  });
  return {
    errors,
    items,
    folders,
    summary: { rows: data.length, create: items.length - toUpdate.length, update: changed.length, unchanged: toUpdate.length - changed.length, folders: newFolders.size },
  };
}

async function apply(db, key, userId, { items, folders }) {
  // папки: сначала родители (по длине пути), на каждом уровне — найти или создать
  const ids = new Map(folders.idByPath);
  const paths = [...new Set(items.filter((i) => i.folder).flatMap((i) => {
    const parts = i.folder.split(SEP);
    return parts.map((_, n) => parts.slice(0, n + 1).join(SEP));
  }))].sort((a, b) => a.split(SEP).length - b.split(SEP).length);
  for (const path of paths) {
    if (ids.has(path)) continue;
    const parts = path.split(SEP);
    const parent = parts.length > 1 ? ids.get(parts.slice(0, -1).join(SEP)) : null;
    const { rows } = await db.query(
      "INSERT INTO case_folders(project_key, parent_id, name, created_by) VALUES ($1,$2,$3,$4) RETURNING id",
      [key, parent, parts[parts.length - 1], userId]
    );
    ids.set(path, rows[0].id);
  }
  const folderOf = (i) => (i.folder ? ids.get(i.folder) : null);

  for (const i of items.filter((x) => x.num !== undefined)) {
    // присланные колонки меняются, отсутствующие в файле — остаются как были
    await db.query(
      `UPDATE test_cases SET title=$1, priority=COALESCE($2, priority), status=COALESCE($3, status), preconditions=COALESCE($4, preconditions),
         steps=COALESCE($5, steps), expected=COALESCE($6, expected), folder_id=CASE WHEN $7 THEN $8 ELSE folder_id END,
         updated_by=$9, updated_at=now(), kind=COALESCE($12, kind)
       WHERE project_key=$10 AND num=$11`,
      [i.title, i.priority ?? null, i.status ?? null, i.pre ?? null, i.steps ?? null, i.expected ?? null,
        i.folder !== undefined, i.folder !== undefined ? folderOf(i) : null, userId, key, i.num, i.kind ?? null]
    );
  }

  const fresh = items.filter((x) => x.num === undefined);
  if (fresh.length) {
    // номера выдаются одним блоком — параллельное создание кейса не получит тот же номер
    const { rows } = await db.query("UPDATE projects SET seq=seq+$1 WHERE key=$2 RETURNING seq", [fresh.length, key]);
    const first = rows[0].seq - fresh.length + 1;
    await db.query(
      `INSERT INTO test_cases(project_key, num, folder_id, title, priority, status, preconditions, steps, expected, kind, created_by, updated_by)
       SELECT $1, u.*, $11, $11 FROM unnest($2::int[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[]) AS u`,
      [
        key, fresh.map((_, n) => first + n), fresh.map(folderOf), fresh.map((i) => i.title), fresh.map((i) => i.priority || "medium"),
        fresh.map((i) => i.status || "draft"), fresh.map((i) => i.pre || ""), fresh.map((i) => i.steps || ""), fresh.map((i) => i.expected || ""),
        fresh.map((i) => i.kind || "case"), userId,
      ]
    );
  }
}

// Тело: {"csv": "текст файла", "dryRun": true}. Ответ — сводка и ошибки по строкам; при ошибках ничего не применяется
router.post("/cases/import", wrap(async (req, res) => {
  const text = typeof req.body.csv === "string" ? req.body.csv : "";
  if (!text.trim()) return res.status(400).json({ error: "Передайте содержимое CSV-файла в поле csv" });
  const key = req.params.key;
  if (req.body.dryRun) {
    const p = await plan(pool, key, text);
    return res.json({ summary: p.summary || null, errors: p.errors.slice(0, 100), errorCount: p.errors.length });
  }
  const out = await tx(async (db) => {
    // блокировка проекта: два одновременных импорта не создадут одинаковые папки и не перепутают номера
    await db.query("SELECT 1 FROM projects WHERE key=$1 FOR UPDATE", [key]);
    const p = await plan(db, key, text);
    if (p.errors.length) return p;
    await apply(db, key, req.user.id, p);
    return p;
  });
  if (out.errors.length) return res.status(400).json({ error: "В файле есть ошибки, ничего не импортировано", errors: out.errors.slice(0, 100), errorCount: out.errors.length });
  broadcast("cases");
  broadcast("folders");
  res.json({ summary: out.summary });
}));

module.exports = { router, parseCsv, csvCell };
