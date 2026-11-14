// Свежая база и сервер на время E2E. Адрес и данные для входа — в переменных окружения тестов
const fs = require("node:fs");
const path = require("node:path");
const { startServer, seed } = require("../test/helpers");

module.exports = async () => {
  if (!fs.existsSync(path.join(__dirname, "..", "public", "index.html"))) throw new Error("Сначала соберите интерфейс: npm run build:web");
  const srv = await startServer();
  await seed(srv);
  process.env.E2E_BASE_URL = srv.base;
  globalThis.__E2E_SERVER__ = srv;
};
