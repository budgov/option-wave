import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(filename);
    return entry.isFile() && entry.name.endsWith(".js") ? [filename] : [];
  });
}

const files = ["src", "scripts", "test"].flatMap((directory) => javascriptFiles(path.resolve(directory)));
for (const filename of files) {
  const result = spawnSync(process.execPath, ["--check", filename], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status === 0) continue;
  process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${filename}\n`);
  process.exitCode = 1;
  break;
}

if (!process.exitCode) console.log(`Syntax checked ${files.length} JavaScript files.`);
