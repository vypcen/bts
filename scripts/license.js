#!/usr/bin/env node
// Лицензионные ключи TestBall — инструмент производителя.
//
//   node scripts/license.js keygen private.pem
//       новая пара ключей: закрытый — в файл (хранить в секрете, НЕ в репозитории), открытый — на экран,
//       его нужно вставить в PUBLIC_KEY в server/license.js. Старые ключи после замены перестанут приниматься.
//
//   node scripts/license.js issue --private private.pem --customer "ООО Ромашка" --full 50 --view 200 \
//       --expires 2027-12-31 [--updates-until 2027-12-31] [--host testball.romashka.ru] [--edition enterprise] [--id R-2026-001]
//       выпустить ключ. --full/--view: число мест, «0» или пропуск у --view — без ограничений.
//       --expires: последний день действия, без него — бессрочная лицензия.
//
//   node scripts/license.js inspect TB1.…
//       показать условия ключа и проверить подпись (на этой машине, с ключом из server/license.js)
const fs = require("fs");
const crypto = require("crypto");
const license = require("../server/license");

function args(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith("--")) out[list[i].slice(2)] = list[i + 1] && !list[i + 1].startsWith("--") ? list[++i] : true;
    else (out._ ||= []).push(list[i]);
  }
  return out;
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const seats = (v, name) => {
  if (v === undefined || v === "0") return null;
  if (!/^\d+$/.test(String(v))) fail(`--${name}: целое число мест`);
  return Number(v);
};

const [cmd, ...rest] = process.argv.slice(2);
const a = args(rest);

if (cmd === "keygen") {
  const file = a._?.[0] || fail("Укажите файл для закрытого ключа: node scripts/license.js keygen private.pem");
  if (fs.existsSync(file)) fail(`${file} уже существует — не перезаписываю`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(`Закрытый ключ: ${file}. Храните в секрете.\nОткрытый ключ для server/license.js (PUBLIC_KEY):\n`);
  console.log(publicKey.export({ type: "spki", format: "pem" }));
} else if (cmd === "issue") {
  if (!a.private) fail("--private: файл закрытого ключа");
  if (!a.customer) fail("--customer: название заказчика");
  if (a.expires && !isDate(a.expires)) fail("--expires: дата ГГГГ-ММ-ДД");
  if (a["updates-until"] && !isDate(a["updates-until"])) fail("--updates-until: дата ГГГГ-ММ-ДД");
  const full = seats(a.full, "full");
  if (full === null) fail("--full: число полных мест обязательно");
  const today = new Date().toISOString().slice(0, 10);
  const terms = {
    id: a.id || `TB-${today.replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    customer: String(a.customer),
    edition: a.edition || "enterprise",
    full,
    view: seats(a.view, "view"),
    issued: today,
    expires: a.expires || null,
    updatesUntil: a["updates-until"] || a.expires || null,
    ...(a.host ? { host: String(a.host).toLowerCase() } : {}),
  };
  const key = license.sign(terms, fs.readFileSync(a.private, "utf8"));
  console.error(JSON.stringify(terms, null, 2));
  console.log(key);
} else if (cmd === "inspect") {
  const key = a._?.[0] || fail("Укажите ключ: node scripts/license.js inspect TB1.…");
  try {
    const v = license.verify(key);
    console.log(JSON.stringify({ ...v.terms, signature: v.test ? "тестовый ключ" : "верна" }, null, 2));
  } catch (e) {
    fail(e.message);
  }
} else {
  console.log(fs.readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(cmd ? 1 : 0);
}
