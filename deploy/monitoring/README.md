# Мониторинг TestBall QA

| Файл | Что это |
|---|---|
| `grafana-dashboard.json` | дашборд Grafana: запросы и ошибки, время ответа по маршрутам, база и пул соединений, память и процессор, ошибки в журнале, вебхуки. Импорт: Grafana → Dashboards → New → Import |
| `alerts.yaml` | правила оповещений для Prometheus (`rule_files`) |
| `alerts-operator.yaml` | те же правила как `PrometheusRule` для Prometheus Operator |

Метрики включаются переменной `METRICS_TOKEN` (в Helm — `secrets.metricsToken` и `metrics.serviceMonitor.enabled=true`). Пример настройки обычного Prometheus:

```yaml
scrape_configs:
  - job_name: testball
    metrics_path: /metrics
    authorization:
      credentials: "<METRICS_TOKEN>"
    static_configs:
      - targets: ["testball.company.ru:3000"]
```

Подробно — в руководстве администратора, раздел «Мониторинг».
