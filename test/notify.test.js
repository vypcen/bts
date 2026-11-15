// Уведомления (I-01, I-02, I-03): назначение, статус, комментарии подписчикам, @упоминания, ревью, прогон, письма
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { startServer, seed } = require("./helpers");

// маленький SMTP-сервер: принимает письма и складывает их в mails
const mails = [];
function smtpServer() {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => {
      let data = false, buf = "", msg = "";
      sock.write("220 test ESMTP\r\n");
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (data) {
            if (line === ".") { data = false; mails.push(msg); msg = ""; sock.write("250 OK\r\n"); } else msg += line + "\n";
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") sock.write("250 test\r\n");
          else if (cmd === "DATA") { data = true; sock.write("354 go\r\n"); } else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); } else sock.write("250 OK\r\n");
        }
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

let srv, u, smtp;
test.before(async () => {
  smtp = await smtpServer();
  srv = await startServer({ SMTP_URL: `smtp://127.0.0.1:${smtp.address().port}`, SMTP_FROM: "TestBall <tb@test.local>", PUBLIC_URL: "http://tb.local" });
  u = await seed(srv);
});
test.after(async () => { srv && (await srv.stop()); smtp && smtp.close(); });
const P = "/api/projects/LK";
const list = async (c) => (await c.get("/api/notifications")).data;
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 200)); } };

test("уведомления: баг назначен, статус, комментарии подписчикам, упоминание, отписка", async () => {
  const before = (await list(u.dev)).unread;
  const n = (await u.tester.post(P + "/bugs", { title: "Корзина пустеет", severity: "major", assignee: "dev" })).data.num;
  let d = await list(u.dev);
  assert.equal(d.unread, before + 1);
  assert.match(d.items[0].title, /Вам назначен баг LK-B\d+: Корзина пустеет/);
  assert.equal(d.items[0].link, `p/LK/bugs/${n}`);
  assert.equal(d.items[0].actor, "tester");
  // сам себе — не уведомляется
  assert.ok(!(await list(u.tester)).items.some((x) => x.title.includes("Корзина пустеет")));

  // разработчик меняет статус → автор (подписан) получает уведомление
  await u.dev.patch(`${P}/bugs/${n}`, { status: "in_progress" });
  d = await list(u.tester);
  assert.match(d.items[0].title, new RegExp(`LK-B${n}: Новый → В работе`));

  // комментарий с упоминанием наблюдателя (участник проекта) и разработчика
  await u.tester.post(`${P}/bugs/${n}/comments`, { text: "@viewer глянь, и @dev тоже. @nobody нет такого" });
  const v = await list(u.viewer);
  assert.equal(v.items[0].kind, "mention");
  assert.match(v.items[0].title, /упомянул\(а\) вас в LK-B/);
  assert.equal((await list(u.dev)).items[0].kind, "mention", "упоминание важнее обычного комментария — одно уведомление");

  // отписка: разработчик больше не получает комментарии к багу
  assert.equal((await u.dev.post(P + "/watch", { kind: "bugs", num: n, watching: false })).status, 200);
  assert.equal((await u.dev.get(`${P}/watch?kind=bugs&num=${n}`)).data.watching, false);
  const cnt = (await list(u.dev)).items.length;
  await u.tester.post(`${P}/bugs/${n}/comments`, { text: "ещё деталь" });
  assert.equal((await list(u.dev)).items.length, cnt);

  // прочитано
  d = await list(u.viewer);
  await u.viewer.post("/api/notifications/read", { ids: [d.items[0].id] });
  assert.equal((await list(u.viewer)).unread, d.unread - 1);
  await u.dev.post("/api/notifications/read", { all: true });
  assert.equal((await list(u.dev)).unread, 0);
});

test("уведомления: ревью, распределение прогона, настройки и письмо", async () => {
  // настройки: почта и выключенные виды
  assert.equal((await u.dev.put("/api/notifications/settings", { email: "не почта" })).status, 400);
  assert.equal((await u.dev.put("/api/notifications/settings", { email: "dev@test.local", emailOn: true, off: ["comment"] })).status, 200);
  const s = (await u.dev.get("/api/notifications/settings")).data;
  assert.deepEqual([s.email, s.emailOn, s.off, s.smtp], ["dev@test.local", true, ["comment"], true]);

  const c = (await u.tester.post(P + "/cases", { title: "Вход по SMS", priority: "high", status: "draft", steps: "a" })).data.num;
  await u.admin.put("/api/admin/users/dev/projects", { projects: [{ key: "LK", role: "tester" }] });
  await u.tester.post(`${P}/cases/${c}/review`, { reviewers: ["dev"] });
  let d = await list(u.dev);
  assert.match(d.items[0].title, new RegExp(`Кейс LK-${c} на ревью`));
  await u.dev.post(`${P}/cases/${c}/review/decision`, { decision: "changes", comment: "Нет шага с кодом" });
  assert.match((await list(u.tester)).items[0].title, /возвращён на доработку/);

  // распределение прогона
  await u.tester.post(P + "/runs", { title: "Смоук", caseNums: [c], assign: { users: ["dev"], strategy: "balanced" } });
  d = await list(u.dev);
  assert.match(d.items[0].title, /Вам назначены кейсы в прогоне LK-R\d+: 1/);

  // письмо ушло (через очередь)
  // текст письма с кириллицей кодируется (quoted-printable или base64) — раскодируем перед проверкой
  const decode = (m) => {
    const body = m.split(/\n\n/).slice(1).join("\n\n");
    if (/Content-Transfer-Encoding: base64/i.test(m)) return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    return body.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  };
  const got = await until(() => mails.find((m) => /dev@test\.local/.test(m) && /http:\/\/tb\.local\/#\/p\/LK\/runs\//.test(decode(m))));
  assert.ok(got, `писем: ${mails.length}\n${mails.map(decode).join("\n---\n")}`);

  // выключенный вид «комментарии» не приходит
  const b = (await u.tester.post(P + "/bugs", { title: "Ещё баг", severity: "minor", assignee: "dev" })).data.num;
  const cnt = (await list(u.dev)).items.length;
  await u.tester.post(`${P}/bugs/${b}/comments`, { text: "просто комментарий" });
  assert.equal((await list(u.dev)).items.length, cnt);
});
