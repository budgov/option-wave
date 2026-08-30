[CmdletBinding()]
param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$InstallDisabled
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$TaskName = "OceanWaveSupervisor"
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not [System.IO.Path]::IsPathRooted($resolvedRoot)) {
  throw "ProjectRoot must resolve to an absolute path."
}
if ($resolvedRoot.Contains('"')) {
  throw "ProjectRoot contains an unsupported quote character."
}

$supervisorExecutable = Join-Path $resolvedRoot "bin\OceanWaveSupervisor.exe"
$supervisorHashFile = "$supervisorExecutable.sha256"
$configPath = Join-Path $resolvedRoot "config.json"

foreach ($requiredFile in @($supervisorExecutable, $supervisorHashFile, $configPath)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required supervisor artifact is missing: $requiredFile"
  }
}

$hashDocument = Get-Content -LiteralPath $supervisorHashFile -Raw
$hashPattern = '(?i)\A\s*([0-9a-f]{64})(?:\s+\*?[^\r\n]+)?\s*\z'
if ($hashDocument -notmatch $hashPattern) {
  throw "Supervisor SHA-256 sidecar must contain one 64-character hash."
}
$expectedHash = $Matches[1].ToUpperInvariant()
$actualHash = (Get-FileHash -LiteralPath $supervisorExecutable -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actualHash -ne $expectedHash) {
  throw "Supervisor executable SHA-256 verification failed. Expected $expectedHash but found $actualHash."
}

$fileStream = [System.IO.File]::Open($supervisorExecutable, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  if (($fileStream.ReadByte() -ne 0x4d) -or ($fileStream.ReadByte() -ne 0x5a)) {
    throw "Supervisor artifact is not a Windows PE executable."
  }
}
finally {
  $fileStream.Dispose()
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction `
  -Execute $supervisorExecutable `
  -Argument "--project-root `"$resolvedRoot`" --config `"$configPath`"" `
  -WorkingDirectory $resolvedRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

$settingsParameters = @{
  StartWhenAvailable = $true
  RestartCount = 3
  RestartInterval = (New-TimeSpan -Minutes 1)
  AllowStartIfOnBatteries = $true
  DontStopIfGoingOnBatteries = $true
  MultipleInstances = "IgnoreNew"
  ExecutionTimeLimit = (New-TimeSpan -Days 3650)
  Hidden = $true
  DisallowHardTerminate = $true
}
if ($InstallDisabled.IsPresent) {
  $settingsParameters.Disable = $true
}
$settings = New-ScheduledTaskSettingsSet @settingsParameters

Register-ScheduledTask `
  -TaskPath "\" `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Windowless Ocean Wave supervisor for the listener, market-session research, and daily review." `
  -Force | Out-Null

$registeredTask = Get-ScheduledTask -TaskPath "\" -TaskName $TaskName -ErrorAction Stop
if (@($registeredTask.Actions).Count -ne 1 -or $registeredTask.Actions[0].Execute -ne $supervisorExecutable) {
  throw "Installed supervisor task did not preserve its direct executable action."
}
if ($InstallDisabled.IsPresent -and $registeredTask.State -ne "Disabled") {
  Disable-ScheduledTask -TaskPath "\" -TaskName $TaskName | Out-Null
}

$mode = if ($InstallDisabled.IsPresent) { "disabled for staged migration" } else { "enabled" }
Write-Output "Installed $TaskName ($mode, current-user logon, SHA-256 $actualHash)."
