// Встроенная справка: документация из docs/ и README, отрисованная в HTML. Работает без интернета —
// в закрытом контуре ссылки на GitHub не откроются. Документы — свои, из образа, поэтому HTML не очищается.
// Ссылки между документами переписываются на маршруты интерфейса: #/help/<страница>/<якорь>
const fs = require("fs");
const path = require("path");
const express = require("express");
const { marked } = require("marked");
const { wrap } = require("./util");

const ROOT = path.join(__dirname, "..");
const PAGES = {
  index: { file: "docs/README.md", title: "Документация" },
  user: { file: "docs/USER_GUIDE.md", title: "Руководство пользователя" },
  admin: { file: "docs/ADMIN_GUIDE.md", title: "Руководство администратора" },
  install: { file: "README.md", title: "Установка и настройка" },
  pilot: { file: "docs/PILOT.md", title: "Пилот" },
  upgrade: { file: "docs/UPGRADE.md", title: "Обновление" },
  changelog: { file: "CHANGELOG.md", title: "Изменения версий" },
  api: { file: "docs/API.md", title: "API" },
  performance: { file: "docs/PERFORMANCE.md", title: "Производительность" },
  env: { file: ".env.example", title: "Настройки (.env)", code: true },
};
const BY_FILE = Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [p.file, k]));

// Якорь как на GitHub: строчные буквы, без знаков препинания, пробелы → дефисы
const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function render(page) {
  const def = PAGES[page];
  const src = fs.readFileSync(path.join(ROOT, def.file), "utf8");
  if (def.code) return `<h1>${escapeHtml(def.title)}</h1><pre><code>${escapeHtml(src)}</code></pre>`;
  const dir = path.posix.dirname(def.file);
  const renderer = new marked.Renderer();
  const seen = new Map();
  renderer.heading = function ({ tokens, depth, text }) {
    let id = slug(text);
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n) id += `-${n}`;
    return `<h${depth} id="h-${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const inner = this.parser.parseInline(tokens);
    const t = title ? ` title="${escapeHtml(title)}"` : "";
    if (/^https?:\/\//i.test(href)) return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer"${t}>${inner}</a>`;
    const [file, anchor] = href.split("#");
    const target = file ? BY_FILE[path.posix.normalize(path.posix.join(dir, file))] : page;
    // ссылка на файл, которого нет в справке (исходник, скрипт): показываем как текст
    if (!target) return `<span class="mono">${inner}</span>`;
    return `<a href="#/help/${target}${anchor ? `/${encodeURIComponent(anchor)}` : ""}"${t}>${inner}</a>`;
  };
  return marked.parse(src, { renderer, gfm: true });
}

const cache = new Map();
function cached(page) {
  const file = path.join(ROOT, PAGES[page].file);
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(page);
  if (hit && hit.mtime === mtime) return hit.html;
  const html = render(page);
  cache.set(page, { mtime, html });
  return html;
}

const router = express.Router();
router.get("/", (_req, res) => {
  res.json({ pages: Object.entries(PAGES).map(([key, p]) => ({ key, title: p.title })) });
});

router.get("/:page", wrap(async (req, res) => {
  const def = PAGES[req.params.page];
  if (!def) return res.status(404).json({ error: "Страница справки не найдена" });
  res.json({ key: req.params.page, title: def.title, html: cached(req.params.page) });
}));

module.exports = { router, slug, render, PAGES };
