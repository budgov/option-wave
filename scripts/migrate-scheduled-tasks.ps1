[CmdletBinding()]
param(
  [ValidateSet("Status", "Stage", "PrepareCutover", "Activate", "Commit", "Rollback")]
  [string]$Phase = "Status",
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$RefreshBackup,
  [switch]$ConfirmSupervisorHealthy
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$SupervisorTaskName = "OceanWaveSupervisor"
$LegacyTaskNames = @(
  "OceanWaveTelegramListener",
  "OceanWaveTelegramWatchdog",
  "OceanWaveIntradayResearch",
  "OceanWaveIntradayWatchdog",
  "OceanWaveDailySol"
)
# Recovery authorities are disabled first, followed by timed jobs and finally
# the persistent listener. Disabling a definition never terminates its process.
$LegacyDisableOrder = @(
  "OceanWaveTelegramWatchdog",
  "OceanWaveIntradayWatchdog",
  "OceanWaveDailySol",
  "OceanWaveIntradayResearch",
  "OceanWaveTelegramListener"
)

$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$dataRoot = Join-Path $resolvedRoot "data"
$rollbackArchive = Join-Path $dataRoot "ocean-wave-legacy-tasks-rollback.zip"
$rollbackManifest = Join-Path $dataRoot "ocean-wave-legacy-tasks-manifest.json"
$installer = Join-Path $resolvedRoot "scripts\install-tasks.ps1"
$supervisorExecutable = Join-Path $resolvedRoot "bin\OceanWaveSupervisor.exe"
$supervisorHashFile = "$supervisorExecutable.sha256"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Get-RootTask {
  param([Parameter(Mandatory)][string]$Name, [switch]$AllowMissing)
  try {
    return Get-ScheduledTask -TaskPath "\" -TaskName $Name -ErrorAction Stop
  }
  catch {
    if ($AllowMissing.IsPresent) { return $null }
    throw "Required root Task Scheduler entry '$Name' was not found."
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Utf8File {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Write-TaskXmlFile {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
  # Export-ScheduledTask declares UTF-16, so retain that exact wire encoding in
  # the rollback artifact rather than creating an encoding/declaration mismatch.
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.Encoding]::Unicode)
}

function Read-RegularJsonFile {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "Runtime control path must be a regular non-symlink file: $Path"
  }
  if ($item.Length -le 0 -or $item.Length -gt 1MB) {
    throw "Runtime control JSON has an invalid size: $Path"
  }

  $shareMode = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $shareMode)
  $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
  try {
    $content = $reader.ReadToEnd()
  }
  finally {
    $reader.Dispose()
    $stream.Dispose()
  }
  try {
    $record = $content | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "Runtime control file is not valid JSON: $Path"
  }
  if ($null -eq $record -or $record -is [System.Array] -or $record -is [string] -or $record -is [ValueType]) {
    throw "Runtime control JSON must contain one object: $Path"
  }
  return $record
}

function Get-RequiredRecordString {
  param(
    [Parameter(Mandatory)]$Record,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Path
  )
  $property = $Record.PSObject.Properties[$Name]
  if ($null -eq $property -or $property.Value -isnot [string]) {
    throw "Runtime control file is missing '$Name': $Path"
  }
  $value = [string]$property.Value
  if ([string]::IsNullOrWhiteSpace($value) -or $value.Length -gt 128) {
    throw "Runtime control file has an invalid '$Name': $Path"
  }
  return $value
}

function Get-RequiredRecordProcessId {
  param(
    [Parameter(Mandatory)]$Record,
    [Parameter(Mandatory)][string]$Path
  )
  $property = $Record.PSObject.Properties["pid"]
  $processId = 0
  if ($null -eq $property -or
      ($property.Value -isnot [int] -and $property.Value -isnot [long]) -or
      -not [int]::TryParse([string]$property.Value, [ref]$processId) -or $processId -le 0) {
    throw "Runtime control file has an invalid positive PID: $Path"
  }
  return $processId
}

function Test-RecordedProcessAlive {
  param([Parameter(Mandatory)][int]$ProcessId)
  try {
    $recordedProcess = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    try { return -not $recordedProcess.HasExited }
    finally { $recordedProcess.Dispose() }
  }
  catch [System.ArgumentException] {
    return $false
  }
  catch {
    throw "Unable to verify recorded process PID $ProcessId; migration remains fail-closed."
  }
}

