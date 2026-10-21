# Резервная копия базы в папку backups\ (Windows PowerShell). Хранит последние 14 копий.
# Запуск из папки проекта: powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force -Path backups | Out-Null
$file = "backups\testbed-$(Get-Date -Format 'yyyy-MM-dd_HH-mm').sql"
docker compose exec -T db pg_dump -U testbed testbed | Out-File -Encoding utf8 $file
Write-Host "Готово: $file"
Get-ChildItem backups\testbed-*.sql | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item
