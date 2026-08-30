import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "../src/atomic-file.js";

const [sourceArgument, targetArgument] = process.argv.slice(2);
if (!sourceArgument || !targetArgument) {
  throw new Error("Usage: node scripts/update-openclaw-workspaces.js <old-project-root> <new-project-root>");
}

const sourceRoot = path.resolve(sourceArgument);
const targetRoot = path.resolve(targetArgument);
if (sourceRoot === targetRoot) throw new Error("Old and new project roots must differ.");

const agentDirectories = new Map([
  ["ocean-luna", "luna"],
  ["ocean-terra", "terra"],
  ["ocean-sol", "sol"]
]);
for (const directory of agentDirectories.values()) {
  const expected = path.join(targetRoot, "agents", directory);
  if (!fs.existsSync(expected) || !fs.statSync(expected).isDirectory()) {
    throw new Error(`Migrated OpenClaw agent workspace is missing: ${expected}`);
  }
}

const stateRoot = path.join(os.homedir(), ".openclaw");
const filenames = ["openclaw.json", "openclaw.json.last-good"];
const results = [];
for (const basename of filenames) {
  const filename = path.join(stateRoot, basename);
  if (!fs.existsSync(filename)) continue;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${basename} is not a regular configuration file.`);
  const document = JSON.parse(fs.readFileSync(filename, "utf8"));
  const agents = Array.isArray(document?.agents?.list) ? document.agents.list : [];
  const changed = [];
  for (const agent of agents) {
    const directory = agentDirectories.get(agent?.id);
    if (!directory) continue;
    const oldExpected = path.join(sourceRoot, "agents", directory);
    const newExpected = path.join(targetRoot, "agents", directory);
    const current = path.resolve(String(agent.workspace ?? ""));
    if (![path.normalize(oldExpected), path.normalize(newExpected)].includes(path.normalize(current))) {
      throw new Error(`Refusing to replace unexpected workspace for ${agent.id}.`);
    }
    if (path.normalize(current) !== path.normalize(newExpected)) {
      agent.workspace = newExpected;
      changed.push(agent.id);
    }
  }
  const write = atomicWriteFileSync(filename, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    allowCopyFallback: false
  });
  if (write.atomic !== true) throw new Error(`OpenClaw configuration update was not atomic: ${basename}`);
  results.push({ file: basename, changed_agents: changed });
}

process.stdout.write(`${JSON.stringify({ status: "ok", target_root: targetRoot, files: results })}\n`);
