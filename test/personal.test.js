// Персональные данные (152-ФЗ): согласие, выгрузка, обезличивание, срок хранения IP
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer, client, seed } = require("./helpers");

let srv, u;
const sql = async (q, p) => {
  const c = new Client({ connectionString: srv.dbUrl });
  await c.connect();
  try {
    return (await c.query(q, p)).rows;
  } finally {
    await c.end();
  }
};
test.before(async () => {
  srv = await startServer({ PRIVACY_POLICY_URL: "https://company.ru/privacy", JOB_POLL_MS: "100", AUDIT_IP_DAYS: "30" });
  u = await seed(srv);
});
test.after(async () => srv && srv.stop());

test("регистрация требует согласия на обработку ПДн и запоминает его", async () => {
  const c = client(srv.base);
  assert.equal((await c.get("/api/auth/me")).data.privacyPolicyUrl, "https://company.ru/privacy");
  let r = await c.post("/api/auth/register", { login: "selfreg", name: "Сам Записался", password: "Tb-pass-2026" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /согласие/);
  r = await c.post("/api/auth/register", { login: "selfreg", name: "Сам Записался", password: "Tb-pass-2026", consent: true });
  assert.equal(r.status, 201);
  const exp = (await u.admin.get("/api/admin/users/selfreg/personal-data")).data;
  assert.ok(exp.profile.consent);
});

test("выгрузка ПДн пользователя: профиль, сессии, журнал, комментарии", async () => {
  const bug = (await u.tester.post("/api/projects/LK/bugs", { title: "Баг тестировщика", severity: "minor" })).data.num;
  await u.tester.post(`/api/projects/LK/bugs/${bug}/comments`, { text: "Воспроизводится у меня, Иван" });
  assert.equal((await u.tester.get("/api/admin/users/tester/personal-data")).status, 403);
  const r = await u.admin.get("/api/admin/users/tester/personal-data");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /personal-data-tester\.json/);
  assert.equal(r.data.profile.login, "tester");
  assert.ok(r.data.sessions.length >= 1 && r.data.sessions[0].ip);
  assert.ok(r.data.auditLog.some((a) => a.action === "auth.login"));
  assert.equal(r.data.comments[0].text, "Воспроизводится у меня, Иван");
  assert.equal(r.data.comments[0].on, `LK-B${bug}`);
  assert.equal(r.data.projects[0].project, "LK");
  assert.ok(r.data.authorship.bugs >= 1);
  assert.ok((await u.admin.get("/api/admin/audit?action=user.personal_data")).data.items.length >= 1);
});

test("обезличивание: логин, имя и IP удаляются, история остаётся, войти нельзя", async () => {
  const bug = (await u.dev.get("/api/state")) && (await u.tester.post("/api/projects/LK/bugs", { title: "Останется в истории", severity: "minor" })).data.num;
  assert.equal((await u.admin.post("/api/admin/users/tester/anonymize", {})).status, 400, "нужно подтверждение");
  assert.equal((await u.admin.post("/api/admin/users/admin/anonymize", { confirm: "admin" })).status, 409, "себя нельзя");
  const r = await u.admin.post("/api/admin/users/tester/anonymize", { confirm: "tester" });
  assert.equal(r.status, 200);
  const alias = r.data.login;
  assert.match(alias, /^deleted-\d+$/);
  assert.equal((await u.tester.get("/api/state")).status, 401, "сессии закрыты");
  // история: баг на месте, автор — обезличенный пользователь
  const st = (await u.admin.get("/api/projects/LK/state")).data;
  assert.equal(st.bugs.find((b) => b.num === bug).createdBy, alias);
  const users = (await u.admin.get("/api/admin/users")).data.users;
  const x = users.find((v) => v.login === alias);
  assert.equal(x.name, "Удалённый пользователь");
  assert.equal(x.blocked, true);
  assert.equal(x.email, "");
  const rows = await sql("SELECT actor_login, ip FROM audit_log WHERE actor_id=(SELECT id FROM users WHERE login=$1)", [alias]);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((a) => a.actor_login === alias && a.ip === ""));
  assert.deepEqual(await sql("SELECT action, target, actor_login FROM audit_log WHERE target='tester' OR actor_login='tester'"), []);
  assert.equal((await u.admin.post(`/api/admin/users/${alias}/anonymize`, { confirm: alias })).status, 409);
  // войти под прежним логином нельзя (сама попытка, как и положено, попадёт в журнал)
  assert.equal((await client(srv.base).post("/api/auth/login", { login: "tester", password: "Tb-pass-2026" })).status, 401);
});

test("IP-адреса в журнале аудита старше AUDIT_IP_DAYS обезличиваются уборкой", async () => {
  await sql("UPDATE audit_log SET at = now() - interval '40 days' WHERE id = (SELECT min(id) FROM audit_log WHERE ip <> '')");
  const [old] = await sql("SELECT id FROM audit_log WHERE at < now() - interval '30 days' AND ip <> '' LIMIT 1");
  assert.ok(old);
  await sql("INSERT INTO jobs(kind) VALUES ('housekeeping')");
  const end = Date.now() + 10000;
  for (;;) {
    const [r] = await sql("SELECT ip FROM audit_log WHERE id=$1", [old.id]);
    if (r.ip === "") break;
    if (Date.now() > end) throw new Error("IP не обезличен");
    await new Promise((ok) => setTimeout(ok, 100));
  }
  const fresh = await sql("SELECT count(*)::int AS n FROM audit_log WHERE ip <> '' AND at > now() - interval '1 day'");
  assert.ok(fresh[0].n > 0, "свежие IP остаются");
});
