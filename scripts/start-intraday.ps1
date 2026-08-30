param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$Config = "config.json",
  [ValidateRange(1, 100)]
  [int]$KeepLogs = 20
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$configPath = if ([System.IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $resolvedRoot $Config }
$resolvedConfig = (Resolve-Path -LiteralPath $configPath).Path
if (-not $resolvedConfig.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to load an intraday config outside the project root."
}

$logsRoot = Join-Path $resolvedRoot "logs\intraday"
if (-not (Test-Path -LiteralPath $logsRoot)) {
  New-Item -ItemType Directory -Path $logsRoot | Out-Null
}
$resolvedLogs = (Resolve-Path -LiteralPath $logsRoot).Path
if (-not $resolvedLogs.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write intraday logs outside the project root."
}

$oldLogs = Get-ChildItem -LiteralPath $resolvedLogs -Filter "intraday-*.log" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip ([Math]::Max(0, $KeepLogs - 1))
foreach ($oldLog in $oldLogs) {
  $resolvedOld = (Resolve-Path -LiteralPath $oldLog.FullName).Path
  if ($resolvedOld.StartsWith($resolvedLogs, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedOld -Force
  }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $resolvedLogs "intraday-$stamp.log"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$sessionScript = Join-Path $resolvedRoot "scripts\intraday-session.js"
$keepAwakeScript = Join-Path $resolvedRoot "scripts\keep-awake.ps1"
if (-not (Test-Path -LiteralPath $sessionScript -PathType Leaf)) { throw "Intraday session entry point is missing." }
if (-not (Test-Path -LiteralPath $keepAwakeScript -PathType Leaf)) { throw "Keep-awake helper is missing." }

Set-Location -LiteralPath $resolvedRoot
. $keepAwakeScript
Enable-OceanWaveKeepAwake
$env:OCEAN_WAVE_EXTERNAL_KEEP_AWAKE = "1"
$intradayExit = 1
try {
  Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) launcher_start pid=$PID"
  $ErrorActionPreference = "Continue"
  & $node $sessionScript "--config" $resolvedConfig 2>&1 | ForEach-Object {
    Add-Content -LiteralPath $logPath -Encoding utf8 -Value ([string]$_)
  }
  $intradayExit = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
  Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) launcher_exit code=$intradayExit"
} finally {
  $ErrorActionPreference = "Stop"
  Remove-Item Env:OCEAN_WAVE_EXTERNAL_KEEP_AWAKE -ErrorAction SilentlyContinue
  Disable-OceanWaveKeepAwake
}
exit $intradayExit
