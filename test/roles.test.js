// Роли и разрешения: встроенные наборы, пользовательские роли, лицензионные места
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, client, seed } = require("./helpers");

let srv, u;
test.before(async () => {
  srv = await startServer();
  u = await seed(srv);
});
test.after(async () => srv && srv.stop());

const login = async (name) => {
  const c = client(srv.base);
  assert.equal((await c.post("/api/auth/login", { login: name, password: "Tb-pass-2026" })).status, 200);
  return c;
};

test("разработчик меняет статус бага, но не правит и не заводит баги", async () => {
  const bug = (await u.tester.post("/api/projects/LK/bugs", { title: "Кнопка не жмётся", severity: "major" })).data.num;
  assert.equal((await u.dev.patch(`/api/projects/LK/bugs/${bug}`, { status: "in_progress" })).status, 200);
  const r = await u.dev.patch(`/api/projects/LK/bugs/${bug}`, { title: "Переименовал" });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /изменять баги/);
  assert.equal((await u.dev.post("/api/projects/LK/bugs", { title: "Новый", severity: "minor" })).status, 403);
  assert.equal((await u.viewer.patch(`/api/projects/LK/bugs/${bug}`, { status: "fixed" })).status, 403);
  const meta = (await u.dev.get("/api/state")).data;
  assert.deepEqual(meta.projects.find((p) => p.id === "LK").myPermissions.sort(), ["ai", "bugs.status", "comments"]);
});

test("пользовательская роль «Тест-менеджер»: планы и прогоны — да, кейсы — нет", async () => {
  const list = (await u.admin.get("/api/admin/roles")).data;
  assert.ok(list.permissions.length >= 15);
  assert.deepEqual(list.roles.filter((r) => r.builtin).map((r) => r.key), ["admin", "tester", "developer", "viewer"]);
  assert.equal((await u.tester.get("/api/admin/roles")).status, 403);
  assert.equal((await u.admin.post("/api/admin/roles", { name: "Тестировщик", permissions: [] })).status, 400, "имя встроенной");
  assert.equal((await u.admin.post("/api/admin/roles", { name: "Плохая", permissions: ["root"] })).status, 400);
  let r = await u.admin.post("/api/admin/roles", { name: "Тест-менеджер", description: "Планирует", permissions: ["plans.edit", "runs.manage", "requirements.edit", "comments"] });
  assert.equal(r.status, 201);
  assert.equal(r.data.seat, "full");
  const tm = r.data.key;
  assert.match(tm, /^r_[0-9a-f]{10}$/);
  assert.equal((await u.admin.post("/api/admin/roles", { name: "тест-менеджер", permissions: [] })).status, 409);
  // наблюдатель получает роль в проекте LK
  r = await u.admin.put("/api/admin/users/viewer/projects", { projects: [{ key: "LK", role: tm }] });
  assert.equal(r.status, 200);
  const v = await login("viewer");
  const meta = (await v.get("/api/state")).data;
  assert.equal(meta.projects.find((p) => p.id === "LK").myRole, tm);
  assert.equal(meta.roles[tm].name, "Тест-менеджер");
  const c = (await u.tester.post("/api/projects/LK/cases", { title: "Для менеджера", priority: "high", status: "ready" })).data.num;
  assert.equal((await v.post("/api/projects/LK/plans", { title: "Регресс", mode: "static", caseNums: [c] })).status, 201);
  const run = await v.post("/api/projects/LK/runs", { title: "Прогон менеджера", caseNums: [c] });
  assert.equal(run.status, 201);
  assert.equal((await v.post("/api/projects/LK/requirements", { title: "Требование менеджера" })).status, 201);
  r = await v.post("/api/projects/LK/cases", { title: "Нельзя", priority: "low", status: "draft" });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /создавать и изменять тест-кейсы/);
  assert.equal((await v.patch(`/api/projects/LK/runs/${run.data.num}/results/${c}`, { result: "passed" })).status, 403, "отмечать результаты — другое разрешение");
  assert.equal((await v.put("/api/projects/LK/tracker", { kind: "jira" })).status, 403, "настройки");
  // лицензия: viewer теперь занимает полное место
  const seats = (await u.admin.get("/api/admin/users")).data.seats;
  assert.equal(seats.full.used, 4);
});

test("роль из просмотровых разрешений занимает просмотровое место; лимит полных мест при изменении роли", async () => {
  let r = await u.admin.post("/api/admin/roles", { name: "Аналитик", permissions: ["comments", "ai"] });
  assert.equal(r.data.seat, "view");
  const analyst = r.data.key;
  // бесплатная редакция: 5 полных мест; заняты admin, tester, outsider и viewer (тест-менеджер в LK)
  assert.equal((await u.admin.post("/api/admin/users", { login: "full5", name: "Пятый", password: "Tb-pass-2026", role: "tester" })).status, 201);
  for (const i of [1, 2]) assert.equal((await u.admin.post("/api/admin/users", { login: `an${i}`, name: `Аналитик ${i}`, password: "Tb-pass-2026", role: analyst })).status, 201);
  // сделать «Аналитика» полной ролью — двум аналитикам не хватит мест
  r = await u.admin.patch(`/api/admin/roles/${analyst}`, { permissions: ["comments", "ai", "cases.edit"] });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /не хватит/);
  assert.equal((await u.admin.patch("/api/admin/roles/tester", { permissions: [] })).status, 404, "встроенные не меняются");
  // удаление используемой роли — только с заменой
  r = await u.admin.del(`/api/admin/roles/${analyst}`);
  assert.equal(r.status, 409);
  assert.equal(r.data.inUse, 2);
  assert.equal((await u.admin.del(`/api/admin/roles/${analyst}`, { replaceWith: "viewer" })).status, 200);
  const users = (await u.admin.get("/api/admin/users")).data.users;
  assert.equal(users.find((x) => x.login === "an1").role, "viewer");
  assert.ok((await u.admin.get("/api/admin/audit?action=role.")).data.items.length >= 3);
});
