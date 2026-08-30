import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installer = fs.readFileSync(path.join(ROOT, "scripts", "install-tasks.ps1"), "utf8");
const migration = fs.readFileSync(path.join(ROOT, "scripts", "migrate-scheduled-tasks.ps1"), "utf8");

function orderedIndexes(source, values) {
  let prior = -1;
  for (const value of values) {
    const current = source.indexOf(value, prior + 1);
    assert.ok(current > prior, `expected ${value} after prior migration step`);
    prior = current;
  }
}

test("installer registers one direct native bootstrap at current-user logon", () => {
  assert.equal(installer.match(/Register-ScheduledTask/g)?.length, 1);
  assert.match(installer, /\$TaskName\s*=\s*"OceanWaveSupervisor"/);
  assert.match(installer, /bin\\OceanWaveSupervisor\.exe/);
  assert.match(installer, /New-ScheduledTaskAction\s+`[\s\S]*?-Execute \$supervisorExecutable/);
  assert.match(installer, /New-ScheduledTaskTrigger -AtLogOn -User \$currentUser/);
  assert.match(installer, /New-ScheduledTaskPrincipal -UserId \$currentUser -LogonType Interactive -RunLevel Limited/);
  assert.doesNotMatch(installer, /powershell\.exe|pwsh\.exe|-Weekly|-Once|-RepetitionInterval/i);
});

test("native bootstrap policy is windowless, bounded, battery-safe, and single-instance", () => {
  assert.match(installer, /StartWhenAvailable\s*=\s*\$true/);
  assert.match(installer, /RestartCount\s*=\s*3/);
  assert.match(installer, /RestartInterval\s*=\s*\(New-TimeSpan -Minutes 1\)/);
  assert.match(installer, /AllowStartIfOnBatteries\s*=\s*\$true/);
  assert.match(installer, /DontStopIfGoingOnBatteries\s*=\s*\$true/);
  assert.match(installer, /MultipleInstances\s*=\s*"IgnoreNew"/);
  assert.match(installer, /Hidden\s*=\s*\$true/);
  assert.match(installer, /DisallowHardTerminate\s*=\s*\$true/);
  assert.doesNotMatch(installer, /RunOnlyIfNetworkAvailable/);
});

test("installer fails closed unless the prebuilt PE matches its SHA-256 sidecar", () => {
  assert.match(installer, /\$supervisorHashFile\s*=\s*"\$supervisorExecutable\.sha256"/);
  assert.match(installer, /Get-FileHash -LiteralPath \$supervisorExecutable -Algorithm SHA256/);
  assert.match(installer, /actualHash -ne \$expectedHash/);
  assert.match(installer, /ReadByte\(\) -ne 0x4d/);
  assert.match(installer, /ReadByte\(\) -ne 0x5a/);
  assert.match(installer, /\[switch\]\$InstallDisabled/);
  assert.match(installer, /\$settingsParameters\.Disable = \$true/);
});

test("migration has explicit non-destructive staging and activation gates", () => {
  for (const phase of ["Status", "Stage", "PrepareCutover", "Activate", "Commit", "Rollback"]) {
    assert.match(migration, new RegExp(`"${phase}"`));
  }
  assert.match(migration, /& \$installer -ProjectRoot \$resolvedRoot -InstallDisabled/);
  assert.match(migration, /Legacy tasks and running processes are unchanged/);
  assert.match(migration, /No running process was terminated/);
  assert.match(migration, /Complete its graceful shutdown before activation/);
  assert.match(migration, /Commit requires -ConfirmSupervisorHealthy/);
  assert.doesNotMatch(migration, /Stop-ScheduledTask|Stop-Process|taskkill/i);
});

test("migration exports and verifies exactly the five legacy task definitions", () => {
  const legacyBlock = migration.slice(
    migration.indexOf("$LegacyTaskNames = @("),
    migration.indexOf("$LegacyDisableOrder = @(")
  );
  const names = [
    "OceanWaveTelegramListener",
    "OceanWaveTelegramWatchdog",
    "OceanWaveIntradayResearch",
    "OceanWaveIntradayWatchdog",
    "OceanWaveDailySol"
  ];
  for (const name of names) assert.match(legacyBlock, new RegExp(`"${name}"`));
  assert.equal(legacyBlock.match(/"OceanWave[^"\r\n]+"/g)?.length, 5);
  assert.match(migration, /Export-ScheduledTask/);
  assert.match(migration, /Get-FileHash -LiteralPath \$Path -Algorithm SHA256/);
  assert.match(migration, /Compress-Archive/);
  assert.match(migration, /ocean-wave-legacy-tasks-rollback\.zip/);
  assert.match(migration, /ocean-wave-legacy-tasks-manifest\.json/);
  assert.match(migration, /internal_manifest_sha256/);
  assert.match(migration, /Rollback XML SHA-256 verification failed/);
  assert.doesNotMatch(migration, /Get-Date.*ToString|yyyy|MM-dd|yyyyMMdd/i);
});

test("legacy recovery definitions are disabled before producers and listener", () => {
  const orderBlock = migration.slice(
    migration.indexOf("$LegacyDisableOrder = @("),
    migration.indexOf("$resolvedRoot =")
  );
  orderedIndexes(orderBlock, [
    '"OceanWaveTelegramWatchdog"',
    '"OceanWaveIntradayWatchdog"',
    '"OceanWaveDailySol"',
    '"OceanWaveIntradayResearch"',
    '"OceanWaveTelegramListener"'
  ]);
  assert.match(migration, /foreach \(\$taskName in \$LegacyDisableOrder\)[\s\S]*?Disable-ScheduledTask/);
  assert.match(migration, /supervisorTask\.State -ne "Running"/);
  assert.match(migration, /legacyTask\.State -eq "Running"/);
});

test("activation and commit fail closed on live or inconsistent legacy runtime ownership", () => {
  for (const filename of [
    "listener-runtime.json",
    "listener-owner.lock",
    "intraday-runtime.json",
    "intraday-owner.lock"
  ]) {
    assert.match(migration, new RegExp(`"${filename.replace(".", "\\.")}"`));
  }
  for (const schema of [
    "listener-runtime.v1",
    "listener-owner.v1",
    "intraday-runtime.v1",
    "intraday-owner.v1"
  ]) {
    assert.match(migration, new RegExp(`"${schema.replace(".", "\\.")}"`));
  }
  assert.match(migration, /FileAttributes\]::ReparsePoint/);
  assert.match(migration, /Runtime control JSON must contain one object/);
  assert.match(migration, /ownerInstance -ne \$stateInstance -or \$ownerProcessId -ne \$stateProcessId/);
  assert.match(migration, /Process\]::GetProcessById\(\$ProcessId\)/);
  assert.match(migration, /legacy_runtimes = \$legacyRuntimeRecords/g);
  assert.match(migration, /Captured legacy \$label PID \$capturedProcessId is still alive/);
  assert.match(migration, /requires_process_exit = \(\(\$null -ne \$owner\) -or \$stateStatus -notin @\("stopped", "failed"\)\)/);
  assert.match(migration, /\$requiresExitCheck = \(\[bool\]\$record\.owner_present\) -or \$status -notin @\("stopped", "failed"\)/);
  assert.match(migration, /if \(\$requiresExitCheck -and \(Test-RecordedProcessAlive/);

  const activate = migration.slice(migration.indexOf('"Activate" {'), migration.indexOf('"Commit" {'));
  orderedIndexes(activate, [
    "Assert-NoLiveLegacyRuntimes",
    "Assert-CapturedLegacyRuntimesStopped",
    "Enable-ScheduledTask"
  ]);

  const commit = migration.slice(migration.indexOf('"Commit" {'), migration.indexOf('"Rollback" {'));
  orderedIndexes(commit, [
    "Get-ValidatedRuntimeIdentities",
    "Assert-CapturedLegacyRuntimesStopped",
    "Unregister-ScheduledTask"
  ]);
});
