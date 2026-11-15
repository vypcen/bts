#!/usr/bin/env node
// Резервные копии из командной строки — те же, что «Пользователи → Резервные копии».
//   node scripts/backup.js create            — сделать копию (CronJob в Kubernetes, cron на сервере)
//   node scripts/backup.js verify <файл.tar>  — проверить копию: контрольные суммы, дамп, архив вложений
//   node scripts/backup.js restore <файл.tar> --yes — восстановить базу (и вложения при STORAGE=local)
//                                              в DATABASE_URL. Приложение на время восстановления остановите.
// Нужны DATABASE_URL и те же переменные хранилища (STORAGE, S3_*, UPLOAD_DIR), что у приложения.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HELP = `Использование:
  node scripts/backup.js create
  node scripts/backup.js verify <файл.tar>
  node scripts/backup.js restore <файл.tar> --yes`;

function unpack(file) {
  if (!fs.existsSync(file)) throw new Error(`Файл не найден: ${file}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-restore-"));
  execFileSync("tar", ["-xf", file, "-C", dir]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  return { dir, manifest };
}

async function main(argv) {
  const [cmd, file] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") return console.log(HELP);
  if (!process.env.DATABASE_URL) throw new Error("Задайте DATABASE_URL");
  if (cmd === "create") {
    const backup = require("../server/backup");
    const r = await backup.create({ trigger: process.env.BACKUP_TRIGGER === "manual" ? "manual" : "cron" });
    console.log(`Готово: ${r.name}, ${(r.size / 1024 / 1024).toFixed(1)} МБ, проверка: ${r.verify.ok ? "пройдена" : "есть замечания"}`);
    for (const c of r.verify.checks) console.log(`  ${c.ok === false ? "✗" : c.ok ? "✓" : "–"} ${c.what}: ${c.note || ""}`);
    if (!r.verify.ok) process.exitCode = 2;
    return;
  }
  if (!file) throw new Error(HELP);
  const { dir, manifest } = unpack(file);
  try {
    if (cmd === "verify") {
      const { verifyDir } = require("../server/backup");
      const v = await verifyDir(dir, manifest);
      console.log(`Копия ${path.basename(file)}: версия ${manifest.version}, миграция ${manifest.migration}, создана ${manifest.createdAt}`);
      for (const c of v.checks) console.log(`  ${c.ok === false ? "✗" : c.ok ? "✓" : "–"} ${c.what}: ${c.note || ""}`);
      if (!v.ok) process.exitCode = 2;
      return;
    }
    if (cmd === "restore") {
      if (!argv.includes("--yes")) throw new Error("Восстановление перезапишет данные в DATABASE_URL. Остановите приложение и повторите с --yes");
      const bin = process.env.BACKUP_PG_BIN ? path.join(process.env.BACKUP_PG_BIN, "pg_restore") : "pg_restore";
      console.log(`Восстанавливаю базу из копии ${manifest.createdAt} (версия ${manifest.version})…`);
      execFileSync(bin, ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--exit-on-error", "-d", process.env.DATABASE_URL, path.join(dir, "db.dump")], { stdio: "inherit" });
      const uploads = path.join(dir, "uploads.tar.gz");
      if (fs.existsSync(uploads)) {
        if (process.env.STORAGE === "s3") console.log("Вложения в копии с локального диска, а сейчас STORAGE=s3 — перенесите их вручную: tar -xzf uploads.tar.gz");
        else {
          const target = process.env.UPLOAD_DIR || path.join(__dirname, "..", "data", "uploads");
          fs.mkdirSync(target, { recursive: true });
          execFileSync("tar", ["-xzf", uploads, "-C", target]);
          console.log(`Вложения распакованы в ${target}`);
        }
      } else if (manifest.storage === "s3") console.log("Вложения хранятся в S3 и в копию не входят — проверьте, что бакет на месте.");
      console.log("Готово. Запустите приложение: недостающие миграции оно применит само.");
      return;
    }
    throw new Error(HELP);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => require("../server/db").pool.end().catch(() => {}));
}
module.exports = { main };
