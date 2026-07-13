import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const workspace = process.cwd();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "migration-guard-package-smoke-"));
let tarball;
try {
  const packOutput = await run("npm", ["pack", "--json", "--ignore-scripts"], workspace);
  const pack = JSON.parse(packOutput.stdout)[0];
  assert.ok(pack?.filename, "npm pack did not return a tarball filename");
  assert.ok(pack.files.every((file) => !file.path.startsWith("src/") && !file.path.includes(".test.")), "package contains source or test files");
  tarball = path.join(workspace, pack.filename);
  await run("npm", ["init", "-y"], tempRoot);
  await run("npm", ["install", "--ignore-scripts", tarball], tempRoot);
  const bin = process.platform === "win32"
    ? path.join(tempRoot, "node_modules", ".bin", "migration-guard.cmd")
    : path.join(tempRoot, "node_modules", ".bin", "migration-guard");
  const help = await run(bin, ["--help"], tempRoot);
  assert.match(help.stdout, /Migration Guard/);
  assert.match(help.stdout, /migration-guard baseline/);
  await run(bin, ["init", "--target", "fixture"], tempRoot);
  const config = JSON.parse(await readFile(path.join(tempRoot, ".migration-guard.json"), "utf8"));
  assert.equal(config.targetRoot, "fixture");
  console.log(`package smoke passed: ${pack.filename}, ${pack.files.length} files, ${pack.size} bytes`);
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: process.platform === "win32", windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}
