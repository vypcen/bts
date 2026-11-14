// Основной путь тестировщика: вход → кейс → прогон → упавший кейс → баг из него
const { test, expect } = require("@playwright/test");

async function login(page, login = "tester") {
  await page.goto("/");
  await page.getByLabel("Логин").fill(login);
  await page.getByLabel("Пароль", { exact: true }).fill("password123");
  await page.locator("form").getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Личный кабинет").first()).toBeVisible();
}

test("неверный пароль — понятная ошибка", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Логин").fill("tester");
  await page.getByLabel("Пароль", { exact: true }).fill("wrong-password");
  await page.locator("form").getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Неверный логин или пароль")).toBeVisible();
});

test("кейс → прогон → упал → баг", async ({ page, request }) => {
  // данные через API под той же сессией, что и браузер
  await login(page);
  const api = page.request;
  const kase = await (await api.post("/api/projects/LK/cases", { data: { title: "E2E: вход по паролю", priority: "high", status: "ready", steps: "Открыть\nВвести", expected: "Вошёл" } })).json();
  const run = await (await api.post("/api/projects/LK/runs", { data: { title: "E2E регресс", caseNums: [kase.num] } })).json();

  await page.goto(`/#/p/LK/runs/${run.num}`);
  await expect(page.getByText("E2E регресс").first()).toBeVisible();
  await page.getByText("E2E: вход по паролю").first().click();
  await page.locator(".seg.lg").getByRole("button", { name: /Упал/ }).click();
  await page.getByRole("button", { name: "Завести баг" }).click();
  await expect(page.locator("#bugForm")).toBeVisible();
  await page.getByRole("button", { name: "Создать баг" }).click();

  await expect.poll(async () => {
    const st = await (await api.get("/api/projects/LK/state")).json();
    return st.bugs.some((b) => b.caseNum === kase.num && b.runNum === run.num);
  }).toBe(true);
});

test("разработчик видит проект только на чтение", async ({ page }) => {
  await login(page, "dev");
  await page.goto("/#/p/LK/cases");
  await expect(page.getByRole("button", { name: /Новый тест-кейс|\+ Тест-кейс/ })).toHaveCount(0);
});

test("все вкладки проекта открываются без ошибок в консоли", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await login(page, "admin");
  const api = page.request;
  const k = await (await api.post("/api/projects/LK/cases", { data: { title: "Обход", priority: "low", status: "ready" } })).json();
  const run = await (await api.post("/api/projects/LK/runs", { data: { title: "Обход вкладок", caseNums: [k.num] } })).json();
  for (const tab of ["cases", "plans", "runs", "bugs", "auto", "analytics", "integrations", `runs/${run.num}`, `cases/${k.num}`]) {
    await page.goto(`/#/p/LK/${tab}`);
    await page.waitForTimeout(400); // networkidle не наступает: открыт поток живых обновлений
    await expect(page.locator(".skel")).toHaveCount(0);
  }
  await page.goto("/#/users");
  await page.waitForTimeout(400);
  await page.goto("/#/");
  await expect(page.getByText("Личный кабинет").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("глобальный поиск по Ctrl+K находит кейс и открывает его", async ({ page }) => {
  await login(page);
  const k = await (await page.request.post("/api/projects/LK/cases", { data: { title: "Восстановление доступа по SMS", priority: "low", status: "ready" } })).json();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("восстановлению доступа");
  await page.getByRole("option", { name: /Восстановление доступа по SMS/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/p/LK/cases/${k.num}$`));
});

test("карточка и редактор кейса догружают шаги; правка названия не стирает шаги", async ({ page }) => {
  await login(page);
  const api = page.request;
  const k = await (await api.post("/api/projects/LK/cases", { data: { title: "Шаги на месте", priority: "low", status: "ready", steps: "Первый шаг\nВторой шаг", expected: "Всё хорошо" } })).json();
  await page.goto(`/#/p/LK/cases/${k.num}`);
  await expect(page.getByText("Второй шаг")).toBeVisible();
  await page.getByRole("button", { name: "Редактировать", exact: true }).last().click();
  const title = page.getByLabel(/Название/).first();
  await title.fill("Шаги на месте — правка");
  await page.getByRole("button", { name: /Сохранить/ }).click();
  await expect.poll(async () => (await (await api.get(`/api/projects/LK/cases/${k.num}`)).json()).title).toBe("Шаги на месте — правка");
  const full = await (await api.get(`/api/projects/LK/cases/${k.num}`)).json();
  expect(full.steps).toBe("Первый шаг\nВторой шаг");
});
