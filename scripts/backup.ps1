# Резервная копия базы и вложений в папку backups\ (Windows PowerShell). Хранит последние 14 копий.
# Запуск из папки проекта: powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force -Path backups | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$file = "backups\testbol-$stamp.sql"
docker compose exec -T db pg_dump -U testbed testbed | Out-File -Encoding utf8 $file
# Вложения копируются папкой: конвейер PowerShell портит двоичные данные
docker compose cp app:/app/data/uploads "backups\uploads-$stamp"
Write-Host "Готово: $file и backups\uploads-$stamp"
Get-ChildItem backups\testbol-*.sql | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item
Get-ChildItem backups -Directory -Filter "uploads-*" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item -Recurse
