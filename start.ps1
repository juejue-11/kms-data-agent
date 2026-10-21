# 启动 kms-data-agent 后端（参考 PCB-agent/start.ps1）
# 用法: .\start.ps1
# 停止: .\stop.ps1（或在本终端按 Ctrl+C）
# 需要 .env；模型配置在 .pi-agent/ 下（settings.json / auth.json）

$ErrorActionPreference = "Stop"

# PI_CODING_AGENT_DIR 必须解析为绝对路径，相对路径在 Pi 内部会按 cwd 解释
$env:PI_CODING_AGENT_DIR = Join-Path $PSScriptRoot ".pi-agent"

# 切到脚本所在目录，保证 .env 与 Pi 的资源加载（process.cwd()）都以项目根为准
Set-Location -LiteralPath $PSScriptRoot

node --env-file=.env server.js
