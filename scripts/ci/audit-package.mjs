import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const output = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
const pack = JSON.parse(output)[0];
assert.ok(pack, "npm pack returned no package metadata");
const forbidden = pack.files.filter((file) =>
  file.path.startsWith("src/") ||
  file.path.startsWith("pilots/") ||
  file.path.startsWith("docs/PHASE_") ||
  file.path.includes(".test.")
);
assert.deepEqual(forbidden, [], `forbidden package files: ${forbidden.map((file) => file.path).join(", ")}`);
console.log(`package audit passed: ${pack.entryCount} files, ${pack.size} bytes, ${pack.unpackedSize} bytes unpacked`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), shell: process.platform === "win32", windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} failed with ${code}\n${stderr}`)));
  });
}
