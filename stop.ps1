# 停止 kms-data-agent 后端（配合 start.ps1 使用）
# 用法: .\stop.ps1
# 按 .env 里的 PORT 找到监听进程并终止；端口无监听时提示后正常退出

$ErrorActionPreference = "Stop"

# 从 .env 读取端口（读不到时回退默认 9100）
$port = 9101
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -First 1
  if ($line) {
    $port = [int]($line -replace '^\s*PORT\s*=\s*', '').Trim()
  }
}

$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
$pids = @($conns | Select-Object -ExpandProperty OwningProcess -Unique)

if ($pids.Count -eq 0) {
  Write-Host "服务未运行（端口 $port 无监听）。"
  exit 0
}

foreach ($processId in $pids) {
  $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  if ($proc.ProcessName -ne "node") {
    Write-Host "端口 $port 被非 node 进程占用（PID $processId，$($proc.ProcessName)），已跳过，请手动确认。"
    continue
  }
  Stop-Process -Id $processId -Force
  Write-Host "已停止服务：PID $processId（端口 $port）。"
}
