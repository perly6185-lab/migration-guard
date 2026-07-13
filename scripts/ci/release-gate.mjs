import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert.match(pkg.version, /^0\.2\.0(?:-rc\.\d+)?$/, `unexpected release version: ${pkg.version}`);
for (const command of [["npm", ["test"]], ["npm", ["run", "ui:smoke"]], ["npm", ["run", "package:audit"]], ["npm", ["run", "package:smoke"]]]) await run(command[0], command[1]);
console.log(`release gate passed for ${pkg.version}; publish and tag remain manual reviewed actions`);

function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit", shell: process.platform === "win32", windowsHide: true }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with ${code}`))); }); }
