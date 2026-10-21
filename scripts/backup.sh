#!/usr/bin/env sh
# Резервная копия базы и вложений в папку backups/. Хранит последние 14 копий.
# Запуск из папки проекта: ./scripts/backup.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP="$(date +%Y-%m-%d_%H-%M)"
docker compose exec -T db pg_dump -U testbed testbed | gzip > "backups/testbol-$STAMP.sql.gz"
docker compose exec -T app tar -czf - -C /app/data uploads > "backups/uploads-$STAMP.tar.gz"
echo "Готово: backups/testbol-$STAMP.sql.gz и backups/uploads-$STAMP.tar.gz"
ls -1t backups/testbol-*.sql.gz | tail -n +15 | xargs -r rm --
ls -1t backups/uploads-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm --
