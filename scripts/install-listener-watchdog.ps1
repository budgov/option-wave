param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$TaskName = "OceanWaveTelegramWatchdog"
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$watchdogScript = Join-Path $resolvedRoot "scripts\watch-listener.ps1"
if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) { throw "Listener watchdog launcher is missing." }

$action = New-ScheduledTaskAction `
  -Execute $powershell `
  -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$watchdogScript`" -ProjectRoot `"$resolvedRoot`"" `
  -WorkingDirectory $resolvedRoot
$minuteTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 1 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
# This one-minute watchdog only reads local state and controls an existing
# scheduled task. Run it outside the interactive desktop so powershell.exe
# cannot flash a console window before -WindowStyle Hidden takes effect.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger @($minuteTrigger, $logonTrigger) `
  -Settings $settings `
  -Principal $principal `
  -Description "Checks the Ocean Wave Telegram listener heartbeat and requests bounded recovery only when no managed listener process is alive." `
  -Force | Out-Null
Write-Output "Installed $TaskName (every minute and at logon)."
