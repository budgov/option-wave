param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(1, 100)]
  [int]$KeepLogs = 10
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$logsRoot = Join-Path $resolvedRoot "logs"
if (-not (Test-Path -LiteralPath $logsRoot)) {
  New-Item -ItemType Directory -Path $logsRoot | Out-Null
}
$resolvedLogs = (Resolve-Path -LiteralPath $logsRoot).Path
if (-not $resolvedLogs.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write logs outside the project root."
}

$oldLogs = Get-ChildItem -LiteralPath $resolvedLogs -Filter "listener-*.log" -File |
  Sort-Object LastWriteTime -Descending |
  # Keep room for the log created below so the steady-state count is exactly
  # KeepLogs rather than KeepLogs + 1.
  Select-Object -Skip ([Math]::Max(0, $KeepLogs - 1))
foreach ($oldLog in $oldLogs) {
  $resolvedOld = (Resolve-Path -LiteralPath $oldLog.FullName).Path
  if ($resolvedOld.StartsWith($resolvedLogs, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedOld -Force
  }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $resolvedLogs "listener-$stamp.log"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$keepAwakeScript = Join-Path $resolvedRoot "scripts\keep-awake.ps1"
if (-not (Test-Path -LiteralPath $keepAwakeScript -PathType Leaf)) {
  throw "Keep-awake helper is missing."
}
Set-Location -LiteralPath $resolvedRoot

. $keepAwakeScript
Enable-OceanWaveKeepAwake
$env:OCEAN_WAVE_EXTERNAL_KEEP_AWAKE = "1"
$listenerExit = 1
try {
  Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) launcher_start pid=$PID"
  # Windows PowerShell represents native stderr as ErrorRecord objects. Keep
  # stderr in the log without letting an ordinary diagnostic kill the task.
  $ErrorActionPreference = "Continue"
  # Windows PowerShell 5 redirects native output as UTF-16 even when the file
  # was created as UTF-8. Stream each line through one UTF-8 writer so Chinese
  # channel names and diagnostics remain readable without repeated file opens.
  $logWriter = New-Object System.IO.StreamWriter($logPath, $true, $utf8)
  try {
    & $node "src/cli.js" "listen" 2>&1 | ForEach-Object {
      $logWriter.WriteLine($_.ToString())
      $logWriter.Flush()
    }
  } finally {
    $logWriter.Dispose()
  }
  $listenerExit = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
  Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) launcher_exit code=$listenerExit"
} finally {
  $ErrorActionPreference = "Stop"
  Remove-Item Env:OCEAN_WAVE_EXTERNAL_KEEP_AWAKE -ErrorAction SilentlyContinue
  Disable-OceanWaveKeepAwake
}
exit $listenerExit