function Get-ValidatedRuntimeIdentity {
  param(
    [Parameter(Mandatory)][string]$Label,
    [Parameter(Mandatory)][string]$StateFile,
    [Parameter(Mandatory)][string]$OwnerFile,
    [Parameter(Mandatory)][string]$StateSchema,
    [Parameter(Mandatory)][string]$OwnerSchema
  )
  $statePath = Join-Path $dataRoot $StateFile
  $ownerPath = Join-Path $dataRoot $OwnerFile
  $state = Read-RegularJsonFile -Path $statePath
  $owner = Read-RegularJsonFile -Path $ownerPath
  if ($null -eq $state -and $null -eq $owner) {
    return [pscustomobject][ordered]@{
      label = $Label
      present = $false
      instance_id = $null
      pid = $null
      status = "absent"
      owner_present = $false
      requires_process_exit = $false
    }
  }
  if ($null -eq $state -and $null -ne $owner) {
    throw "$Label ownership exists without matching runtime state."
  }

  $stateSchemaValue = Get-RequiredRecordString -Record $state -Name "schema_version" -Path $statePath
  $stateInstance = Get-RequiredRecordString -Record $state -Name "instance_id" -Path $statePath
  $stateStatus = Get-RequiredRecordString -Record $state -Name "status" -Path $statePath
  $stateProcessId = Get-RequiredRecordProcessId -Record $state -Path $statePath
  if ($stateSchemaValue -ne $StateSchema) {
    throw "$Label runtime state has an unsupported schema."
  }
  if ($stateStatus -notin @("stopped", "failed", "starting", "ready", "running", "stopping", "draining")) {
    throw "$Label runtime state has an unsupported status."
  }

  if ($null -ne $owner) {
    $ownerSchemaValue = Get-RequiredRecordString -Record $owner -Name "schema_version" -Path $ownerPath
    $ownerInstance = Get-RequiredRecordString -Record $owner -Name "instance_id" -Path $ownerPath
    $ownerProcessId = Get-RequiredRecordProcessId -Record $owner -Path $ownerPath
    if ($ownerSchemaValue -ne $OwnerSchema) {
      throw "$Label ownership has an unsupported schema."
    }
    if ($ownerInstance -ne $stateInstance -or $ownerProcessId -ne $stateProcessId) {
      throw "$Label runtime state and ownership do not identify the same instance and PID."
    }
  }

  if ($null -eq $owner -and $stateStatus -notin @("stopped", "failed")) {
    throw "$Label non-terminal runtime state is missing its ownership file."
  }
  return [pscustomobject][ordered]@{
    label = $Label
    present = $true
    instance_id = $stateInstance
    pid = $stateProcessId
    status = $stateStatus
    owner_present = ($null -ne $owner)
    requires_process_exit = (($null -ne $owner) -or $stateStatus -notin @("stopped", "failed"))
  }
}

function Get-ValidatedRuntimeIdentities {
  return @(
    Get-ValidatedRuntimeIdentity `
      -Label "Listener" `
      -StateFile "listener-runtime.json" `
      -OwnerFile "listener-owner.lock" `
      -StateSchema "listener-runtime.v1" `
      -OwnerSchema "listener-owner.v1"
    Get-ValidatedRuntimeIdentity `
      -Label "Intraday" `
      -StateFile "intraday-runtime.json" `
      -OwnerFile "intraday-owner.lock" `
      -StateSchema "intraday-runtime.v1" `
      -OwnerSchema "intraday-owner.v1"
  )
}

function Assert-NoLiveLegacyRuntimes {
  foreach ($identity in @(Get-ValidatedRuntimeIdentities)) {
    if ($identity.present -and $identity.requires_process_exit -and
        (Test-RecordedProcessAlive -ProcessId ([int]$identity.pid))) {
      throw "$($identity.label) runtime PID $($identity.pid) is still alive. Complete graceful shutdown before migration."
    }
  }
}

function Assert-CapturedLegacyRuntimesStopped {
  param([Parameter(Mandatory)]$Manifest)
  $captured = @($Manifest.legacy_runtimes)
  if ($captured.Count -ne 2) {
    throw "Rollback manifest must contain exactly two legacy runtime identities."
  }
  foreach ($label in @("Listener", "Intraday")) {
    $matches = @($captured | Where-Object { $_.label -eq $label })
    if ($matches.Count -ne 1) {
      throw "Rollback manifest is missing the exact legacy runtime identity '$label'."
    }
    $record = $matches[0]
    if ($record.present -isnot [bool] -or $record.owner_present -isnot [bool]) {
      throw "Rollback manifest contains invalid runtime presence flags for '$label'."
    }
    if ([bool]$record.present) {
      $instance = [string]$record.instance_id
      $status = [string]$record.status
      $capturedProcessId = 0
      if ([string]::IsNullOrWhiteSpace($instance) -or $instance.Length -gt 128 -or
          $status -notin @("stopped", "failed", "starting", "ready", "running", "stopping", "draining") -or
          -not [int]::TryParse([string]$record.pid, [ref]$capturedProcessId) -or $capturedProcessId -le 0) {
        throw "Rollback manifest contains an invalid captured runtime identity for '$label'."
      }
      $requiresExitCheck = ([bool]$record.owner_present) -or $status -notin @("stopped", "failed")
      if ($requiresExitCheck -and (Test-RecordedProcessAlive -ProcessId $capturedProcessId)) {
        throw "Captured legacy $label PID $capturedProcessId is still alive."
      }
    }
  }
}

