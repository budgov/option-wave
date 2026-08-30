import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RETRYABLE_WINDOWS_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

function pause(milliseconds) {
  // Synchronous state writes are tiny and infrequent. Atomics.wait gives us a
  // bounded sleep without spawning a shell or spinning a CPU core.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function atomicWriteFileSync(filename, data, {
  encoding = "utf8",
  mode = 0o600,
  attempts = 8,
  allowCopyFallback = false,
  rename = fs.renameSync
} = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { encoding, mode, flag: "wx" });
    let lastError;
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      try {
        rename(temporary, filename);
        return { atomic: true, attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        if (process.platform !== "win32" || !RETRYABLE_WINDOWS_ERRORS.has(error.code)) throw error;
        pause(Math.min(250, 10 * 2 ** attempt));
      }
    }
    if (!allowCopyFallback) throw lastError;
    // Runtime health JSON is advisory. Copying a fully-written temporary file
    // is preferable to crashing an otherwise clean shutdown after all bounded
    // atomic replace attempts were blocked by antivirus/indexing software.
    fs.copyFileSync(temporary, filename);
    return { atomic: false, attempts: Math.max(1, attempts) };
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
