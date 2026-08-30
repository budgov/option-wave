param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$Config = "config.json",
  [string]$TaskName = "OceanWaveIntradayResearch",
  [ValidateRange(1, 100)]
  [int]$KeepLogs = 10
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$configPath = if ([System.IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $resolvedRoot $Config }
$resolvedConfig = (Resolve-Path -LiteralPath $configPath).Path
if (-not $resolvedConfig.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to load an intraday config outside the project root."
}
$logsRoot = Join-Path $resolvedRoot "logs\intraday"
if (-not (Test-Path -LiteralPath $logsRoot)) { New-Item -ItemType Directory -Path $logsRoot | Out-Null }
$resolvedLogs = (Resolve-Path -LiteralPath $logsRoot).Path
if (-not $resolvedLogs.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write watchdog logs outside the project root."
}
$oldLogs = Get-ChildItem -LiteralPath $resolvedLogs -Filter "watchdog-*.log" -File |
  Sort-Object LastWriteTime -Descending |
  # Reserve one slot for a new day's log so the steady-state count is exact.
  Select-Object -Skip ([Math]::Max(0, $KeepLogs - 1))
foreach ($oldLog in $oldLogs) {
  $resolvedOld = (Resolve-Path -LiteralPath $oldLog.FullName).Path
  if ($resolvedOld.StartsWith($resolvedLogs, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedOld -Force
  }
}
$logPath = Join-Path $resolvedLogs "watchdog-$(Get-Date -Format 'yyyyMMdd').log"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$watchdogScript = Join-Path $resolvedRoot "scripts\intraday-watchdog.js"
if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) { throw "Intraday watchdog entry point is missing." }

Set-Location -LiteralPath $resolvedRoot
$output = & $node $watchdogScript "--config" $resolvedConfig "--claim-restart"
if ($LASTEXITCODE -ne 0) { throw "Intraday watchdog inspection failed with exit code $LASTEXITCODE." }
$json = @($output)[-1]
Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) inspection=$json"
$result = $json | ConvertFrom-Json -ErrorAction Stop
if ($result.restart_recommended -ne $true -or $result.restart_claimed -ne $true) { exit 0 }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ($task.State -ne "Running") {
  try {
    Start-ScheduledTask -TaskName $TaskName
    $confirmed = & $node $watchdogScript "--config" $resolvedConfig "--confirm-claim" $result.claim_id
    if ($LASTEXITCODE -ne 0) { throw "Unable to confirm watchdog restart claim." }
    Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) restart_requested task=$TaskName reason=$($result.status) claim=$($result.claim_id) confirmation=$confirmed"
  } catch {
    $released = & $node $watchdogScript "--config" $resolvedConfig "--release-claim" $result.claim_id
    Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) restart_failed task=$TaskName claim=$($result.claim_id) release=$released error=$($_.Exception.Message)"
    throw
  }
}
exit 0
