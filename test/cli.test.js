// testbolctl (F-02): запуск, загрузка JUnit в созданный запуск, завершение, сводка и код выхода, автоопределение CI
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { startServer, seed } = require("./helpers");

let srv, u, tok;
test.before(async () => {
  srv = await startServer();
  u = await seed(srv);
  tok = (await u.tester.post("/api/tokens", { name: "ci", project: "LK" })).data.token;
});
test.after(async () => srv && srv.stop());

const cli = (args, extra = {}) => spawnSync(process.execPath, [path.join(__dirname, "..", "cli", "bin", "testbolctl.js"), ...args], {
  env: { PATH: process.env.PATH, TESTBALL_URL: srv.base, TESTBALL_TOKEN: tok, TESTBALL_PROJECT: "LK", ...extra }, encoding: "utf8",
});

test("testbolctl: check, run start → upload → finish → status --fail-on", () => {
  let r = cli(["check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /токен принят/);
  assert.equal(cli(["check"], { TESTBALL_TOKEN: "tb_" + "x".repeat(32) }).status, 1);

  // GitLab CI: ветка, коммит и номер пайплайна — сами
  r = cli(["run", "start"], { CI: "true", CI_COMMIT_REF_NAME: "feature/cart", CI_COMMIT_SHORT_SHA: "abc1234", CI_PIPELINE_ID: "777" });
  assert.equal(r.status, 0, r.stderr);
  const run = r.stdout.trim();
  assert.match(run, /^\d+$/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junit-"));
  fs.writeFileSync(path.join(dir, "junit.xml"), `<?xml version="1.0"?><testsuites><testsuite name="cart">
    <testcase name="add item" time="0.5"/><testcase name="remove item" time="0.2"><failure message="boom">trace</failure></testcase></testsuite></testsuites>`);
  r = cli(["upload", path.join(dir, "junit.xml")], { TESTBALL_RUN: run });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = cli(["run", "finish"], { TESTBALL_RUN: run });
  assert.equal(r.status, 0, r.stderr);

  r = cli(["run", "status", "--json"], { TESTBALL_RUN: run });
  const s = JSON.parse(r.stdout);
  assert.equal(s.title, "GitLab #777 · feature/cart");
  assert.equal(s.branch, "feature/cart");
  assert.equal(s.build, "abc1234");
  assert.equal(s.state, "finished");
  assert.deepEqual([s.counts.total, s.counts.passed, s.counts.failed], [2, 1, 1]);
  assert.equal(r.status, 0, "без --fail-on код 0");
  assert.equal(cli(["run", "status", "--fail-on", "failed"], { TESTBALL_RUN: run }).status, 1);
  assert.equal(cli(["run", "status", "--fail-on", "nope"], { TESTBALL_RUN: run }).status, 1);
  assert.equal(cli(["run", "status"], {}).status, 1, "без номера запуска — ошибка");
});

test("testbolctl: карантинный тест не роняет сборку при --fail-on failed", async () => {
  let r = cli(["run", "start", "--title", "Карантин"]);
  const run = r.stdout.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junit-"));
  fs.writeFileSync(path.join(dir, "j.xml"), `<testsuite name="q"><testcase name="flaky one"><failure message="x"/></testcase></testsuite>`);
  cli(["upload", path.join(dir, "j.xml")], { TESTBALL_RUN: run });
  const t = (await u.tester.get("/api/projects/LK/autotests")).data.tests.find((x) => x.name === "flaky one");
  await u.tester.patch(`/api/projects/LK/autotests/${t.id}`, { quarantined: true });
  assert.equal(cli(["run", "status", "--fail-on", "failed"], { TESTBALL_RUN: run }).status, 0);
  assert.equal(cli(["run", "status", "--fail-on", "any"], { TESTBALL_RUN: run }).status, 1);
});
