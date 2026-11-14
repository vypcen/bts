// Экспорт и импорт проекта целиком, миграция из других TMS.
// Экспорт — один JSON-файл (формат testball-project v1): папки, кейсы со всей историей версий, тест-планы, прогоны с результатами,
// баги с историей статусов, комментарии, автотесты и их запуски; с ?files=1 — ещё и вложения (base64).
// Импорт создаёт новый проект из такого файла. Тем же путём переносятся данные из других TMS:
// TestRail (XML-экспорт), TestLink (XML-экспорт), Qase (JSON-экспорт) — они сначала приводятся к формату testball-project.
const express = require("express");
const casemodel = require("./casemodel");
const { pool, tx } = require("./db");
const { broadcast } = require("./live");
const attachments = require("./attachments");
const checklist = require("./checklist");
const xml = require("./xml");
const { wrap, str, num, HttpError } = require("./util");

const FORMAT = "testball-project";
const KEY_RE = /^[A-Z]{2,6}$/;
const MAX_FILES_BYTES = Number(process.env.EXPORT_MAX_FILES_MB || 200) * 1024 * 1024;
const PRIORITIES = ["critical", "high", "medium", "low"];
const iso = (d) => (d ? d.toISOString() : null);

// ---------- экспорт ----------
async function exportProject(key, withFiles) {
  const q = (sql) => pool.query(sql, [key]).then((r) => r.rows);
  const [project] = await q("SELECT key, name, description FROM projects WHERE key=$1");
  if (!project) throw new HttpError(404, "Проект не найден");
  const [customFields] = [await q("SELECT id, entity, name, type, options, required, position FROM custom_fields WHERE project_key=$1 ORDER BY entity, position, id")];
  // значения пользовательских полей — по названию поля: id в другой установке будут другими
  const fieldName = new Map(customFields.map((f) => [String(f.id), f.name]));
  const byName = (vals) => Object.fromEntries(Object.entries(vals || {}).filter(([id]) => fieldName.has(id)).map(([id, v]) => [fieldName.get(id), v]));
  const [folders, cases, versions, plans, planCases, runs, results, bugs, bugLog, comments, autotests, autoruns, autoresults, files] = await Promise.all([
    q("SELECT id, parent_id, name FROM case_folders WHERE project_key=$1 ORDER BY id"),
    q(`SELECT c.*, cu.login AS cb, uu.login AS ub FROM test_cases c LEFT JOIN users cu ON cu.id=c.created_by LEFT JOIN users uu ON uu.id=c.updated_by
       WHERE c.project_key=$1 ORDER BY c.num`),
    q(`SELECT v.*, c.num, u.login AS by FROM test_case_versions v JOIN test_cases c ON c.id=v.case_id LEFT JOIN users u ON u.id=v.changed_by
       WHERE c.project_key=$1 ORDER BY c.num, v.version`),
    q("SELECT p.*, u.login AS lb FROM test_plans p LEFT JOIN users u ON u.id=p.locked_by WHERE p.project_key=$1 ORDER BY p.num"),
    q("SELECT p.num AS plan, c.num, pc.case_version FROM plan_cases pc JOIN test_plans p ON p.id=pc.plan_id JOIN test_cases c ON c.id=pc.case_id WHERE p.project_key=$1"),
    q(`SELECT r.*, p.num AS plan_num, u.login AS cb FROM test_runs r LEFT JOIN test_plans p ON p.id=r.plan_id LEFT JOIN users u ON u.id=r.created_by
       WHERE r.project_key=$1 ORDER BY r.num`),
    q(`SELECT rr.*, t.num AS run_num, c.num AS case_num, eu.login AS eb, au.login AS ab FROM run_results rr JOIN test_runs t ON t.id=rr.run_id
       JOIN test_cases c ON c.id=rr.case_id LEFT JOIN users eu ON eu.id=rr.executed_by LEFT JOIN users au ON au.id=rr.assignee_id
       WHERE t.project_key=$1`),
    q(`SELECT b.*, c.num AS case_num, t.num AS run_num, d.num AS dup_num, au.login AS ab, cu.login AS cb, uu.login AS ub
       FROM bugs b LEFT JOIN test_cases c ON c.id=b.case_id LEFT JOIN run_results rr ON rr.id=b.run_result_id
       LEFT JOIN test_runs t ON t.id=rr.run_id LEFT JOIN bugs d ON d.id=b.duplicate_of
       LEFT JOIN users au ON au.id=b.assignee_id LEFT JOIN users cu ON cu.id=b.created_by LEFT JOIN users uu ON uu.id=b.updated_by
       WHERE b.project_key=$1 ORDER BY b.num`),
    q(`SELECT l.*, b.num, u.login AS by FROM bug_status_log l JOIN bugs b ON b.id=l.bug_id LEFT JOIN users u ON u.id=l.changed_by
       WHERE b.project_key=$1 ORDER BY l.id`),
    q(`SELECT cm.*, b.num AS bug_num, c.num AS case_num, u.login AS author FROM comments cm LEFT JOIN bugs b ON b.id=cm.bug_id
       LEFT JOIN test_cases c ON c.id=cm.case_id LEFT JOIN users u ON u.id=cm.author_id
       WHERE COALESCE(b.project_key, c.project_key)=$1 ORDER BY cm.id`),
    q("SELECT t.*, c.num AS case_num FROM auto_tests t LEFT JOIN test_cases c ON c.id=t.case_id WHERE t.project_key=$1 ORDER BY t.id"),
    q("SELECT r.*, u.login AS cb FROM auto_runs r LEFT JOIN users u ON u.id=r.created_by WHERE r.project_key=$1 ORDER BY r.num"),
    q("SELECT ar.*, r.num AS run_num FROM auto_results ar JOIN auto_runs r ON r.id=ar.run_id WHERE r.project_key=$1"),
    q(`SELECT a.*, u.login AS ub FROM attachments a
       LEFT JOIN bugs b ON b.id=a.bug_id
       LEFT JOIN run_results rr ON rr.id=a.run_result_id LEFT JOIN test_runs t ON t.id=rr.run_id
       LEFT JOIN auto_results ar ON ar.id=a.auto_result_id LEFT JOIN auto_runs r ON r.id=ar.run_id
       LEFT JOIN users u ON u.id=a.uploaded_by
       WHERE COALESCE(b.project_key, t.project_key, r.project_key)=$1 ORDER BY a.created_at`),
  ]);

  const fileMap = {};
  let total = 0;
  for (const a of files) {
    const f = { name: a.filename, mime: a.mime, size: a.size, uploadedBy: a.ub, created: iso(a.created_at) };
    if (withFiles) {
      total += a.size;
      if (total > MAX_FILES_BYTES) throw new HttpError(413, `Вложения больше ${MAX_FILES_BYTES / 1024 / 1024} МБ — выгрузите проект без файлов или увеличьте EXPORT_MAX_FILES_MB`);
      f.data = (await attachments.readFile(a.id).catch(() => Buffer.alloc(0))).toString("base64");
    }
    fileMap[a.id] = f;
  }
  const filesOf = (field, id) => files.filter((a) => a[field] === id).map((a) => a.id);

  return {
    format: FORMAT, version: 1, exported: new Date().toISOString(),
    project: { key: project.key, name: project.name, description: project.description },
    folders: folders.map((f) => ({ id: f.id, parent: f.parent_id, name: f.name })),
    customFields: customFields.map((f) => ({ entity: f.entity, name: f.name, type: f.type, options: f.options, required: f.required, position: f.position })),
    cases: cases.map((c) => ({
      num: c.num, kind: c.kind, folder: c.folder_id, title: c.title, priority: c.priority, status: c.status, pre: c.preconditions,
      steps: c.steps, expected: c.expected, stepList: c.step_list, tags: c.tags, fields: byName(c.fields),
      checked: c.checked, version: c.version, createdBy: c.cb, updatedBy: c.ub,
      created: iso(c.created_at), updated: iso(c.updated_at),
      versions: versions.filter((v) => v.num === c.num).map((v) => ({
        version: v.version, kind: v.kind, title: v.title, priority: v.priority, status: v.status, pre: v.preconditions, steps: v.steps,
        expected: v.expected, stepList: v.step_list, tags: v.tags, fields: byName(v.fields), changedBy: v.by, changed: iso(v.changed_at),
      })),
    })),
    plans: plans.map((p) => ({
      num: p.num, title: p.title, description: p.description, mode: p.mode, filter: p.filter, locked: p.locked, lockedBy: p.lb,
      lockedAt: iso(p.locked_at), created: iso(p.created_at),
      cases: planCases.filter((x) => x.plan === p.num).map((x) => ({ num: x.num, version: x.case_version })),
    })),
    runs: runs.map((r) => ({
      num: r.num, title: r.title, build: r.build, env: r.environment, state: r.state, plan: r.plan_num, createdBy: r.cb, fields: byName(r.fields),
      created: iso(r.created_at), closed: iso(r.closed_at),
      results: results.filter((x) => x.run_num === r.num).map((x) => ({
        case: x.case_num, result: x.result, comment: x.comment, items: x.items, steps: x.step_results, executedBy: x.eb, executed: iso(x.executed_at),
        assignee: x.ab, caseVersion: x.case_version, attachments: filesOf("run_result_id", x.id),
      })),
    })),
    bugs: bugs.map((b) => ({
      num: b.num, title: b.title, status: b.status, severity: b.severity, assignee: b.ab, env: b.environment, steps: b.steps,
      actual: b.actual, expected: b.expected, case: b.case_num, run: b.run_num, duplicateOf: b.dup_num, tags: b.tags, fields: byName(b.fields),
      external: b.external_key ? { key: b.external_key, url: b.external_url, status: b.external_status } : null,
      createdBy: b.cb, updatedBy: b.ub, created: iso(b.created_at), updated: iso(b.updated_at), attachments: filesOf("bug_id", b.id),
      log: bugLog.filter((l) => l.num === b.num).map((l) => ({ from: l.from_status, to: l.to_status, by: l.by, at: iso(l.changed_at) })),
    })),
    comments: comments.map((c) => ({ bug: c.bug_num, case: c.case_num, author: c.author, text: c.body, created: iso(c.created_at), edited: iso(c.edited_at) })),
    autotests: autotests.map((t) => ({
      key: t.test_key, suite: t.suite, name: t.name, file: t.file, steps: t.steps, case: t.case_num, quarantined: t.quarantined, created: iso(t.created_at),
    })),
    autoruns: autoruns.map((r) => ({
      num: r.num, title: r.title, build: r.build, env: r.environment, branch: r.branch, scope: r.scope, url: r.app_url, state: r.state,
      params: r.params, ciUrl: r.ci_url, createdBy: r.cb, created: iso(r.created_at), finished: iso(r.finished_at),
      results: autoresults.filter((x) => x.run_num === r.num).map((x) => ({
        test: autotests.find((t) => t.id === x.test_id)?.test_key, status: x.status, durationMs: x.duration_ms, message: x.message,
        details: x.details, steps: x.steps, retries: x.retries, flaky: x.flaky, created: iso(x.created_at), attachments: filesOf("auto_result_id", x.id),
      })),
    })),
    attachments: fileMap,
  };
}

