import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const workspace = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), "migration-guard-install-modes-"));
let tarball;
try {
  const pack = JSON.parse((await run("npm", ["pack", "--json", "--ignore-scripts"], workspace)).stdout)[0];
  tarball = path.join(workspace, pack.filename);
  const npxResult = await run("npx", ["--yes", "--package", tarball, "migration-guard", "--help"], temp);
  assert.match(npxResult.stdout, /Migration Guard/);
  const prefix = path.join(temp, "global");
  await run("npm", ["install", "--global", "--prefix", prefix, tarball], temp);
  const bin = process.platform === "win32" ? path.join(prefix, "migration-guard.cmd") : path.join(prefix, "bin", "migration-guard");
  assert.match((await run(bin, ["--help"], temp)).stdout, /Migration Guard/);
  console.log("npx and global installation smoke passed");
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(temp, { recursive: true, force: true });
}

function run(command, args, cwd) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd, shell: process.platform === "win32", windowsHide: true }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed with ${code}\n${stderr}`))); }); }
