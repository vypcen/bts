// Безопасность входа: политика паролей, принудительная смена, история, 2FA (TOTP), сессии
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer, client, seed, SETUP_CODE } = require("./helpers");
const security = require("../server/security");

const PASS = "Tb-pass-2026";
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
// код TOTP из секрета, который сервер показал при настройке. offset — шаг вперёд (код из окна ±30 с)
const code = (secret, offset = 0) => security.totp(secret.replace(/\s/g, ""), security.stepNow() + offset);
const login = async (name, password = PASS, extra = {}) => {
  const c = client(srv.base);
  const r = await c.post("/api/auth/login", { login: name, password, ...extra });
  return { c, r };
};

test.before(async () => {
  srv = await startServer({ PASSWORD_CHANGE_ON_RESET: "true", PASSWORD_HISTORY: "2", MAX_SESSIONS: "2", SESSION_IDLE_MINUTES: "30" });
  u = await seed(srv);
  // типовые пользователи уже «сменили» пароль — принудительная смена проверяется на отдельном пользователе
  await sql("UPDATE users SET must_change_password=false");
});
test.after(async () => srv && srv.stop());

test("политика паролей: длина, виды символов, популярные, логин", async () => {
  const mk = (login, password) => u.admin.post("/api/admin/users", { login, name: "Новичок", password, role: "viewer" });
  assert.match((await mk("weak1", "Ab1")).data.error, /не короче 8/);
  assert.match((await mk("weak2", "абвгдежзик")).data.error, /не только буквы/);
  assert.match((await mk("weak3", "password123")).data.error, /распространённых/);
  assert.match((await mk("weak4", "Qwerty123!")).data.error, /распространённых/);
  assert.match((await mk("ivanov", "ivanov-2026")).data.error, /логин/);
  assert.ok((await client(srv.base).get("/api/auth/me")).data.passwordPolicy.length > 10);
});

test("пароль от администратора меняется при первом входе; повторять недавние пароли нельзя", async () => {
  assert.equal((await u.admin.post("/api/admin/users", { login: "newbie", name: "Новичок", password: "Start-pass-77", role: "tester" })).status, 201);
  const { c, r } = await login("newbie", "Start-pass-77");
  assert.equal(r.status, 200);
  assert.equal((await c.get("/api/auth/me")).data.user.pending, "password");
  const blocked = await c.get("/api/state");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, "password_change_required");
  assert.equal((await c.get("/api/help/user")).status, 200, "справка доступна");
  assert.match((await c.post("/api/auth/password", { current: "Start-pass-77", password: "Start-pass-77" })).data.error, /отличаться/);
  assert.equal((await c.post("/api/auth/password", { current: "Start-pass-77", password: "Second-pass-88" })).status, 200);
  assert.equal((await c.get("/api/auth/me")).data.user.pending, null);
  assert.equal((await c.get("/api/state")).status, 200);
  // история: PASSWORD_HISTORY=2 — нельзя вернуть предыдущий
  assert.match((await c.post("/api/auth/password", { current: "Second-pass-88", password: "Start-pass-77" })).data.error, /уже использовался/);
  assert.equal((await c.post("/api/auth/password", { current: "Second-pass-88", password: "Third-pass-99" })).status, 200);
  // сброс админом снова требует смены
  await u.admin.patch("/api/admin/users/newbie", { password: "Reset-pass-11" });
  const again = await login("newbie", "Reset-pass-11");
  assert.equal((await again.c.get("/api/auth/me")).data.user.pending, "password");
});

