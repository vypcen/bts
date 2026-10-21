#!/usr/bin/env sh
# Резервная копия базы в папку backups/. Хранит последние 14 копий.
# Запуск из папки проекта: ./scripts/backup.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p backups
FILE="backups/testbed-$(date +%Y-%m-%d_%H-%M).sql.gz"
docker compose exec -T db pg_dump -U testbed testbed | gzip > "$FILE"
echo "Готово: $FILE"
ls -1t backups/testbed-*.sql.gz | tail -n +15 | xargs -r rm --
