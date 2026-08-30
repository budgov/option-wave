param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(1, 100)]
  [int]$KeepLogs = 20
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$logsRoot = Join-Path $resolvedRoot "logs\daily"
if (-not (Test-Path -LiteralPath $logsRoot)) {
  New-Item -ItemType Directory -Path $logsRoot | Out-Null
}
$resolvedLogs = (Resolve-Path -LiteralPath $logsRoot).Path
if (-not $resolvedLogs.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write daily logs outside the project root."
}

$oldLogs = Get-ChildItem -LiteralPath $resolvedLogs -Filter "daily-*.log" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip ([Math]::Max(0, $KeepLogs - 1))
foreach ($oldLog in $oldLogs) {
  $resolvedOld = (Resolve-Path -LiteralPath $oldLog.FullName).Path
  if ($resolvedOld.StartsWith($resolvedLogs, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedOld -Force
  }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $resolvedLogs "daily-$stamp.log"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$dailyEntry = Join-Path $resolvedRoot "src\cli.js"
$keepAwakeScript = Join-Path $resolvedRoot "scripts\keep-awake.ps1"
if (-not (Test-Path -LiteralPath $dailyEntry -PathType Leaf)) { throw "Daily entry point is missing." }
if (-not (Test-Path -LiteralPath $keepAwakeScript -PathType Leaf)) { throw "Keep-awake helper is missing." }

Set-Location -LiteralPath $resolvedRoot
. $keepAwakeScript
Enable-OceanWaveKeepAwake
$dailyExit = 1
try {
  Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) launcher_start pid=$PID"
  $ErrorActionPreference = "Continue"
  & $node $dailyEntry "daily" "--today-only" 2>&1 | ForEach-Object {
    Add-Content -LiteralPath $logPath -Encoding utf8 -Value ([string]$_)
  }
  $dailyExit = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
  Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) launcher_exit code=$dailyExit"
} finally {
  $ErrorActionPreference = "Stop"
  Disable-OceanWaveKeepAwake
}
exit $dailyExit
