import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const KEEP_AWAKE_SCRIPT = path.resolve(MODULE_DIR, "../scripts/keep-awake.ps1");

export function startKeepAwake(enabled = true, onFailure = () => {}) {
  if (!enabled || process.platform !== "win32") return () => {};
  if (!fs.existsSync(KEEP_AWAKE_SCRIPT)) throw new Error(`Keep-awake helper is missing: ${KEEP_AWAKE_SCRIPT}`);

  const child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "RemoteSigned",
    "-File", KEEP_AWAKE_SCRIPT, "-Hold"
  ], { windowsHide: true, stdio: "ignore" });
  let stopped = false;
  const fail = (error) => {
    if (!stopped) onFailure(error);
  };
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    if (!stopped) fail(new Error(`Keep-awake helper exited unexpectedly (code=${code}, signal=${signal ?? "none"}).`));
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!child.killed) child.kill();
  };
  process.once("exit", stop);
  return () => {
    stop();
    process.removeListener("exit", stop);
  };
}