// ---------- импорт ----------
const arr = (v) => (Array.isArray(v) ? v : []);
const date = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : new Date());
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

// Проверка и подсчёт без записи
function summarize(data) {
  if (!data || data.format !== FORMAT) throw new HttpError(400, "Это не файл экспорта проекта TestBall");
  if (data.version !== 1) throw new HttpError(400, `Версия формата ${data.version} не поддерживается`);
  return {
    folders: arr(data.folders).length, cases: arr(data.cases).length, plans: arr(data.plans).length, runs: arr(data.runs).length,
    bugs: arr(data.bugs).length, comments: arr(data.comments).length, autotests: arr(data.autotests).length, autoruns: arr(data.autoruns).length,
    attachments: Object.keys(data.attachments || {}).length,
    files: Object.values(data.attachments || {}).filter((f) => f.data).length,
  };
}

async function importProject(data, { key, name }, user) {
  summarize(data);
  if (!KEY_RE.test(key)) throw new HttpError(400, "Ключ: от 2 до 6 латинских букв");
  const written = []; // id сохранённых файлов: при откате транзакции их надо удалить
  try {
    return await tx(async (db) => {
      const { rows: exists } = await db.query("SELECT 1 FROM projects WHERE key=$1", [key]);
      if (exists[0]) throw new HttpError(409, `Ключ ${key} уже занят. Укажите другой`);
      const { rows: users } = await db.query("SELECT id, login FROM users");
      const uid = new Map(users.map((u) => [u.login, u.id]));
      const u = (login) => (login ? uid.get(login) ?? null : null);

      const cases = arr(data.cases), runs = arr(data.runs), bugs = arr(data.bugs), plans = arr(data.plans), autoruns = arr(data.autoruns);
      const maxNum = (list) => list.reduce((m, x) => Math.max(m, num(x.num) || 0), 0);
      await db.query(
        `INSERT INTO projects(key, name, description, seq, run_seq, bug_seq, auto_seq, plan_seq, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [key, name || str(data.project?.name, 200) || key, str(data.project?.description, 2000), maxNum(cases), maxNum(runs), maxNum(bugs),
          maxNum(autoruns), maxNum(plans), user.id]
      );
      await db.query("INSERT INTO project_members(project_key, user_id) VALUES ($1,$2)", [key, user.id]);

      // папки: родители раньше детей
      const folderId = new Map();
      const pending = arr(data.folders).slice();
      for (let guard = 0; pending.length && guard < 1000; guard++) {
        for (let i = 0; i < pending.length; i++) {
          const f = pending[i];
          if (f.parent !== null && f.parent !== undefined && !folderId.has(f.parent)) continue;
          const { rows } = await db.query(
            "INSERT INTO case_folders(project_key, parent_id, name, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT ON CONSTRAINT case_folders_name_key DO UPDATE SET name=EXCLUDED.name RETURNING id",
            [key, f.parent == null ? null : folderId.get(f.parent), str(f.name, 200) || "Без названия", user.id]
          );
          folderId.set(f.id, rows[0].id);
          pending.splice(i--, 1);
        }
      }

      // пользовательские поля: создаём и сопоставляем значения по названию
      const fieldIds = { case: new Map(), bug: new Map(), run: new Map() };
      for (const f of arr(data.customFields)) {
        const entity = oneOf(f.entity, ["case", "bug", "run"], null);
        const type = oneOf(f.type, casemodel.TYPES, null);
        if (!entity || !type || !str(f.name, 100)) continue;
        const { rows } = await db.query(
          `INSERT INTO custom_fields(project_key, entity, name, type, options, required, position) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT DO NOTHING RETURNING id`,
          [key, entity, str(f.name, 100), type, JSON.stringify(arr(f.options).map((o) => str(o, 100)).filter(Boolean)), f.required === true, num(f.position) || 0]
        );
        if (rows[0]) fieldIds[entity].set(str(f.name, 100), rows[0].id);
      }
      const fieldsOf = (entity, vals) =>
        Object.fromEntries(Object.entries(vals && typeof vals === "object" ? vals : {}).filter(([n]) => fieldIds[entity].has(n)).map(([n, v]) => [fieldIds[entity].get(n), v]));
      const stepListOf = (c, kind) => (kind === "checklist" ? [] : casemodel.normalizeSteps(c.stepList) || casemodel.stepsFromText(str(c.steps)));

      // кейсы: текущая версия создаётся триггером, прошлые версии — отдельно
      const caseId = new Map();
      for (const c of cases) {
        const n = num(c.num);
        if (!n) continue;
        const kind = oneOf(c.kind, ["case", "checklist"], "case");
        const { rows } = await db.query(
          `INSERT INTO test_cases(project_key, num, kind, folder_id, title, priority, status, preconditions, steps, expected, checked, version,
             created_by, updated_by, created_at, updated_at, step_list, tags, fields)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
          [key, n, kind, c.folder == null ? null : folderId.get(c.folder) ?? null, str(c.title, 500) || `Кейс ${n}`,
            oneOf(c.priority, PRIORITIES, "medium"), oneOf(c.status, ["draft", "ready", "deprecated"], "draft"),
            kind === "checklist" ? "" : str(c.pre), str(c.steps), kind === "checklist" ? "" : str(c.expected),
            c.checked && typeof c.checked === "object" ? c.checked : {}, num(c.version) || 1, u(c.createdBy), u(c.updatedBy), date(c.created), date(c.updated),
            JSON.stringify(stepListOf(c, kind)), casemodel.normalizeTags(c.tags) || [], fieldsOf("case", c.fields)]
        );
        caseId.set(n, rows[0].id);
        for (const v of arr(c.versions)) {
          await db.query(
            `INSERT INTO test_case_versions(case_id, version, kind, title, priority, status, preconditions, steps, expected, changed_by, changed_at,
               step_list, tags, fields)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
            [rows[0].id, num(v.version) || 1, oneOf(v.kind, ["case", "checklist"], "case"), str(v.title, 500) || "—", oneOf(v.priority, PRIORITIES, "medium"),
              oneOf(v.status, ["draft", "ready", "deprecated"], "draft"), str(v.pre), str(v.steps), str(v.expected), u(v.changedBy), date(v.changed),
              JSON.stringify(stepListOf(v, oneOf(v.kind, ["case", "checklist"], "case"))), casemodel.normalizeTags(v.tags) || [], fieldsOf("case", v.fields)]
          );
        }
      }

      const planId = new Map();
      for (const p of plans) {
        const { rows } = await db.query(
          `INSERT INTO test_plans(project_key, num, title, description, mode, filter, locked, locked_by, locked_at, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [key, num(p.num), str(p.title, 300) || "План", str(p.description, 5000), oneOf(p.mode, ["static", "dynamic"], "static"),
            p.filter && typeof p.filter === "object" ? p.filter : {}, p.locked === true, u(p.lockedBy), p.locked ? date(p.lockedAt) : null, user.id, date(p.created)]
        );
        planId.set(num(p.num), rows[0].id);
        for (const x of arr(p.cases)) {
          if (caseId.has(num(x.num))) await db.query("INSERT INTO plan_cases(plan_id, case_id, case_version) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [rows[0].id, caseId.get(num(x.num)), num(x.version)]);
        }
      }

      const files = data.attachments || {};
      async function attach(ids, owner) {
        for (const id of arr(ids)) {
          const f = files[id];
          if (!f?.data) continue;
          const buf = Buffer.from(f.data, "base64");
          const newId = await attachments.writeFile(buf);
          written.push(newId);
          await db.query(
            "INSERT INTO attachments(id, bug_id, run_result_id, auto_result_id, filename, mime, size, uploaded_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [newId, owner.bug || null, owner.result || null, owner.auto || null, str(f.name, 255) || "file", str(f.mime, 100) || "application/octet-stream", buf.length, u(f.uploadedBy), date(f.created)]
          );
        }
      }

      const resultId = new Map(); // "run:case" → id
      for (const r of runs) {
        const { rows } = await db.query(
          `INSERT INTO test_runs(project_key, num, title, build, environment, state, plan_id, created_by, created_at, closed_at, fields)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [key, num(r.num), str(r.title, 300) || "Прогон", str(r.build, 200), str(r.env, 500), oneOf(r.state, ["open", "closed"], "closed"),
            planId.get(num(r.plan)) ?? null, u(r.createdBy), date(r.created), r.closed ? date(r.closed) : null, fieldsOf("run", r.fields)]
        );
        for (const x of arr(r.results)) {
          const cid = caseId.get(num(x.case));
          if (!cid) continue;
          const { rows: rr } = await db.query(
            `INSERT INTO run_results(run_id, case_id, result, comment, items, executed_by, executed_at, assignee_id, case_version, step_results)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
            [rows[0].id, cid, oneOf(x.result, ["untested", "passed", "failed", "blocked", "skipped"], "untested"), str(x.comment),
              x.items && typeof x.items === "object" ? x.items : {}, u(x.executedBy), x.executed ? date(x.executed) : null, u(x.assignee), num(x.caseVersion),
              x.steps && typeof x.steps === "object" && !Array.isArray(x.steps) ? x.steps : {}]
          );
          if (!rr[0]) continue;
          resultId.set(`${num(r.num)}:${num(x.case)}`, rr[0].id);
          await attach(x.attachments, { result: rr[0].id });
        }
      }

      const bugId = new Map();
      for (const b of bugs) {
        const ext = b.external && typeof b.external === "object" ? b.external : null;
        const { rows } = await db.query(
          `INSERT INTO bugs(project_key, num, title, status, severity, assignee_id, environment, steps, actual, expected, case_id, run_result_id,
             external_key, external_url, external_status, created_by, updated_by, created_at, updated_at, tags, fields)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
          [key, num(b.num), str(b.title, 500) || "Баг", oneOf(b.status, ["new", "in_progress", "fixed", "verified", "closed", "rejected", "duplicate"], "new"),
            oneOf(b.severity, ["blocker", "critical", "major", "minor"], "major"), u(b.assignee), str(b.env, 500), str(b.steps), str(b.actual), str(b.expected),
            caseId.get(num(b.case)) ?? null, resultId.get(`${num(b.run)}:${num(b.case)}`) ?? null,
            ext ? str(ext.key, 100) : null, ext ? str(ext.url, 1000) : null, ext ? str(ext.status, 100) : null,
            u(b.createdBy), u(b.updatedBy), date(b.created), date(b.updated), casemodel.normalizeTags(b.tags) || [], fieldsOf("bug", b.fields)]
        );
        bugId.set(num(b.num), rows[0].id);
        for (const l of arr(b.log)) {
          await db.query("INSERT INTO bug_status_log(bug_id, from_status, to_status, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5)",
            [rows[0].id, l.from || null, str(l.to, 20) || "new", u(l.by), date(l.at)]);
        }
        await attach(b.attachments, { bug: rows[0].id });
      }
      for (const b of bugs) {
        if (b.duplicateOf && bugId.has(num(b.duplicateOf))) await db.query("UPDATE bugs SET duplicate_of=$1 WHERE id=$2", [bugId.get(num(b.duplicateOf)), bugId.get(num(b.num))]);
      }

      for (const c of arr(data.comments)) {
        const owner = c.bug ? { bug: bugId.get(num(c.bug)) } : { kase: caseId.get(num(c.case)) };
        if (!owner.bug && !owner.kase) continue;
        await db.query("INSERT INTO comments(bug_id, case_id, author_id, body, created_at, edited_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [owner.bug || null, owner.kase || null, u(c.author), str(c.text, 10000) || "—", date(c.created), c.edited ? date(c.edited) : null]);
      }

      const testId = new Map();
      for (const t of arr(data.autotests)) {
        const tk = str(t.key, 2000);
        if (!tk) continue;
        const { rows } = await db.query(
          `INSERT INTO auto_tests(project_key, test_key, suite, name, file, steps, case_id, quarantined, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (project_key, test_key) DO NOTHING RETURNING id`,
          [key, tk, str(t.suite, 500), str(t.name, 1000) || tk, str(t.file, 500), JSON.stringify(arr(t.steps)), caseId.get(num(t.case)) ?? null, t.quarantined === true, date(t.created)]
        );
        if (rows[0]) testId.set(tk, rows[0].id);
      }
      for (const r of autoruns) {
        const { rows } = await db.query(
          `INSERT INTO auto_runs(project_key, num, title, build, environment, branch, scope, app_url, state, params, ci_url, created_by, created_at, finished_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [key, num(r.num), str(r.title, 300) || "Запуск", str(r.build, 200), str(r.env, 500), str(r.branch, 200), str(r.scope, 500), str(r.url, 500),
            oneOf(r.state, ["queued", "running", "finished", "failed"], "finished"), r.params && typeof r.params === "object" ? r.params : {}, str(r.ciUrl, 1000),
            u(r.createdBy), date(r.created), r.finished ? date(r.finished) : null]
        );
        for (const x of arr(r.results)) {
          const tid = testId.get(x.test);
          if (!tid) continue;
          const { rows: ar } = await db.query(
            `INSERT INTO auto_results(run_id, test_id, status, duration_ms, message, details, steps, retries, flaky, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
            [rows[0].id, tid, oneOf(x.status, ["passed", "failed", "broken", "skipped"], "skipped"), Math.max(0, Math.min(2e9, Number(x.durationMs) || 0)),
              str(x.message, 5000), str(x.details, 50000), JSON.stringify(arr(x.steps)), Math.max(0, Number(x.retries) || 0), x.flaky === true, date(x.created)]
          );
          if (ar[0]) await attach(x.attachments, { auto: ar[0].id });
        }
      }
      return summarize(data);
    });
  } catch (e) {
    for (const id of written) await require("./storage").remove(id);
    throw e;
  }
}

// ---------- миграция из других TMS ----------
// Общий результат конвертеров: {project, folders: [{id, parent, name}], cases: [...]} в формате testball-project
function builder(name) {
  const data = { format: FORMAT, version: 1, project: { key: "", name, description: "" }, folders: [], cases: [], runs: [], bugs: [], plans: [] };
  let fid = 0, cnum = 0;
  return {
    data,
    folder(name, parent = null) {
      data.folders.push({ id: ++fid, parent, name: (name || "Без названия").slice(0, 200) });
      return fid;
    },
    kase(c) {
      data.cases.push({ num: ++cnum, kind: "case", status: "ready", priority: "medium", pre: "", steps: "", expected: "", ...c, title: (c.title || `Кейс ${cnum}`).slice(0, 500) });
    },
  };
}

// «Шаг / ожидаемое» → шаги по строке и ожидаемый результат с номерами шагов
// Шаги из другой TMS: действие и ожидаемый результат каждого шага переносятся как есть (структурные шаги)
function joinSteps(list) {
  const stepList = list
    .map((s) => ({ action: s.action.replace(/\n+/g, " ").trim(), expected: (s.expected || "").replace(/\n+/g, " ").trim(), data: "" }))
    .filter((s) => s.action || s.expected);
  return { steps: stepList.map((s) => s.action).join("\n"), stepList, expected: "" };
}

const PRIO = {
  critical: "critical", blocker: "critical", highest: "critical", "must test": "critical", urgent: "critical",
  high: "high", major: "high", "test if time": "low", medium: "medium", normal: "medium", low: "low", lowest: "low", minor: "low", trivial: "low",
  "1": "low", "2": "medium", "3": "high", "4": "critical",
};
const prio = (v) => PRIO[String(v ?? "").trim().toLowerCase()] || "medium";

function fromTestRail(text) {
  const root = xml.parse(text);
  const suite = xml.child(root, "suite") || xml.child(root, "sections") && root;
  if (!suite) throw new HttpError(400, "Не похоже на XML-экспорт TestRail: нет элемента <suite>");
  const b = builder(xml.text(suite, "name") || "Импорт из TestRail");
  const walk = (sectionsNode, parent) => {
    for (const s of xml.children(sectionsNode, "section")) {
      const id = b.folder(xml.text(s, "name"), parent);
      for (const c of xml.children(xml.child(s, "cases"), "case")) {
        const custom = xml.child(c, "custom") || c;
        const sep = xml.children(xml.child(custom, "steps_separated"), "step");
        const st = sep.length
          ? joinSteps(sep.map((x) => ({ action: xml.htmlToText(xml.text(x, "content")), expected: xml.htmlToText(xml.text(x, "expected")) })))
          : { steps: xml.htmlToText(xml.text(custom, "steps")), expected: xml.htmlToText(xml.text(custom, "expected")) };
        b.kase({
          title: xml.text(c, "title"), folder: id, priority: prio(xml.text(c, "priority")),
          pre: xml.htmlToText(xml.text(custom, "preconds")), ...st,
        });
      }
      walk(xml.child(s, "sections"), id);
    }
  };
  walk(xml.child(suite, "sections"), null);
  return b.data;
}

function fromTestLink(text) {
  const root = xml.parse(text);
  const top = xml.child(root, "testsuite") || xml.child(root, "testcases");
  if (!top) throw new HttpError(400, "Не похоже на XML-экспорт TestLink: нет элемента <testsuite>");
  const b = builder(top.attrs.name || "Импорт из TestLink");
  const IMPORTANCE = { 1: "low", 2: "medium", 3: "high" };
  const cases = (node, folder) => {
    for (const c of xml.children(node, "testcase")) {
      const st = joinSteps(xml.children(xml.child(c, "steps"), "step").map((s) => ({
        action: xml.htmlToText(xml.text(s, "actions")), expected: xml.htmlToText(xml.text(s, "expectedresults")),
      })));
      const summary = xml.htmlToText(xml.text(c, "summary"));
      const pre = xml.htmlToText(xml.text(c, "preconditions"));
      b.kase({
        title: c.attrs.name, folder, priority: IMPORTANCE[xml.text(c, "importance")] || "medium",
        pre: [summary, pre].filter(Boolean).join("\n\n"), ...st,
      });
    }
  };
  const walk = (node, parent) => {
    for (const s of xml.children(node, "testsuite")) {
      const id = b.folder(s.attrs.name, parent);
      cases(s, id);
      walk(s, id);
    }
  };
  // корневой testsuite — сам проект: его кейсы идут в корень, подпапки — его вложенные наборы
  cases(top, null);
  walk(top, null);
  return b.data;
}

function fromQase(text) {
  let json;
  try { json = JSON.parse(text); } catch { throw new HttpError(400, "Файл Qase должен быть JSON-экспортом"); }
  const b = builder(json.title || json.project?.title || "Импорт из Qase");
  const STATUS = { actual: "ready", draft: "draft", deprecated: "deprecated", 0: "ready", 1: "draft", 2: "deprecated" };
  const cases = (list, folder) => {
    for (const c of arr(list)) {
      const st = joinSteps(arr(c.steps).sort((x, y) => (x.position || 0) - (y.position || 0)).map((s) => ({
        action: [s.action, s.data].filter(Boolean).join(" — "), expected: s.expected_result || "",
      })));
      b.kase({
        title: c.title, folder, priority: prio(c.priority), status: STATUS[c.status] || "ready",
        pre: [c.description, c.preconditions].filter(Boolean).join("\n\n"), ...st,
      });
    }
  };
  const walk = (suites, parent) => {
    for (const s of arr(suites)) {
      const id = b.folder(s.title || s.name, parent);
      cases(s.cases, id);
      walk(s.suites || s.children, id);
    }
  };
  cases(json.cases, null);
  walk(json.suites, null);
  return b.data;
}

const CONVERTERS = { testrail: fromTestRail, testlink: fromTestLink, qase: fromQase };

// Источник: {"source": "testball", "data": {...}} или {"source": "testrail"|"testlink"|"qase", "text": "содержимое файла"}
function readSource(body) {
  const source = str(body.source, 20) || "testball";
  if (source === "testball") return body.data;
  const conv = CONVERTERS[source];
  if (!conv) throw new HttpError(400, `Источник: testball, ${Object.keys(CONVERTERS).join(", ")}`);
  if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "Передайте содержимое файла в поле text");
  const data = conv(body.text);
  // чек-листы в чужих TMS не встречаются; пустые шаги допустимы. Проверяем лимиты полей заранее
  for (const c of data.cases) if (c.kind === "checklist") c.steps = checklist.check(c.steps).steps || "";
  return data;
}

// ---------- API ----------
// /api/projects/:key/export — для участников проекта (монтируется после проверки доступа)
const projectRouter = express.Router({ mergeParams: true });
projectRouter.get("/export", wrap(async (req, res) => {
  const data = await exportProject(req.params.key, req.query.files === "1");
  const stamp = new Date().toISOString().slice(0, 10);
  res.set("Content-Disposition", `attachment; filename="${req.params.key}-${stamp}.testball.json"`);
  res.json(data);
}));

// /api/projects-import — создать проект из файла (экспорт TestBall или другой TMS). dryRun — только сводка
const importRouter = express.Router();
importRouter.post("/", wrap(async (req, res) => {
  const data = readSource(req.body);
  const summary = summarize(data);
  if (req.body.dryRun) return res.json({ summary, project: { key: data.project?.key || "", name: data.project?.name || "" } });
  const key = str(req.body.key, 10).toUpperCase() || data.project?.key;
  const out = await importProject(data, { key, name: str(req.body.name, 200) }, req.user);
  broadcast("projects");
  res.status(201).json({ id: key, summary: out });
}));

module.exports = { projectRouter, importRouter, exportProject, importProject, fromTestRail, fromTestLink, fromQase };
