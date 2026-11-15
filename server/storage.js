// Где лежат файлы вложений. STORAGE=local (по умолчанию) — каталог UPLOAD_DIR;
// STORAGE=s3 — S3-совместимое хранилище (MinIO, Ceph, Yandex Object Storage, AWS S3): нужно для нескольких реплик в Kubernetes.
// Клиент S3 — минимальный, без зависимостей: подпись AWS Signature V4, тело без хэша (UNSIGNED-PAYLOAD).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");

const KIND = process.env.STORAGE === "s3" ? "s3" : "local";

// ---------- локальный диск ----------
const DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "data", "uploads");

const local = {
  // временный файл пишется рядом с итоговым: rename в пределах одного диска атомарен
  tmpDir: DIR,
  async put(id, file) {
    await fs.promises.rename(file, path.join(DIR, id));
  },
  get(id) {
    return fs.createReadStream(path.join(DIR, id));
  },
  async remove(id) {
    await fs.promises.unlink(path.join(DIR, id)).catch(() => {});
  },
  // [{name, mtimeMs}] — для очистки файлов без записи в базе
  async list() {
    const names = await fs.promises.readdir(DIR);
    const out = [];
    for (const name of names) {
      const st = await fs.promises.stat(path.join(DIR, name)).catch(() => null);
      if (st) out.push({ name, mtimeMs: st.mtimeMs });
    }
    return out;
  },
  async check() {
    await fs.promises.access(DIR, fs.constants.W_OK);
  },
};

// ---------- S3 ----------
const S3 = {
  endpoint: (process.env.S3_ENDPOINT || "https://s3.amazonaws.com").replace(/\/+$/, ""),
  bucket: process.env.S3_BUCKET || "",
  region: process.env.S3_REGION || "us-east-1",
  accessKey: process.env.S3_ACCESS_KEY || "",
  secretKey: process.env.S3_SECRET_KEY || "",
  prefix: (process.env.S3_PREFIX || "attachments/").replace(/^\/+/, ""),
  // MinIO и большинство локальных хранилищ — path-style: http://minio:9000/bucket/key
  pathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
};

const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// RFC 3986: S3 требует кодировать всё, кроме A-Z a-z 0-9 - _ . ~
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function s3url(key, query = {}) {
  const u = new URL(S3.endpoint);
  const objectPath = key === null ? "" : "/" + key.split("/").map(enc).join("/");
  if (S3.pathStyle) u.pathname = `/${S3.bucket}${objectPath}`;
  else {
    u.hostname = `${S3.bucket}.${u.hostname}`;
    u.pathname = objectPath || "/";
  }
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join("&");
  return { url: u, qs };
}

function sign(method, key, query = {}, extra = {}) {
  const { url, qs } = s3url(key, query);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = now.slice(0, 8);
  const headers = { host: url.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": now, ...extra };
  // все имена заголовков — в нижнем регистре, как требует каноническая форма запроса
  const names = Object.keys(headers).sort();
  const canonical = [
    method, url.pathname, qs,
    names.map((h) => `${h}:${String(headers[h]).trim()}\n`).join(""),
    names.join(";"), "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${date}/${S3.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", now, scope, sha(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + S3.secretKey, date), S3.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${S3.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete headers.host;
  return { href: url.origin + url.pathname + (qs ? "?" + qs : ""), headers };
}

async function s3fail(res, what) {
  const text = await res.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || res.status;
  return new Error(`S3 ${what}: ${code}`);
}

// Объекты под заданным префиксом: вложения (S3_PREFIX), резервные копии (S3_BACKUP_PREFIX)
function s3store(prefix) {
  return {
    tmpDir: os.tmpdir(),
    async put(id, file) {
      try {
        const size = (await fs.promises.stat(file)).size;
        const { href, headers } = sign("PUT", prefix + id, {}, { "content-length": String(size) });
        const res = await fetch(href, { method: "PUT", headers, body: Readable.toWeb(fs.createReadStream(file)), duplex: "half" });
        if (!res.ok) throw await s3fail(res, "загрузка");
      } finally {
        await fs.promises.unlink(file).catch(() => {});
      }
    },
    // Поток, который отдаёт файл по мере скачивания из хранилища
    get(id) {
      const out = new (require("stream").PassThrough)();
      const { href, headers } = sign("GET", prefix + id);
      fetch(href, { headers }).then(
        async (res) => {
          if (!res.ok) return out.destroy(await s3fail(res, "чтение"));
          Readable.fromWeb(res.body).on("error", (e) => out.destroy(e)).pipe(out);
        },
        (e) => out.destroy(e)
      );
      return out;
    },
    async remove(id) {
      const { href, headers } = sign("DELETE", prefix + id);
      const res = await fetch(href, { method: "DELETE", headers }).catch(() => null);
      if (res && !res.ok && res.status !== 404) console.error("[storage] не удалось удалить", id, res.status);
    },
    async list() {
      const out = [];
      let token = null;
      do {
        const q = { "list-type": "2", prefix: prefix, "max-keys": "1000" };
        if (token) q["continuation-token"] = token;
        const { href, headers } = sign("GET", null, q);
        const res = await fetch(href, { headers });
        if (!res.ok) throw await s3fail(res, "список");
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1] || "";
          const at = /<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1];
          out.push({ name: key.slice(prefix.length), mtimeMs: at ? Date.parse(at) : Date.now() });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] : null;
      } while (token);
      return out;
    },
    async check() {
      const { href, headers } = sign("GET", null, { "list-type": "2", "max-keys": "1", prefix: prefix });
      const res = await fetch(href, { headers });
      if (!res.ok) throw await s3fail(res, "проверка доступа");
    },
  };
}
const s3 = s3store(S3.prefix);

if (KIND === "s3" && (!S3.bucket || !S3.accessKey || !S3.secretKey)) {
  throw new Error("STORAGE=s3: задайте S3_BUCKET, S3_ACCESS_KEY и S3_SECRET_KEY");
}
if (KIND === "local") fs.mkdirSync(DIR, { recursive: true });

module.exports = { kind: KIND, DIR, s3store: KIND === "s3" ? s3store : null, ...(KIND === "s3" ? s3 : local) };
