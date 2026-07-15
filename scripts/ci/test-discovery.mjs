import { readdir } from "node:fs/promises";
import path from "node:path";

const TEST_FILE_PATTERN = /\.test\.(?:js|mjs)$/;
const INTEGRATION_NAMES = new Set([
  "bootstrap.test.js",
  "checkpoint.test.js",
  "issueControl.test.js",
  "oneShot.test.js",
  "patch.test.js",
  "repairLoopCli.test.js",
  "uiServer.test.js",
  "evidence.test.mjs"
]);

export async function discoverTestFiles(workspace, roots = ["dist", "scripts"]) {
  const discovered = [];
  for (const root of roots) await visit(path.resolve(workspace, root), workspace, discovered);
  return discovered.sort((left, right) => left.localeCompare(right, "en"));
}

export function classifyTestFile(filePath) {
  return INTEGRATION_NAMES.has(path.posix.basename(toPosix(filePath))) ? "integration" : "unit";
}

async function visit(directory, workspace, discovered) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(entryPath, workspace, discovered);
    else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) discovered.push(toPosix(path.relative(workspace, entryPath)));
  }
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}