function Assert-SupervisorArtifact {
  foreach ($requiredFile in @($supervisorExecutable, $supervisorHashFile)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
      throw "Required supervisor artifact is missing: $requiredFile"
    }
  }
  $hashDocument = Get-Content -LiteralPath $supervisorHashFile -Raw
  if ($hashDocument -notmatch '(?i)\A\s*([0-9a-f]{64})(?:\s+\*?[^\r\n]+)?\s*\z') {
    throw "Supervisor SHA-256 sidecar is invalid."
  }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $actualHash = Get-Sha256 -Path $supervisorExecutable
  if ($actualHash -ne $expectedHash) {
    throw "Supervisor executable SHA-256 verification failed."
  }
  return $actualHash
}

function New-RollbackArchive {
  if ((Test-Path -LiteralPath $rollbackArchive) -or (Test-Path -LiteralPath $rollbackManifest)) {
    if (-not $RefreshBackup.IsPresent) {
      throw "Rollback artifacts already exist. Reuse them or pass -RefreshBackup to replace them deliberately."
    }
  }

  New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
  $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ocean-wave-task-backup-" + [guid]::NewGuid().ToString("N"))
  $temporaryArchive = Join-Path ([System.IO.Path]::GetTempPath()) ("ocean-wave-task-backup-" + [guid]::NewGuid().ToString("N") + ".zip")
  New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

  try {
    $taskRecords = @()
    foreach ($taskName in $LegacyTaskNames) {
      $task = Get-RootTask -Name $taskName
      $entryName = "$taskName.xml"
      $entryPath = Join-Path $temporaryRoot $entryName
      $xml = Export-ScheduledTask -TaskPath "\" -TaskName $taskName -ErrorAction Stop
      Write-TaskXmlFile -Path $entryPath -Content $xml
      $taskRecords += [ordered]@{
        name = $taskName
        entry = $entryName
        sha256 = Get-Sha256 -Path $entryPath
        was_enabled = ($task.State -ne "Disabled")
      }
    }
    $legacyRuntimeRecords = @(Get-ValidatedRuntimeIdentities)

    $internalManifest = [ordered]@{
      schema_version = "ocean-wave.scheduled-task-rollback.v1"
      created_at_utc = [DateTime]::UtcNow.ToString("o")
      project_root = $resolvedRoot
      user = $currentUser
      tasks = $taskRecords
      legacy_runtimes = $legacyRuntimeRecords
    }
    $internalManifestPath = Join-Path $temporaryRoot "manifest.json"
    Write-Utf8File -Path $internalManifestPath -Content ($internalManifest | ConvertTo-Json -Depth 6)
    $internalManifestHash = Get-Sha256 -Path $internalManifestPath

    $archiveInputs = @(Get-ChildItem -LiteralPath $temporaryRoot -File | ForEach-Object { $_.FullName })
    Compress-Archive -LiteralPath $archiveInputs -DestinationPath $temporaryArchive -CompressionLevel Optimal
    $archiveHash = Get-Sha256 -Path $temporaryArchive
    $externalManifest = [ordered]@{
      schema_version = "ocean-wave.scheduled-task-rollback.v1"
      archive_file = [System.IO.Path]::GetFileName($rollbackArchive)
      archive_sha256 = $archiveHash
      internal_manifest_sha256 = $internalManifestHash
      created_at_utc = $internalManifest.created_at_utc
      project_root = $resolvedRoot
      user = $currentUser
      tasks = $taskRecords
      legacy_runtimes = $legacyRuntimeRecords
    }
    $temporaryManifest = Join-Path $dataRoot ("." + [System.IO.Path]::GetFileName($rollbackManifest) + ".tmp")
    Write-Utf8File -Path $temporaryManifest -Content ($externalManifest | ConvertTo-Json -Depth 6)

    Move-Item -LiteralPath $temporaryArchive -Destination $rollbackArchive -Force
    Move-Item -LiteralPath $temporaryManifest -Destination $rollbackManifest -Force
  }
  finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
      Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $temporaryArchive) {
      Remove-Item -LiteralPath $temporaryArchive -Force
    }
  }
}

