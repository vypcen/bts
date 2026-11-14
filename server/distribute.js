// Автоматическое распределение непроверенных кейсов прогона между исполнителями.
// Трудоёмкость кейса — число шагов (у чек-листа — пунктов), минимум 1. Стратегии:
//   balanced    — сначала самые трудоёмкие, каждый следующий тому, у кого сейчас меньше всего работы (LPT);
//   round_robin — по очереди, в порядке номеров кейсов;
//   by_folder   — папка целиком одному исполнителю (контекст не теряется), папки распределяются по нагрузке.
// Уже назначенные кейсы учитываются в нагрузке; с onlyUnassigned=false перераспределяется всё непроверенное.
const checklist = require("./checklist");
const access = require("./access");
const { HttpError } = require("./util");

const STRATEGIES = ["balanced", "round_robin", "by_folder"];

const weight = (c) => Math.max(1, c.kind === "checklist" ? checklist.items(c.steps).length : c.steps.split("\n").filter((s) => s.trim()).length);

// Исполнители: участники проекта, которые могут отмечать результаты (tester в проекте или admin)
async function executors(db, key, logins) {
  const uniq = [...new Set((Array.isArray(logins) ? logins : []).map((l) => String(l).toLowerCase()))];
  if (!uniq.length) throw new HttpError(400, "Выберите хотя бы одного исполнителя");
  const { rows } = await db.query(
    `SELECT u.id, u.login, u.role AS global_role, m.role AS project_role, (m.user_id IS NOT NULL) AS member
     FROM users u LEFT JOIN project_members m ON m.user_id=u.id AND m.project_key=$1
     WHERE u.login = ANY($2::text[]) AND NOT u.blocked`,
    [key, uniq]
  );
  for (const login of uniq) {
    const u = rows.find((r) => r.login === login);
    const role = !u ? null : u.global_role === "admin" ? "admin" : u.member ? u.project_role || u.global_role : null;
    if (!role) throw new HttpError(400, `${login}: нет доступа к проекту`);
    if (!access.canWrite(role)) throw new HttpError(400, `${login}: роль в проекте не позволяет отмечать результаты`);
  }
  return uniq.map((l) => rows.find((r) => r.login === l));
}

async function distribute(db, key, runId, logins, strategy = "balanced", onlyUnassigned = true) {
  if (!STRATEGIES.includes(strategy)) throw new HttpError(400, `Стратегия: ${STRATEGIES.join(", ")}`);
  const users = await executors(db, key, logins);
  const { rows } = await db.query(
    `SELECT rr.id, rr.assignee_id, c.num, c.kind, c.steps, c.folder_id FROM run_results rr JOIN test_cases c ON c.id=rr.case_id
     WHERE rr.run_id=$1 AND rr.result='untested' ORDER BY c.num`,
    [runId]
  );
  const ids = new Set(users.map((u) => u.id));
  const load = new Map(users.map((u) => [u.id, 0]));
  const todo = [];
  for (const r of rows) {
    if (onlyUnassigned && r.assignee_id !== null) {
      if (ids.has(r.assignee_id)) load.set(r.assignee_id, load.get(r.assignee_id) + weight(r));
    } else todo.push({ ...r, w: weight(r) });
  }
  const lightest = () => [...load.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0][0];
  const plan = new Map(); // result id → user id
  if (strategy === "round_robin") {
    todo.forEach((r, i) => plan.set(r.id, users[i % users.length].id));
    for (const r of todo) load.set(plan.get(r.id), load.get(plan.get(r.id)) + r.w);
  } else {
    // группы: по папке (by_folder) или по одному кейсу (balanced)
    const groups = new Map();
    for (const r of todo) {
      const g = strategy === "by_folder" ? `f${r.folder_id ?? "root"}` : `r${r.id}`;
      if (!groups.has(g)) groups.set(g, { w: 0, items: [] });
      const grp = groups.get(g);
      grp.w += r.w;
      grp.items.push(r);
    }
    for (const g of [...groups.values()].sort((a, b) => b.w - a.w)) {
      const uid = lightest();
      for (const r of g.items) plan.set(r.id, uid);
      load.set(uid, load.get(uid) + g.w);
    }
  }
  if (plan.size) {
    await db.query(
      "UPDATE run_results rr SET assignee_id=u.uid FROM unnest($1::int[], $2::int[]) AS u(rid, uid) WHERE rr.id=u.rid",
      [[...plan.keys()], [...plan.values()]]
    );
  }
  return {
    assigned: plan.size,
    load: Object.fromEntries(users.map((u) => [u.login, load.get(u.id)])),
  };
}

module.exports = { distribute, executors, STRATEGIES, weight };
