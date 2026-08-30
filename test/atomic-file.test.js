import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFileSync } from "../src/atomic-file.js";

test("atomic state writes retry transient Windows-style rename locks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-atomic-"));
  const filename = path.join(root, "state.json");
  let calls = 0;
  try {
    const result = atomicWriteFileSync(filename, '{"ok":true}\n', {
      attempts: 4,
      rename: (source, target) => {
        calls += 1;
        if (calls < 3) {
          const error = new Error("temporarily locked");
          error.code = process.platform === "win32" ? "EPERM" : "EINTR";
          if (process.platform !== "win32") return fs.renameSync(source, target);
          throw error;
        }
        return fs.renameSync(source, target);
      }
    });
    assert.equal(JSON.parse(fs.readFileSync(filename, "utf8")).ok, true);
    assert.equal(result.atomic, true);
    assert.equal(calls, process.platform === "win32" ? 3 : 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