function Assert-RollbackArchive {
  if (-not (Test-Path -LiteralPath $rollbackArchive -PathType Leaf) -or
      -not (Test-Path -LiteralPath $rollbackManifest -PathType Leaf)) {
    throw "Rollback archive and manifest must both exist before this phase."
  }
  $manifest = Get-Content -LiteralPath $rollbackManifest -Raw | ConvertFrom-Json
  if ($manifest.schema_version -ne "ocean-wave.scheduled-task-rollback.v1") {
    throw "Rollback manifest schema is not supported."
  }
  if ($manifest.project_root -ne $resolvedRoot -or $manifest.user -ne $currentUser) {
    throw "Rollback manifest belongs to a different project root or Windows user."
  }
  if ((Get-Sha256 -Path $rollbackArchive) -ne $manifest.archive_sha256) {
    throw "Rollback archive SHA-256 verification failed."
  }

  $records = @($manifest.tasks)
  if ($records.Count -ne $LegacyTaskNames.Count) {
    throw "Rollback manifest does not contain exactly five legacy task records."
  }
  foreach ($taskName in $LegacyTaskNames) {
    if (@($records | Where-Object { $_.name -eq $taskName }).Count -ne 1) {
      throw "Rollback manifest is missing the exact task '$taskName'."
    }
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($rollbackArchive)
  try {
    $expectedEntries = @($records | ForEach-Object { [string]$_.entry }) + @("manifest.json")
    $actualEntries = @($archive.Entries | ForEach-Object { $_.FullName })
    if ($actualEntries.Count -ne $expectedEntries.Count) {
      throw "Rollback archive contains an unexpected number of files."
    }
    foreach ($entryName in $expectedEntries) {
      if (@($actualEntries | Where-Object { $_ -eq $entryName }).Count -ne 1) {
        throw "Rollback archive is missing the exact entry '$entryName'."
      }
    }

    foreach ($record in $records) {
      $entry = $archive.GetEntry([string]$record.entry)
      $stream = $entry.Open()
      $sha256 = [System.Security.Cryptography.SHA256]::Create()
      try {
        $entryHash = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
      }
      finally {
        $sha256.Dispose()
        $stream.Dispose()
      }
      if ($entryHash -ne $record.sha256) {
        throw "Rollback XML SHA-256 verification failed for '$($record.name)'."
      }
    }

    $internalEntry = $archive.GetEntry("manifest.json")
    $internalStream = $internalEntry.Open()
    $internalSha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $internalHash = ([BitConverter]::ToString($internalSha.ComputeHash($internalStream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
      $internalSha.Dispose()
      $internalStream.Dispose()
    }
    if ($internalHash -ne $manifest.internal_manifest_sha256) {
      throw "Rollback internal manifest SHA-256 verification failed."
    }
  }
  finally {
    $archive.Dispose()
  }
  return $manifest
}

function Assert-SupervisorTask {
  param([switch]$RequireDisabled)
  $task = Get-RootTask -Name $SupervisorTaskName
  if (@($task.Actions).Count -ne 1) {
    throw "Supervisor task must contain exactly one action."
  }
  if ([System.IO.Path]::GetFullPath($task.Actions[0].Execute) -ne [System.IO.Path]::GetFullPath($supervisorExecutable)) {
    throw "Supervisor task action must execute the native launcher directly."
  }
  if ($task.Actions[0].Execute -match '(?i)powershell|pwsh') {
    throw "Supervisor task must not launch a shell."
  }
  if ($RequireDisabled.IsPresent -and $task.State -ne "Disabled") {
    throw "Supervisor task must remain disabled until activation."
  }
  return $task
}

function Read-ArchiveEntryText {
  param([Parameter(Mandatory)][string]$EntryName)
  $archive = [System.IO.Compression.ZipFile]::OpenRead($rollbackArchive)
  try {
    $entry = $archive.GetEntry($EntryName)
    if ($null -eq $entry) { throw "Rollback entry '$EntryName' is missing." }
    $stream = $entry.Open()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    try { return $reader.ReadToEnd() }
    finally { $reader.Dispose(); $stream.Dispose() }
  }
  finally {
    $archive.Dispose()
  }
}

switch ($Phase) {
  "Status" {
    $allNames = @($SupervisorTaskName) + $LegacyTaskNames
    foreach ($taskName in $allNames) {
      $task = Get-RootTask -Name $taskName -AllowMissing
      [pscustomobject]@{
        TaskName = $taskName
        Present = ($null -ne $task)
        State = if ($null -eq $task) { "Missing" } else { [string]$task.State }
      }
    }
  }

  "Stage" {
    Assert-SupervisorArtifact | Out-Null
    New-RollbackArchive
    & $installer -ProjectRoot $resolvedRoot -InstallDisabled
    Assert-SupervisorTask -RequireDisabled | Out-Null
    Write-Output "Staged one disabled native supervisor task. Legacy tasks and running processes are unchanged."
  }

  "PrepareCutover" {
    Assert-RollbackArchive | Out-Null
    Assert-SupervisorArtifact | Out-Null
    Assert-SupervisorTask -RequireDisabled | Out-Null
    foreach ($taskName in $LegacyDisableOrder) {
      Disable-ScheduledTask -TaskPath "\" -TaskName $taskName -ErrorAction Stop | Out-Null
    }
    Write-Output "Disabled all legacy task definitions in recovery-first order. No running process was terminated."
  }

  "Activate" {
    $manifest = Assert-RollbackArchive
    Assert-SupervisorArtifact | Out-Null
    $supervisorTask = Assert-SupervisorTask -RequireDisabled
    foreach ($taskName in $LegacyTaskNames) {
      $legacyTask = Get-RootTask -Name $taskName
      if ($legacyTask.State -eq "Running") {
        throw "Legacy task '$taskName' is still running. Complete its graceful shutdown before activation."
      }
      if ($legacyTask.State -ne "Disabled") {
        throw "Legacy task '$taskName' must be disabled before activation."
      }
    }
    Assert-NoLiveLegacyRuntimes
    Assert-CapturedLegacyRuntimesStopped -Manifest $manifest
    Enable-ScheduledTask -InputObject $supervisorTask | Out-Null
    Start-ScheduledTask -TaskPath "\" -TaskName $SupervisorTaskName
    Write-Output "Activated the native supervisor. Legacy task definitions remain disabled for rollback."
  }

  "Commit" {
    if (-not $ConfirmSupervisorHealthy.IsPresent) {
      throw "Commit requires -ConfirmSupervisorHealthy after external heartbeat and data-source verification."
    }
    $manifest = Assert-RollbackArchive
    $supervisorTask = Assert-SupervisorTask
    if ($supervisorTask.State -ne "Running") {
      throw "Supervisor task is not running; commit is refused."
    }
    # At commit the current control files normally belong to the new supervisor
    # children. Validate their regular-file and ownership invariants, then use
    # the staged identities to prove the legacy PIDs themselves are gone.
    Get-ValidatedRuntimeIdentities | Out-Null
    Assert-CapturedLegacyRuntimesStopped -Manifest $manifest
    foreach ($taskName in $LegacyTaskNames) {
      $legacyTask = Get-RootTask -Name $taskName -AllowMissing
      if ($null -ne $legacyTask -and $legacyTask.State -eq "Running") {
        throw "Legacy task '$taskName' is still running; commit is refused."
      }
    }
    foreach ($taskName in $LegacyTaskNames) {
      if ($null -ne (Get-RootTask -Name $taskName -AllowMissing)) {
        Unregister-ScheduledTask -TaskPath "\" -TaskName $taskName -Confirm:$false
      }
    }
    Write-Output "Committed migration. The verified rollback archive was retained in data."
  }

  "Rollback" {
    $manifest = Assert-RollbackArchive
    $supervisorTask = Get-RootTask -Name $SupervisorTaskName -AllowMissing
    if ($null -ne $supervisorTask -and $supervisorTask.State -eq "Running") {
      throw "Supervisor is still running. Request its graceful shutdown before rollback."
    }
    if ($null -ne $supervisorTask) {
      Unregister-ScheduledTask -TaskPath "\" -TaskName $SupervisorTaskName -Confirm:$false
    }
    foreach ($record in @($manifest.tasks)) {
      $xml = Read-ArchiveEntryText -EntryName ([string]$record.entry)
      Register-ScheduledTask -TaskPath "\" -TaskName ([string]$record.name) -Xml $xml -Force | Out-Null
      if ([bool]$record.was_enabled) {
        Enable-ScheduledTask -TaskPath "\" -TaskName ([string]$record.name) | Out-Null
      }
      else {
        Disable-ScheduledTask -TaskPath "\" -TaskName ([string]$record.name) | Out-Null
      }
    }
    Write-Output "Restored the five verified legacy task definitions. No task was started automatically."
  }
}
