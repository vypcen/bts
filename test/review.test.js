// Ревью и согласование тест-кейсов: отправка, утверждение всеми рецензентами, возврат на доработку, режим «готов только после ревью»
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, seed, client } = require("./helpers");

let srv, u, rev;
test.before(async () => {
  srv = await startServer();
  u = await seed(srv);
  for (const login of ["anna", "boris"]) {
    assert.equal((await u.admin.post("/api/admin/users", { login, name: login, password: "Tb-pass-2026", role: "tester" })).status, 201);
    await u.admin.put(`/api/admin/users/${login}/projects`, { projects: ["LK"] });
  }
  rev = {};
  for (const login of ["anna", "boris"]) {
    rev[login] = client(srv.base);
    assert.equal((await rev[login].post("/api/auth/login", { login, password: "Tb-pass-2026" })).status, 200);
  }
});
test.after(async () => srv && srv.stop());

const newCase = async (title) => {
  const r = await u.tester.post("/api/projects/LK/cases", { title, priority: "critical", status: "draft", steps: "Открыть\nНажать" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.num;
};
const caseOf = async (n) => (await u.tester.get(`/api/projects/LK/cases/${n}`)).data;

test("ревью: два рецензента, утверждают оба — кейс готов; своё ревью утвердить нельзя", async () => {
  const n = await newCase("Вход по паролю");
  // «На ревью» обычной правкой не ставится
  assert.equal((await u.tester.patch(`/api/projects/LK/cases/${n}`, { status: "review" })).status, 409);
  assert.equal((await u.tester.post(`/api/projects/LK/cases/${n}/review`, { reviewers: ["tester"] })).status, 400, "себя нельзя");
  assert.equal((await u.tester.post(`/api/projects/LK/cases/${n}/review`, { reviewers: ["dev"] })).status, 400, "у разработчика нет права ревью");
  assert.equal((await u.tester.post(`/api/projects/LK/cases/${n}/review`, { reviewers: ["outsider"] })).status, 400, "не участник");
  assert.equal((await u.viewer.post(`/api/projects/LK/cases/${n}/review`, {})).status, 403);
  let r = await u.tester.post(`/api/projects/LK/cases/${n}/review`, { reviewers: ["anna", "boris"], comment: "Проверьте шаги" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  let c = await caseOf(n);
  assert.equal(c.status, "review");
  assert.deepEqual(c.review.map((x) => x.reviewer).sort(), ["anna", "boris"]);

  // список «мне на ревью»
  assert.deepEqual((await rev.anna.get("/api/projects/LK/reviews")).data.items.map((i) => i.num), [n]);
  assert.deepEqual((await u.tester.get("/api/projects/LK/reviews")).data.items, []);

  assert.equal((await u.tester.post(`/api/projects/LK/cases/${n}/review/decision`, { decision: "approve" })).status, 409, "автор не утверждает");
  assert.equal((await u.dev.post(`/api/projects/LK/cases/${n}/review/decision`, { decision: "approve" })).status, 403);
  r = await rev.anna.post(`/api/projects/LK/cases/${n}/review/decision`, { decision: "approve", comment: "ок" });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "review");
  assert.equal(r.data.left, 1);
  assert.equal((await rev.anna.post(`/api/projects/LK/cases/${n}/review/decision`, { decision: "approve" })).status, 403, "повторно — уже решено");
  r = await rev.boris.post(`/api/projects/LK/cases/${n}/review/decision`, { decision: "approve" });
  assert.equal(r.data.status, "ready");
  assert.equal((await caseOf(n)).status, "ready");

  const hist = (await u.tester.get(`/api/projects/LK/cases/${n}/reviews`)).data.reviews;
  assert.equal(hist.length, 2);
  assert.ok(hist.every((h) => h.status === "approved" && h.requestedBy === "tester" && h.requestComment === "Проверьте шаги"));
});

test("ревью: возврат на доработку с комментарием, заявка «любому», смена статуса отменяет заявки", async () => {
  const n = await newCase("Восстановление пароля");
  assert.equal((await u.tester.post(`/api/projects/LK/cases/${n}/review`, {})).status, 201);
  assert.deepEqual((await rev.boris.get("/api/projects/LK/reviews")).data.items.map((i) => i.num), [n]);
  assert.equal((await rev.boris.post(`/api/projects/LK/cases/${n}/review/decision`, { decision: "changes" })).status, 400, "без комментария нельзя");
  let r = await rev.boris.post(`/api/projects/LK/cases/${n}/review/decision`, { decision: "changes", comment: "Нет шага про почту" });
  assert.equal(r.data.status, "draft");
  assert.equal((await caseOf(n)).status, "draft");
  assert.equal((await u.tester.get(`/api/projects/LK/cases/${n}/reviews`)).data.reviews[0].comment, "Нет шага про почту");

  // отправили снова и перевели в «Устарел» правкой — заявки отменились
  await u.tester.post(`/api/projects/LK/cases/${n}/review`, { reviewers: ["anna"] });
  assert.equal((await u.tester.patch(`/api/projects/LK/cases/${n}`, { status: "deprecated" })).status, 200);
  assert.deepEqual((await rev.anna.get("/api/projects/LK/reviews")).data.items, []);
  assert.equal((await u.tester.post(`/api/projects/LK/cases/${n}/review`, {})).status, 409, "устаревший не отправляется");
});

test("режим «готов только после ревью»: без права ревью «Готов» не ставится, правка готового — снова черновик", async () => {
  // роль «Автор»: правит кейсы, но не проводит ревью
  let r = await u.admin.post("/api/admin/roles", { name: "Автор кейсов", permissions: ["cases.edit", "comments"] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const role = r.data.key;
  // бесплатная лицензия — 5 полных мест: освобождаем место постороннего
  await u.admin.patch("/api/admin/users/outsider", { blocked: true });
  assert.equal((await u.admin.post("/api/admin/users", { login: "author", name: "Автор", password: "Tb-pass-2026", role: "viewer" })).status, 201);
  r = await u.admin.put("/api/admin/users/author/projects", { projects: [{ key: "LK", role }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const author = client(srv.base);
  assert.equal((await author.post("/api/auth/login", { login: "author", password: "Tb-pass-2026" })).status, 200);

  assert.equal((await author.put("/api/projects/LK/review-settings", { required: true })).status, 403);
  assert.equal((await u.tester.put("/api/projects/LK/review-settings", { required: true })).status, 200);
  const state = (await u.tester.get("/api/state")).data;
  assert.equal(state.projects.find((p) => p.id === "LK").reviewRequired, true);

  r = await author.post("/api/projects/LK/cases", { title: "Сразу готовый", priority: "low", status: "ready", steps: "a" });
  assert.equal(r.status, 409);
  r = await author.post("/api/projects/LK/cases", { title: "Черновик автора", priority: "low", status: "draft", steps: "a" });
  assert.equal(r.status, 201);
  const n = r.data.num;
  assert.equal((await author.patch(`/api/projects/LK/cases/${n}`, { status: "ready" })).status, 409);
  assert.equal((await author.post("/api/projects/LK/cases/bulk", { nums: [n], status: "ready" })).status, 409);
  assert.equal((await author.post(`/api/projects/LK/cases/${n}/review`, { reviewers: ["anna"] })).status, 201);
  assert.equal((await author.post(`/api/projects/LK/cases/${n}/review/decision`, { decision: "approve" })).status, 403, "у автора нет права ревью");
  assert.equal((await rev.anna.post(`/api/projects/LK/cases/${n}/review/decision`, { decision: "approve" })).data.status, "ready");

  // правка содержимого готового кейса без права ревью — снова черновик; смена тегов — нет
  r = await author.patch(`/api/projects/LK/cases/${n}`, { tags: ["smoke"] });
  assert.equal(r.status, 200);
  assert.equal((await caseOf(n)).status, "ready");
  r = await author.patch(`/api/projects/LK/cases/${n}`, { title: "Черновик автора (исправлен)" });
  assert.equal(r.data.statusReset, "draft");
  assert.equal((await caseOf(n)).status, "draft");
  // рецензент может ставить «Готов» напрямую
  assert.equal((await rev.anna.patch(`/api/projects/LK/cases/${n}`, { status: "ready" })).status, 200);
  await u.tester.put("/api/projects/LK/review-settings", { required: false });
});
