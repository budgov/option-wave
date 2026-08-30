import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(ROOT, "native", "ocean_wave_supervisor.cpp"), "utf8");
const build = fs.readFileSync(path.join(ROOT, "scripts", "build-supervisor.ps1"), "utf8");
const executable = path.join(ROOT, "bin", "OceanWaveSupervisor.exe");
const sidecar = `${executable}.sha256`;

test("native supervisor host is a transparent windowless Win32 launcher", () => {
  assert.match(source, /int WINAPI wWinMain\(/);
  assert.match(source, /CREATE_NO_WINDOW/);
  assert.match(source, /CreateProcessW\(/);
  assert.match(source, /CreateMutexW\(/);
  assert.match(source, /SetThreadExecutionState\(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED\)/);
  assert.match(source, /CreateJobObjectW\(/);
  assert.match(source, /AssignProcessToJobObject\(/);
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(source, /WM_QUERYENDSESSION/);
  assert.match(source, /windows_session_end/);
  assert.match(source, /--request-stop/);
  assert.match(source, /OCEAN_WAVE_EXTERNAL_KEEP_AWAKE/);

  assert.doesNotMatch(source, /CreateRemoteThread|VirtualAllocEx|WriteProcessMemory/);
  assert.doesNotMatch(source, /ShellExecute|WinExec|\bsystem\s*\(/);
  assert.doesNotMatch(source, /powershell(?:\.exe)?|cmd\.exe/i);
});

test("native supervisor build is hardened, reproducible, and self-tested before publication", () => {
  for (const flag of [
    "/SUBSYSTEM:WINDOWS",
    "/O2",
    "/GS",
    "/sdl",
    "/guard:cf",
    "/DYNAMICBASE",
    "/NXCOMPAT",
    "/Brepro",
    "/MANIFESTUAC:level='asInvoker' uiAccess='false'"
  ]) {
    assert.ok(build.includes(flag), `missing native compiler/linker policy ${flag}`);
  }
  assert.match(build, /Invoke-NativeSupervisorSelfTest/);
  assert.match(build, /Get-FileHash[\s\S]+-Algorithm SHA256/);
  assert.match(build, /\$sidecar\s*=\s*"\$target\.sha256"/);
  assert.match(build, /\^\[0-9a-f\]\{64\}\$/);
});

test("published native supervisor matches its fail-closed SHA-256 sidecar and PE policy", (context) => {
  const executableExists = fs.existsSync(executable);
  const sidecarExists = fs.existsSync(sidecar);
  assert.equal(executableExists, sidecarExists, "executable and SHA-256 sidecar must be published together");
  if (!executableExists) {
    context.skip("native supervisor has not been built in this checkout");
    return;
  }

  const image = fs.readFileSync(executable);
  const recorded = fs.readFileSync(sidecar, "utf8").trim().toLowerCase();
  const actual = crypto.createHash("sha256").update(image).digest("hex");
  assert.match(recorded, /^[0-9a-f]{64}$/);
  assert.equal(recorded, actual);

  assert.equal(image.subarray(0, 2).toString("ascii"), "MZ");
  const peOffset = image.readUInt32LE(0x3c);
  assert.equal(image.subarray(peOffset, peOffset + 4).toString("binary"), "PE\0\0");
  const optionalHeader = peOffset + 24;
  assert.ok([0x10b, 0x20b].includes(image.readUInt16LE(optionalHeader)));
  assert.equal(image.readUInt16LE(optionalHeader + 68), 2, "PE subsystem must be Windows GUI");
  const characteristics = image.readUInt16LE(optionalHeader + 70);
  assert.ok(characteristics & 0x0020, "PE must opt into high-entropy ASLR");
  assert.ok(characteristics & 0x0040, "PE must opt into ASLR");
  assert.ok(characteristics & 0x0100, "PE must opt into DEP/NX");
  assert.ok(characteristics & 0x4000, "PE must opt into Control Flow Guard");
});

test("published host self-test validates the fixed root without starting the supervisor", (context) => {
  const config = path.join(ROOT, "config.json");
  if (process.platform !== "win32" || !fs.existsSync(executable) || !fs.existsSync(config)) {
    context.skip("Windows native artifact or local config is unavailable");
    return;
  }
  const result = spawnSync(executable, [
    "--project-root", ROOT,
    "--config", config,
    "--self-test"
  ], {
    cwd: ROOT,
    windowsHide: true,
    timeout: 15_000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});
