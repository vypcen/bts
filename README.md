# Testbed QA

MVP системы управления тест-кейсами: вход по логину и паролю, проекты, CRUD тест-кейсов, живое обновление у всех участников.

**Стек:** Node.js 20 + Express, PostgreSQL 16, Docker Compose. Интерфейс — один файл `public/index.html` без сборки.

```
testbed-qa/
├── docker-compose.yml     # приложение + PostgreSQL (+ необязательный Cloudflare Tunnel)
├── Dockerfile             # образ приложения
├── .env.example           # шаблон настроек → скопировать в .env
├── server/
│   ├── index.js           # HTTP API и раздача интерфейса
│   ├── auth.js            # пароли (bcrypt), сессии в cookie, ограничение попыток входа
│   ├── db.js, migrate.js  # подключение к PostgreSQL и миграции
│   └── migrations/        # схема базы (применяется автоматически при старте)
├── public/index.html      # интерфейс
├── scripts/
│   ├── import.js          # перенос данных из прошлой облачной версии
│   └── backup.sh / .ps1   # резервное копирование базы
└── import/                # сюда кладётся export.json для импорта (в git не попадает)
```

---

## Часть 1. Развернуть на своём компьютере

### Шаг 1. Установить Docker и Git

| ОС | Docker | Git |
|---|---|---|
| **Windows 10/11** | [Docker Desktop](https://www.docker.com/products/docker-desktop/). При установке оставьте галочку «Use WSL 2». После установки перезагрузите компьютер. | [git-scm.com](https://git-scm.com/download/win) |
| **macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (выберите Apple Silicon или Intel) | `xcode-select --install` |
| **Linux (Ubuntu/Debian)** | `curl -fsSL https://get.docker.com \| sh`, затем `sudo usermod -aG docker $USER` и перелогиньтесь | `sudo apt install git` |

Проверка в терминале (на Windows — PowerShell):

```sh
docker --version
docker compose version
git --version
```

Все три команды должны вывести версии. На Windows и macOS Docker Desktop должен быть запущен (иконка кита в трее).

### Шаг 2. Получить код

**Вариант А — из архива.** Распакуйте `testbed-qa.zip` в удобную папку, например `C:\testbed-qa` или `~/testbed-qa`. В архиве уже есть git-репозиторий с первым коммитом.

**Вариант Б — через GitHub** (удобно, чтобы хранить код и обновлять его):

1. На github.com создайте **приватный** репозиторий `testbed-qa` без README.
2. На основном компьютере в распакованной папке выполните:
   ```sh
   git remote add origin https://github.com/<ваш-логин>/testbed-qa.git
   git push -u origin main
   ```
3. На втором компьютере:
   ```sh
   git clone https://github.com/<ваш-логин>/testbed-qa.git
   cd testbed-qa
   ```

Файл `import/export.json` с данными из прошлой версии в репозиторий не попадает (в нём хэши паролей). Если нужен импорт, скопируйте его на второй компьютер в папку `import/` вручную.

### Шаг 3. Создать файл настроек `.env`

```sh
# Linux / macOS
cp .env.example .env
# Windows (PowerShell)
Copy-Item .env.example .env
```

Откройте `.env` в блокноте и замените `POSTGRES_PASSWORD` на длинный случайный пароль. Сгенерировать можно так:

```sh
# Linux / macOS
openssl rand -base64 24
# Windows (PowerShell)
[Convert]::ToBase64String((1..24 | % { Get-Random -Max 256 }))
```

Важно: пароль базы задаётся **один раз** при первом запуске. Если поменять его потом, приложение не подключится к уже созданной базе.

### Шаг 4. Запустить

В папке проекта:

```sh
docker compose up -d --build
```

Первый запуск занимает 1–3 минуты: скачиваются образы Node.js и PostgreSQL. Проверьте, что всё поднялось:

```sh
docker compose ps
docker compose logs app
```

В логах должна быть строка `Testbed QA запущен: http://localhost:3000`.

### Шаг 5. Открыть приложение

Откройте в браузере **http://localhost:3000**, перейдите на вкладку «Регистрация» и создайте аккаунт.

### Шаг 6. Перенести данные из прошлой версии (необязательно)

Если файл `import/export.json` на месте:

```sh
docker compose exec app node scripts/import.js import/export.json
```

Импортируются пользователи, проекты и тест-кейсы. Старые пароли продолжат работать (при первом входе они автоматически перехэшируются в bcrypt). Повторный запуск безопасен: уже существующие записи пропускаются.

### Шаг 7. Автозапуск после перезагрузки

Контейнеры настроены с `restart: unless-stopped`: они поднимаются сами, когда запускается Docker.

- **Windows/macOS:** в Docker Desktop → Settings → General включите «Start Docker Desktop when you sign in». Настройте автоматический вход в учётную запись или не выходите из неё.
- **Linux:** `sudo systemctl enable docker`.
- **Везде:** отключите спящий режим (Windows: Параметры → Система → Питание; macOS: Настройки → Аккумулятор/Энергосбережение → «Не переходить в режим сна»). Пока компьютер спит, приложение недоступно.

### Шаг 8. Резервные копии

```sh
# Linux / macOS
./scripts/backup.sh
# Windows
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
```

Копия появится в папке `backups/`, хранятся последние 14. Чтобы делать это каждую ночь:

- **Linux/macOS:** `crontab -e` и строка `0 3 * * * cd /путь/к/testbed-qa && ./scripts/backup.sh`
- **Windows:** Планировщик заданий → Создать простую задачу → Ежедневно → Запуск программы `powershell`, аргументы `-ExecutionPolicy Bypass -File C:\testbed-qa\scripts\backup.ps1`.

Хорошо бы время от времени копировать папку `backups/` на другой диск или в облако.

Восстановление из копии:

```sh
gunzip -c backups/testbed-ГГГГ-ММ-ДД_ЧЧ-ММ.sql.gz | docker compose exec -T db psql -U testbed testbed
```

(на Windows: `Get-Content backups\файл.sql | docker compose exec -T db psql -U testbed testbed`). Восстанавливать лучше в пустую базу.

### Полезные команды

| Что сделать | Команда |
|---|---|
| Посмотреть логи | `docker compose logs -f app` |
| Остановить | `docker compose stop` |
| Запустить снова | `docker compose start` |
| Обновить после изменения кода | `git pull` и `docker compose up -d --build` |
| Зайти в базу через psql | `docker compose exec db psql -U testbed testbed` |
| Удалить всё **вместе с данными** | `docker compose down -v` (осторожно!) |

---

## Часть 2. Доступ к приложению извне

Выберите один вариант в зависимости от того, откуда будут заходить коллеги.

### Вариант А. Только из локальной сети (офис, дом)

1. **Узнайте IP-адрес компьютера с приложением:**
   - Windows: `ipconfig` → «IPv4-адрес», например `192.168.1.50`
   - macOS: Настройки → Сеть → Wi-Fi/Ethernet → Подробнее
   - Linux: `hostname -I`
2. **Разрешите входящие подключения на порт 3000:**
   - Windows (PowerShell от имени администратора):
     ```powershell
     New-NetFirewallRule -DisplayName "Testbed QA" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
     ```
     Сеть в Windows должна быть отмечена как «Частная».
   - Linux с ufw: `sudo ufw allow 3000/tcp`
   - macOS: при первом подключении система сама спросит разрешение.
3. **Закрепите IP за компьютером** в настройках роутера (раздел DHCP → «Резервирование адресов»), иначе после перезагрузки роутера адрес может смениться.
4. Коллеги открывают **http://192.168.1.50:3000** (подставьте свой адрес).

### Вариант Б. Из интернета через Tailscale — рекомендую для команды

Tailscale создаёт приватную зашифрованную сеть между вашими устройствами. Приложение видно только тем, кого вы пригласили, а порты на роутере открывать не нужно. Бесплатно до 3 пользователей и 100 устройств (условия проверьте на сайте).

1. Зарегистрируйтесь на [tailscale.com](https://tailscale.com) и установите Tailscale **на компьютер с приложением**. Войдите в аккаунт.
2. В [панели администратора](https://login.tailscale.com/admin/machines) найдите этот компьютер и для удобства отключите ему «Key expiry» (иначе раз в 180 дней нужно будет заново входить).
3. Пригласите коллег: Admin console → Users → Invite users. Каждый устанавливает Tailscale на свой компьютер или телефон и входит по приглашению.
4. Коллеги открывают **http://<имя-компьютера>:3000** — имя видно в панели Tailscale (работает благодаря MagicDNS), либо по адресу вида `http://100.x.y.z:3000`.
5. *(Необязательно)* HTTPS с нормальным сертификатом: на компьютере с приложением выполните
   ```sh
   tailscale serve --bg 3000
   ```
   После этого приложение будет доступно по адресу `https://<имя-компьютера>.<ваш-tailnet>.ts.net` (точный адрес команда выведет). Возможно, сначала понадобится включить HTTPS в Admin console → DNS.

### Вариант В. Публичный адрес через Cloudflare Tunnel

Подходит, если нужен обычный адрес вроде `https://qa.example.com`, который открывается в любом браузере без установки программ. Понадобится свой домен, подключённый к Cloudflare (бесплатный тариф Cloudflare подходит; домен покупается отдельно).

1. Добавьте домен в [Cloudflare](https://dash.cloudflare.com) и смените у регистратора NS-серверы на те, что выдаст Cloudflare.
2. Откройте **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → тип **Cloudflared**. Назовите туннель, например `testbed`.
3. На шаге установки выберите Docker и скопируйте из показанной команды **токен** (длинная строка после `--token`). Вставьте его в `.env`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJh...
   ```
4. На шаге **Public Hostname** укажите поддомен (`qa`) и домен, тип сервиса **HTTP**, URL **`app:3000`**.
5. Запустите туннель вместе с приложением:
   ```sh
   docker compose --profile tunnel up -d
   ```
6. Через минуту приложение откроется по адресу `https://qa.example.com`. Cloudflare сам выдаёт HTTPS-сертификат.
7. **Настоятельно рекомендую** закрыть адрес дополнительной проверкой: Zero Trust → **Access** → **Applications** → Add → Self-hosted, домен `qa.example.com`, политика Allow по списку email коллег. Тогда до страницы входа доберутся только они, а не весь интернет.

Названия пунктов в панели Cloudflare периодически меняются; если не находите нужный, ищите раздел «Tunnels» в Zero Trust.

### Чего лучше не делать

- **Не пробрасывайте порт 3000 на роутере** напрямую в интернет: соединение будет без HTTPS (пароли пойдут открытым текстом), а компьютер станет виден сканерам со всего мира. Tailscale и Cloudflare Tunnel решают задачу без этих рисков.
- Не открывайте наружу порт PostgreSQL (5432). В `docker-compose.yml` он намеренно не опубликован.

---

## Безопасность в этой версии

- Пароли хранятся только в виде хэша bcrypt; участники их не видят.
- Сессия — случайный токен в cookie `HttpOnly`, `SameSite=Lax`; через HTTPS (Tailscale serve, Cloudflare) cookie получает флаг `Secure`. В базе лежит только хэш токена.
- 10 неудачных попыток входа за 15 минут блокируют дальнейшие попытки для этого логина с этого адреса.
- Изменяющие запросы принимаются только с `Content-Type: application/json`, это защищает от подделки запросов с чужих сайтов.

Что стоит добавить, когда MVP пойдёт в работу: роли (администратор/участник), участников на уровне проекта, смену и сброс пароля, журнал изменений.

## Если что-то не работает

| Симптом | Что проверить |
|---|---|
| `docker: command not found` / `Cannot connect to the Docker daemon` | Docker Desktop не запущен или не установлен (шаг 1) |
| `Задайте POSTGRES_PASSWORD в файле .env` | Нет файла `.env` или в нём пустой пароль (шаг 3) |
| В логах `password authentication failed` | Пароль в `.env` поменяли после первого запуска. Верните прежний, либо, если данных ещё нет, `docker compose down -v` и запуск заново |
| `port is already allocated` | Порт 3000 занят. Поменяйте `APP_PORT=3001` в `.env` и перезапустите |
| Коллеги из локальной сети не открывают страницу | Брандмауэр (вариант А, п. 2), правильный IP, оба устройства в одной сети |
| Страница открывается, но «Связь с сервером прервана» | Посмотрите `docker compose logs app`; при работе через прокси проверьте, что он не буферизует ответы |
