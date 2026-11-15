// Основной путь тестировщика: вход → кейс → прогон → упавший кейс → баг из него
const { test, expect } = require("@playwright/test");
const PASSWORD = "Tb-pass-2026";

async function login(page, login = "tester") {
  await page.goto("/");
  await page.getByLabel("Логин").fill(login);
  await page.getByLabel("Пароль", { exact: true }).fill("Tb-pass-2026");
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

test("поиск открывается и при русской раскладке (⌘/Ctrl + клавиша K = «л»)", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Проекты" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "л", code: "KeyK", ctrlKey: true, bubbles: true })));
  await expect(page.getByRole("combobox")).toBeVisible();
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
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
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

test("2FA: включить в «Безопасности», войти с кодом из приложения", async ({ page }) => {
  const security = require("../server/security");
  await login(page, "viewer");
  await page.getByRole("button", { name: "Безопасность" }).click();
  await page.getByRole("tab", { name: "Двухфакторная аутентификация" }).click();
  await page.locator(".modal").getByRole("button", { name: "Включить" }).click();
  await expect(page.locator(".qr svg")).toBeVisible();
  const secret = (await page.locator(".sec-steps .mono").textContent()).replace(/\s/g, "");
  await page.getByLabel("Код из приложения").fill(security.totp(secret, security.stepNow()));
  await page.locator(".modal").getByRole("button", { name: "Включить" }).click();
  await expect(page.getByLabel("Резервные коды")).toBeVisible();
  const recovery = (await page.getByLabel("Резервные коды").textContent()).trim().split("\n");
  expect(recovery).toHaveLength(10);
  await page.locator(".modal").getByRole("button", { name: "Закрыть" }).click();
  await page.getByRole("button", { name: "Выйти" }).click();
  // вход: после пароля появляется поле кода
  await page.getByLabel("Логин").fill("viewer");
  await page.getByLabel("Пароль", { exact: true }).fill(PASSWORD);
  await page.locator("form").getByRole("button", { name: "Войти" }).click();
  await expect(page.getByLabel("Код из приложения-аутентификатора")).toBeVisible();
  await page.getByLabel("Код из приложения-аутентификатора").fill(recovery[0]);
  await page.locator("form").getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("button", { name: "Безопасность" })).toBeVisible();
  // выключаем обратно, чтобы не мешать другим тестам
  await page.request.post("/api/auth/2fa/disable", { data: { password: PASSWORD, code: recovery[1] } });
});

test("роли: админ создаёт роль в матрице разрешений; разработчик двигает баг по статусам", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/#/users/roles");
  await expect(page.locator(".roles-matrix th", { hasText: "Разработчик" })).toBeVisible();
  await page.getByRole("button", { name: "+ Роль" }).click();
  await page.locator("#roleForm").getByLabel("Название *").fill("Автоматизатор");
  await page.locator("#roleForm").getByLabel(/Отправлять результаты, управлять автотестами/).check();
  await expect(page.locator("#roleForm").getByText("полное место")).toBeVisible();
  await page.locator("#roleForm").getByRole("button", { name: "Создать" }).click();
  await expect(page.getByRole("button", { name: /Автоматизатор ✎/ })).toBeVisible();
  // разработчик: статусы бага — да, редактирование — нет
  const bug = await (await page.request.post("/api/projects/LK/bugs", { data: { title: "E2E: статус разработчиком", severity: "minor" } })).json();
  await page.getByRole("button", { name: "Выйти" }).click();
  await login(page, "dev");
  await page.goto(`/#/p/LK/bugs/${bug.num}`);
  const drawer = page.locator("aside.drawer");
  await expect(drawer.getByRole("button", { name: "Взять в работу" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Редактировать" })).toHaveCount(0);
  await drawer.getByRole("button", { name: "Взять в работу" }).click();
  await expect(drawer.getByText("В работе").first()).toBeVisible();
});

test("152-ФЗ: админ обезличивает пользователя из меню «Ещё»", async ({ page }) => {
  await login(page, "admin");
  const created = await page.request.post("/api/admin/users", { data: { login: "leaver", name: "Уходящий Сотрудник", password: "Exit-pass-2077", role: "viewer" } });
  expect(created.status()).toBe(201);
  await page.goto("/#/users");
  const row = page.getByRole("row", { name: /Уходящий Сотрудник/ });
  await row.locator("summary").click();
  await expect(row.getByRole("menuitem", { name: "Выгрузить персональные данные" })).toBeVisible();
  await row.getByRole("menuitem", { name: "Обезличить (152-ФЗ)" }).click();
  await page.locator(".modal").getByLabel(/Введите логин/).fill("leaver");
  await page.locator(".modal").getByRole("button", { name: "Обезличить" }).click();
  await expect(page.getByRole("row", { name: /Удалённый пользователь/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Уходящий Сотрудник/ })).toHaveCount(0);
});

test("массовое изменение: выбрать кейсы, поставить статус и тег", async ({ page }) => {
  await login(page);
  for (const t of ["E2E массово 1", "E2E массово 2"]) await page.request.post("/api/projects/LK/cases", { data: { title: t, priority: "low", status: "draft" } });
  await page.goto("/#/p/LK/cases");
  for (const t of ["E2E массово 1", "E2E массово 2"]) await page.getByRole("row", { name: new RegExp(t) }).getByRole("checkbox").check();
  await expect(page.getByText("Выбрано: 2")).toBeVisible();
  await page.getByRole("button", { name: "Изменить…" }).click();
  await page.locator("#bulkForm").getByLabel("Статус").selectOption("ready");
  await page.locator("#bulkForm").getByLabel("Добавить теги").fill("массовый");
  await page.locator("#bulkForm").getByLabel("Добавить теги").press("Enter");
  await page.locator("#bulkForm").getByRole("button", { name: "Применить" }).click();
  await expect(page.getByText("Изменено кейсов: 2")).toBeVisible();
  const items = (await (await page.request.get("/api/projects/LK/cases?q=" + encodeURIComponent("E2E массово"))).json()).items;
  expect(items.every((c) => c.status === "ready" && c.tags.includes("массовый"))).toBe(true);
});

test("шаблоны: шаблон по умолчанию заполняет новый кейс, форму можно сохранить как шаблон", async ({ page }) => {
  await login(page);
  await page.request.post("/api/projects/LK/templates", { data: { kind: "case", name: "E2E шаблон", isDefault: true, data: { pre: "Пользователь вошёл", priority: "high", tags: ["e2e-шаблон"] } } });
  await page.goto("/#/p/LK/cases");
  await page.getByRole("button", { name: "+ Тест-кейс" }).first().click();
  const form = page.locator("aside.drawer");
  await expect(form.locator("#tpl-case")).toHaveValue(/\d+/);
  await expect(form.getByLabel("Предусловия")).toHaveValue("Пользователь вошёл");
  await expect(form.getByLabel("Приоритет")).toHaveValue("high");
  await form.getByLabel("Название *").fill("Кейс по шаблону");
  await form.getByRole("button", { name: "Сохранить как шаблон" }).click();
  await page.locator(".modal").getByLabel("Название шаблона").fill("E2E из формы");
  await page.locator(".modal").getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Шаблон «E2E из формы» сохранён")).toBeVisible();
  await form.getByRole("button", { name: "Создать" }).click();
  await expect(page).toHaveURL(/#\/p\/LK\/cases\/\d+$/);
  const items = (await (await page.request.get("/api/projects/LK/cases?q=" + encodeURIComponent("Кейс по шаблону"))).json()).items;
  expect(items[0].priority).toBe("high");
  expect(items[0].tags).toContain("e2e-шаблон");
  await page.request.delete(`/api/projects/LK/templates/${(await (await page.request.get("/api/projects/LK/templates?kind=case")).json()).templates.find((t) => t.name === "E2E шаблон").id}`, { data: {} });
});

test("общие шаги: создать блок, вставить в кейс, увидеть раскрытые шаги", async ({ page }) => {
  await login(page);
  await page.goto("/#/p/LK/cases");
  await page.getByRole("button", { name: "Общие шаги" }).click();
  await page.locator(".modal").getByRole("button", { name: "+ Блок" }).click();
  const f = page.locator("#sharedForm");
  await f.getByLabel("Название *").fill("E2E вход");
  await f.getByLabel("Шаг 1: действие").fill("Открыть вход");
  await f.getByLabel("Шаг 1: ожидаемый результат").fill("Форма входа");
  await f.getByRole("button", { name: "Создать" }).click();
  await expect(page.locator(".modal").getByText("E2E вход")).toBeVisible();
  await page.locator(".modal").getByRole("button", { name: "Закрыть" }).click();
  await page.getByRole("button", { name: "+ Тест-кейс" }).click();
  const form = page.locator("aside.drawer");
  await form.getByLabel("Название *").fill("Кейс с общими шагами");
  await form.getByLabel("Вставить общие шаги").selectOption({ label: "E2E вход (1)" });
  await expect(form.getByText("Общие шаги: E2E вход")).toBeVisible();
  await form.getByRole("button", { name: "+ Шаг" }).click();
  await form.getByLabel("Шаг 2: действие").fill("Открыть профиль");
  await form.getByRole("button", { name: "Создать" }).click();
  await expect(page.locator("aside.drawer").getByText("⧉ Общие шаги: E2E вход")).toBeVisible();
  await expect(page.locator("aside.drawer").getByText("Открыть вход")).toBeVisible();
  await expect(page.locator("aside.drawer").getByText("Открыть профиль")).toBeVisible();
});

test("ревью: автор отправляет кейс на ревью, рецензент возвращает, затем утверждает", async ({ page, browser }) => {
  await login(page);
  const n = (await (await page.request.post("/api/projects/LK/cases", { data: { title: "E2E на ревью", priority: "high", status: "draft", steps: "Открыть" } })).json()).num;
  await page.goto(`/#/p/LK/cases/${n}`);
  const drawer = page.locator("aside.drawer");
  await drawer.getByRole("button", { name: "Отправить на ревью" }).click();
  await page.locator(".modal").getByLabel("Админ").check();
  await page.locator(".modal").getByLabel("Комментарий для рецензента").fill("Посмотри шаги");
  await page.locator(".modal").getByRole("button", { name: "Отправить" }).click();
  await expect(drawer.getByText("На ревью у Админ")).toBeVisible();
  await expect(drawer.getByLabel("Статус кейса")).toHaveValue("review");

  const ctx = await browser.newContext();
  const rp = await ctx.newPage();
  await login(rp, "admin");
  await rp.goto("/#/p/LK/cases");
  await rp.getByLabel("Статус", { exact: true }).selectOption("my-review");
  await rp.getByText("E2E на ревью").click();
  const rd = rp.locator("aside.drawer");
  await rd.getByRole("button", { name: "Вернуть на доработку" }).click();
  await rp.locator(".modal").getByLabel("Что поправить").fill("Добавь ожидаемый результат");
  await rp.locator(".modal").getByRole("button", { name: "Вернуть" }).click();
  await expect(rd.getByText("Добавь ожидаемый результат")).toBeVisible();
  await expect(rd.getByLabel("Статус кейса")).toHaveValue("draft");

  await page.request.post(`/api/projects/LK/cases/${n}/review`, { data: { reviewers: ["admin"] } });
  await rp.reload();
  await rd.getByRole("button", { name: "Утвердить" }).click();
  await rp.locator(".modal").getByRole("button", { name: "Утвердить" }).click();
  await expect(rd.getByLabel("Статус кейса")).toHaveValue("ready");
  await ctx.close();
});

test("параметры кейса: таблица в редакторе, итерации по наборам в прогоне с подстановкой значений", async ({ page }) => {
  await login(page);
  const api = page.request;
  const n = (await (await api.post("/api/projects/LK/cases", { data: { title: "Вход ролью", priority: "high", status: "ready", stepList: [{ action: "Войти как {{login}}", expected: "Кабинет открыт" }] } })).json()).num;
  // параметры через редактор
  await page.goto(`/#/p/LK/cases/${n}`);
  await page.locator("aside.drawer").getByRole("button", { name: "Редактировать" }).click();
  const form = page.locator("aside.drawer");
  await form.getByLabel("Своя таблица").check();
  await form.getByLabel("Новый параметр").fill("login");
  await form.getByRole("button", { name: "+ Параметр" }).click();
  await form.getByRole("button", { name: "+ Набор" }).click();
  await form.getByRole("button", { name: "+ Набор" }).click();
  await form.getByLabel("login, Набор 1").fill("admin");
  await form.getByLabel("login, Набор 2").fill("guest");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator("aside.drawer").getByText("Параметры · 2 наб.")).toBeVisible();

  const run = (await (await api.post("/api/projects/LK/runs", { data: { title: "Роли", caseNums: [n] } })).json()).num;
  await page.goto(`/#/p/LK/runs/${run}`);
  await page.getByText("Вход ролью").click();
  const d = page.locator("aside.drawer");
  await expect(d.getByText("Войти как admin")).toBeVisible();
  await d.getByRole("group", { name: "Результат набора Набор 1" }).getByRole("button", { name: "Пройден" }).click();
  await d.getByRole("tab", { name: /Набор 2/ }).click();
  await expect(d.getByText("Войти как guest")).toBeVisible();
  await d.getByRole("group", { name: "Результат шага 1" }).getByRole("button", { name: "Упал" }).click();
  await expect.poll(async () => (await (await api.get(`/api/projects/LK/runs/${run}/results`)).json()).results[0].result).toBe("failed");
  const res = (await (await api.get(`/api/projects/LK/runs/${run}/results`)).json()).results[0];
  expect(res.iterResults["0"].result).toBe("passed");
  expect(res.iterResults["1"].steps["0"].result).toBe("failed");
});
