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
  for (const tab of ["cases", "plans", "runs", "bugs", "auto", "analytics", "integrations", "trash", `runs/${run.num}`, `cases/${k.num}`]) {
    await page.goto(`/#/p/LK/${tab}`);
    await page.waitForTimeout(400); // networkidle не наступает: открыт поток живых обновлений
    await expect(page.locator(".skel")).toHaveCount(0);
  }
  for (const sub of ["users", "users/audit", "users/trash"]) {
    await page.goto(`/#/${sub}`);
    await page.waitForTimeout(400);
    await expect(page.locator(".skel")).toHaveCount(0);
  }
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

test("удалённый кейс восстанавливается из корзины проекта", async ({ page }) => {
  await login(page);
  const api = page.request;
  const k = await (await api.post("/api/projects/LK/cases", { data: { title: "Кейс для корзины E2E", priority: "low", status: "ready" } })).json();
  await page.goto(`/#/p/LK/cases/${k.num}`);
  await page.locator("aside.drawer").getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(page.getByText(/уйдёт в корзину проекта/)).toBeVisible();
  await page.locator(".modal").getByRole("button", { name: "Удалить", exact: true }).click();
  await expect.poll(async () => (await api.get(`/api/projects/LK/cases/${k.num}`)).status()).toBe(404);
  await expect(page.locator("aside.drawer")).toHaveCount(0);
  await page.getByRole("link", { name: "Корзина" }).click();
  const row = page.getByRole("row", { name: /Кейс для корзины E2E/ });
  await row.getByRole("button", { name: "Восстановить" }).click();
  await expect.poll(async () => (await api.get(`/api/projects/LK/cases/${k.num}`)).status()).toBe(200);
});

test("модель кейса: поле в настройках, кейс со структурными шагами и тегами, шаг упал → баг", async ({ page }) => {
  await login(page);
  const api = page.request;
  // пользовательское поле
  await page.goto("/#/p/LK/integrations");
  await page.getByRole("button", { name: "+ Поле" }).click();
  await page.getByLabel("Название *").fill("Компонент");
  await page.getByLabel("Варианты").fill("Оплата\nВход");
  await page.locator(".modal").getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByText("Оплата, Вход")).toBeVisible();

  // кейс через форму
  await page.goto("/#/p/LK/cases");
  await page.getByRole("button", { name: "+ Тест-кейс" }).first().click();
  await page.getByLabel("Название *").fill("E2E: оплата картой");
  await page.getByLabel("Шаг 1: действие").fill("Открыть корзину");
  await page.getByLabel("Шаг 1: ожидаемый результат").fill("Корзина открыта");
  await page.getByLabel("Шаг 1: действие").press("Enter");
  await page.getByLabel("Шаг 2: действие").fill("Нажать «Оплатить»");
  await page.getByLabel("Шаг 2: ожидаемый результат").fill("Форма оплаты");
  await page.getByLabel("Теги").fill("оплата");
  await page.getByLabel("Теги").press("Enter");
  await page.locator("#caseForm").getByLabel("Компонент").selectOption("Оплата");
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.locator("aside.drawer").getByText("Форма оплаты")).toBeVisible();
  const st = await (await api.get("/api/projects/LK/state")).json();
  const k = st.cases.find((c) => c.title === "E2E: оплата картой");
  const full = await (await api.get(`/api/projects/LK/cases/${k.num}`)).json();
  expect(full.stepList.map((s) => s.expected)).toEqual(["Корзина открыта", "Форма оплаты"]);
  expect(full.tags).toEqual(["оплата"]);
  expect(Object.values(full.fields)).toEqual(["Оплата"]);

  // прогон: первый шаг прошёл, второй упал → баг из шага
  const run = await (await api.post("/api/projects/LK/runs", { data: { title: "E2E шаги", caseNums: [k.num] } })).json();
  await page.goto(`/#/p/LK/runs/${run.num}`);
  await page.getByText("E2E: оплата картой").first().click();
  await page.getByRole("group", { name: "Результат шага 1" }).getByRole("button", { name: /Пройден/ }).click();
  await page.getByRole("group", { name: "Результат шага 2" }).getByRole("button", { name: /Упал/ }).click();
  await page.getByLabel("Фактический результат шага 2").fill("Ошибка 500");
  await page.getByLabel("Фактический результат шага 2").blur();
  await expect.poll(async () => (await (await api.get(`/api/projects/LK/runs/${run.num}/results`)).json()).results[0].steps?.["1"]?.actual).toBe("Ошибка 500");
  await page.locator("aside.drawer").getByRole("button", { name: "+ Баг" }).click();
  await expect(page.getByLabel("Фактический результат")).toHaveValue("Ошибка 500");
  await expect(page.getByLabel("Ожидаемый результат")).toHaveValue("Форма оплаты");
  await page.getByRole("button", { name: "Создать баг" }).click();
  await expect.poll(async () => (await (await api.get("/api/projects/LK/state")).json()).bugs.some((b) => b.title.includes("шаг 2"))).toBe(true);
});

