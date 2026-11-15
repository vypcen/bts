# testbolctl — TestBall QA для CI

Утилита отправляет результаты автотестов в TestBall и управляет запусками. Зависимостей нет: нужен Node.js 20+
или самостоятельный бинарник.

## Установка

```sh
npm install -g @testball/cli          # из вашего npm-реестра (пакет собирается из папки cli/ репозитория)
# или без установки:
node path/to/testball/cli/bin/testbolctl.js help
# или самостоятельный бинарник (Linux, Windows, macOS — собирать на целевой ОС):
sh cli/build-binary.sh                # → cli/dist/testbolctl
```

## Настройка

Токен: в TestBall вкладка «Автотесты» → «Подключить» (права «отправка результатов»; для `run status` хватает их же).

```sh
export TESTBALL_URL=https://testball.company.ru
export TESTBALL_TOKEN=tb_…
export TESTBALL_PROJECT=LK
testbolctl check          # проверит адрес, токен и проект
```

## Команды

| Команда | Что делает |
|---|---|
| `testbolctl upload <отчёты>... [-- команда]` | Отправить JUnit XML (pytest, Playwright, Jest, JUnit/TestNG, Go…) или папку allure-results. С `-- команда` сначала запускает тесты; код выхода — как у команды |
| `testbolctl run start [--title T] [--scope S] [--app-url URL]` | Создать запуск, напечатать его номер (только номер — для `TESTBALL_RUN=$(…)`) |
| `testbolctl run finish [--run N] [--failed]` | Завершить запуск; `--failed` — запуск сорвался (упал раннер, нет окружения) |
| `testbolctl run status [--run N] [--fail-on failed\|any] [--json]` | Сводка. С `--fail-on failed` код выхода 1, если есть упавшие или сломанные тесты не в карантине; `any` — включая карантин |
| `testbolctl check` | Проверить подключение |

Ветка, коммит и номер сборки подставляются сами в GitLab CI, GitHub Actions, Jenkins, TeamCity, Bitbucket Pipelines и Azure DevOps;
явные `--branch`, `--build`, `--title`, `--env` главнее. Если задан `TESTBALL_RUN` (так делает кнопка «Запустить в CI»),
`upload` дописывает результаты в этот запуск.

## Примеры

GitLab CI — несколько наборов тестов в один запуск, сборка падает только из-за настоящих падений:

```yaml
e2e:
  script:
    - export TESTBALL_RUN=$(testbolctl run start --title "Nightly e2e" --scope "web, api")
    - testbolctl upload reports/web/junit.xml -- npx playwright test || true
    - testbolctl upload allure-results/ -- pytest tests/api --alluredir=allure-results || true
    - testbolctl run finish
    - testbolctl run status --fail-on failed
```

GitHub Actions:

```yaml
- run: npx --yes @testball/cli upload results/junit.xml -- npm test
  env:
    TESTBALL_URL: ${{ secrets.TESTBALL_URL }}
    TESTBALL_TOKEN: ${{ secrets.TESTBALL_TOKEN }}
    TESTBALL_PROJECT: LK
```
