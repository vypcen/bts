# Резервная копия базы и вложений в папку backups\ (Windows PowerShell). Хранит последние 14 копий.
# Запуск из папки проекта: powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force -Path backups | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$file = "backups\testbol-$stamp.sql"

# Ошибка внешней программы в Windows PowerShell не останавливает скрипт сама — проверяем код выхода
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what завершился с ошибкой (код $LASTEXITCODE). Копия не создана, старые не тронуты" } }

# Дамп пишется файлом внутри контейнера и копируется как есть: через конвейер PowerShell текст перекодируется
# в кодировку консоли (cp866) и кириллица в копии безвозвратно портится
docker compose exec -T db pg_dump -U testbed -f /tmp/testbol-backup.sql testbed; Check "pg_dump"
docker compose cp db:/tmp/testbol-backup.sql $file; Check "Копирование дампа"
docker compose exec -T db rm -f /tmp/testbol-backup.sql | Out-Null
if ((Get-Item $file).Length -lt 1024) { Remove-Item $file; throw "Дамп подозрительно маленький. Копия не создана, старые не тронуты" }

docker compose cp app:/app/data/uploads "backups\uploads-$stamp"; Check "Копирование вложений"
Write-Host "Готово: $file и backups\uploads-$stamp"

# Старые копии удаляются только после того, как новая точно получилась
Get-ChildItem backups\testbol-*.sql | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item
Get-ChildItem backups -Directory -Filter "uploads-*" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item -Recurse