test("лицензия и система: админ видит редакцию, версию и может ввести ключ", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/#/users/system");
  await expect(page.getByRole("cell", { name: "Бесплатная", exact: true })).toBeVisible();
  await expect(page.getByText("Версия TestBall")).toBeVisible();
  await page.getByRole("button", { name: "Ввести ключ" }).click();
  await page.getByLabel("Лицензионный ключ").fill("TB1.подделка.AAAA");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByText(/Ключ повреждён|Подпись ключа не сходится/)).toBeVisible();
});

test("требования: создать, связать с кейсом, увидеть покрытие и требование в карточке кейса", async ({ page }) => {
  await login(page);
  const api = page.request;
  const kase = await (await api.post("/api/projects/LK/cases", { data: { title: "E2E: трассировка корзины", priority: "high", status: "ready" } })).json();
  await page.goto("/#/p/LK/reqs");
  await page.getByRole("button", { name: "+ Требование" }).click();
  await page.locator("#reqForm").getByLabel("Название *").fill("Корзина сохраняется между сессиями");
  await page.getByLabel("Ключ во внешней системе").fill("SHOP-7");
  await page.getByPlaceholder("Найти кейс по названию или номеру").fill("трассировка корзины");
  await page.locator("#reqForm").getByRole("button", { name: /E2E: трассировка корзины/ }).click();
  await page.locator("#reqForm").getByRole("button", { name: "Создать" }).click();
  const row = page.getByRole("row", { name: /Корзина сохраняется/ });
  await expect(row.getByText("Не проверено")).toBeVisible();
  // прогон с упавшим кейсом → «Провалено»
  const run = await (await api.post("/api/projects/LK/runs", { data: { title: "E2E трассировка", caseNums: [kase.num] } })).json();
  await api.patch(`/api/projects/LK/runs/${run.num}/results/${kase.num}`, { data: { result: "failed" } });
  await expect(row.getByText("Провалено")).toBeVisible();
  await row.click();
  await expect(page.locator("aside.drawer").getByText("SHOP-7")).toBeVisible();
  await page.locator("aside.drawer").getByRole("link", { name: `LK-${kase.num}` }).click();
  await expect(page.locator("aside.drawer").getByRole("link", { name: /Корзина сохраняется/ })).toBeVisible();
});

test("справка: открывается из шапки, ссылка ведёт в нужный раздел другого документа", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Справка" }).click();
  await expect(page.getByRole("heading", { name: "Руководство пользователя TestBall QA" })).toBeVisible();
  await page.locator(".help-doc").getByRole("link", { name: "руководство администратора", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Перенос данных из других систем" })).toBeInViewport();
  await page.getByRole("navigation", { name: "Разделы справки" }).getByRole("link", { name: "API" }).click();
  await expect(page.getByRole("heading", { name: "TestBall QA — HTTP API" })).toBeVisible();
});