test("2FA: QR-код, включение кодом, вход с кодом и резервным кодом, повтор кода не проходит", async () => {
  const { c } = await login("tester");
  let r = await c.post("/api/auth/2fa/setup");
  assert.equal(r.status, 200);
  assert.match(r.data.qr, /^<svg/);
  assert.match(r.data.uri, /^otpauth:\/\/totp\/TestBall%3Atester\?secret=/);
  const secret = r.data.secret;
  assert.equal((await c.post("/api/auth/2fa/enable", { code: "000000" })).status, 400);
  r = await c.post("/api/auth/2fa/enable", { code: code(secret) });
  assert.equal(r.status, 200);
  assert.equal(r.data.recoveryCodes.length, 10);
  const recovery = r.data.recoveryCodes;
  assert.equal((await c.get("/api/auth/2fa")).data.enabled, true);
  // вход: без кода — просьба ввести код; с неверным — отказ; с кодом — вход
  let x = await login("tester");
  assert.equal(x.r.status, 401);
  assert.equal(x.r.data.twoFactor, true);
  assert.equal((await x.c.get("/api/state")).status, 401, "без кода сессии нет");
  x = await login("tester", PASS, { code: "123456" });
  assert.equal(x.r.status, 401);
  // код того же шага, что при включении, уже использован
  x = await login("tester", PASS, { code: code(secret) });
  assert.equal(x.r.status, 401, "повтор кода");
  x = await login("tester", PASS, { code: code(secret, 1) });
  assert.equal(x.r.status, 200);
  assert.equal((await x.c.get("/api/state")).status, 200);
  // резервный код — один раз
  x = await login("tester", PASS, { code: recovery[0].toUpperCase() });
  assert.equal(x.r.status, 200);
  assert.equal((await login("tester", PASS, { code: recovery[0] })).r.status, 401);
  assert.equal((await x.c.get("/api/auth/2fa")).data.recoveryLeft, 9);
  const audit = (await u.admin.get("/api/admin/audit?target=tester")).data.items.map((i) => i.action);
  for (const a of ["auth.2fa_enabled", "auth.2fa_failed", "auth.recovery_used"]) assert.ok(audit.includes(a), a);
  // отключение — пароль и код (подойдёт резервный)
  assert.equal((await x.c.post("/api/auth/2fa/disable", { password: "wrong-pass-1", code: recovery[1] })).status, 403);
  assert.equal((await x.c.post("/api/auth/2fa/disable", { password: PASS, code: recovery[1] })).status, 200);
  assert.equal((await login("tester")).r.status, 200);
});

test("администратор сбрасывает 2FA потерявшему телефон", async () => {
  const { c } = await login("dev");
  const secret = (await c.post("/api/auth/2fa/setup")).data.secret;
  await c.post("/api/auth/2fa/enable", { code: code(secret) });
  assert.equal((await login("dev")).r.data.twoFactor, true);
  assert.equal((await u.admin.get("/api/admin/users")).data.users.find((x) => x.login === "dev").twoFactor, true);
  assert.equal((await u.viewer.post("/api/admin/users/dev/2fa/reset")).status, 403);
  assert.equal((await u.admin.post("/api/admin/users/dev/2fa/reset")).status, 200);
  assert.equal((await c.get("/api/state")).status, 401, "сессии завершены");
  assert.equal((await login("dev")).r.status, 200);
});

test("сессии: список, завершение, лимит одновременных, тайм-аут неактивности", async () => {
  const a = await login("viewer");
  const b = await login("viewer");
  let list = (await b.c.get("/api/auth/sessions")).data.sessions;
  assert.ok(list.length >= 2);
  assert.equal(list.filter((s) => s.current).length, 1);
  // MAX_SESSIONS=2: третий вход закрывает самую старую сессию
  const c3 = await login("viewer");
  assert.equal((await a.c.get("/api/state")).status, 401);
  assert.equal((await b.c.get("/api/state")).status, 200);
  // завершить чужую сессию из списка
  list = (await c3.c.get("/api/auth/sessions")).data.sessions;
  const other = list.find((s) => !s.current);
  assert.equal((await c3.c.del(`/api/auth/sessions/${other.id}`)).status, 200);
  assert.equal((await b.c.get("/api/state")).status, 401);
  // тайм-аут неактивности: 30 минут без запросов
  await sql("UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE user_id=(SELECT id FROM users WHERE login='viewer')");
  assert.equal((await c3.c.get("/api/state")).status, 401);
  // админ завершает все сессии пользователя
  const d = await login("viewer");
  assert.ok((await u.admin.post("/api/admin/users/viewer/sessions/revoke")).data.count >= 1);
  assert.equal((await d.c.get("/api/state")).status, 401);
});

test("TWO_FACTOR=required: без 2FA работать нельзя, пока не настроишь", async () => {
  const s2 = await startServer({ TWO_FACTOR: "required" });
  try {
    const c = client(s2.base);
    assert.equal((await c.post("/api/auth/register", { login: "boss", name: "Босс", password: PASS, setupCode: SETUP_CODE })).status, 201);
    const r = await c.get("/api/state");
    assert.equal(r.status, 403);
    assert.equal(r.data.code, "2fa_setup_required");
    assert.equal((await c.get("/api/auth/me")).data.user.pending, "2fa");
    const secret = (await c.post("/api/auth/2fa/setup")).data.secret;
    assert.equal((await c.post("/api/auth/2fa/enable", { code: code(secret) })).status, 200);
    assert.equal((await c.get("/api/state")).status, 200);
    assert.match((await c.post("/api/auth/2fa/disable", { password: PASS, code: code(secret, 1) })).data.error, /обязательна/);
  } finally {
    await s2.stop();
  }
});
