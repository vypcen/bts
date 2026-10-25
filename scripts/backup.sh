#!/usr/bin/env sh
# Резервная копия базы и вложений в папку backups/. Хранит последние 14 копий.
# Запуск из папки проекта: ./scripts/backup.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP="$(date +%Y-%m-%d_%H-%M)"
DB="backups/testbol-$STAMP.sql.gz"
FILES="backups/uploads-$STAMP.tar.gz"
trap 'rm -f "$DB.part" "$FILES.part"' EXIT
# Пишем во временные файлы: если что-то упадёт, недоделанная копия не займёт место хорошей.
# Сжатие внутри контейнера — код выхода pg_dump не теряется в конвейере (set -e видит только последнюю команду)
docker compose exec -T db sh -c 'pg_dump -U testbed testbed > /tmp/backup.sql && gzip -c /tmp/backup.sql; s=$?; rm -f /tmp/backup.sql; exit $s' > "$DB.part"
docker compose exec -T app tar -czf - -C /app/data uploads > "$FILES.part"
gzip -t "$DB.part"
mv "$DB.part" "$DB"
mv "$FILES.part" "$FILES"
echo "Готово: $DB и $FILES"
# Старые копии удаляются только после того, как новая точно получилась
ls -1t backups/testbol-*.sql.gz | tail -n +15 | xargs -r rm --
ls -1t backups/uploads-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm --
