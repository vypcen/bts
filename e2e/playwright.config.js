// E2E-тесты интерфейса. Запуск: npm run e2e (собирает интерфейс, поднимает сервер на свежей базе).
// Нужен PostgreSQL (TEST_DATABASE_URL) и браузер: npx playwright install chromium или E2E_CHROME=/путь/к/chrome.
// С TESTBALL_URL/TESTBALL_TOKEN/TESTBALL_PROJECT результаты уходят в сам TestBall — свой же репортер.
const path = require("node:path");

const reporters = [["list"]];
if (process.env.TESTBALL_TOKEN) reporters.push([path.join(__dirname, "..", "scripts", "playwright-reporter.js")]);

module.exports = {
  testDir: __dirname,
  testMatch: /.*\.e2e\.js/,
  timeout: 30000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: reporters,
  globalSetup: path.join(__dirname, "global-setup.js"),
  globalTeardown: path.join(__dirname, "global-teardown.js"),
  use: {
    baseURL: process.env.E2E_BASE_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: process.env.E2E_CHROME ? { executablePath: process.env.E2E_CHROME } : {},
  },
};
