import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const pilots = [
  { project: "ascllcreator", env: "MG_PILOT_ASCLLCREATOR_ROOT" },
  { project: "cursormade", env: "MG_PILOT_CURSORMADE_ROOT" },
  { project: "aiway", env: "MG_PILOT_AIWAY_ROOT" }
 ];

let executed = 0;
for (const pilot of pilots) {
  const root = process.env[pilot.env];
  if (!root || !existsSync(root)) {
    console.log(`pilot skipped: ${pilot.project}; set ${pilot.env} to an existing project root`);
    continue;
  }
  executed += 1;
  const config = `pilots/${pilot.project}.migration-guard.json`;
  await run(["dist/cli.js", "scan", "--config", config, "--json"]);
  await run(["dist/cli.js", "baseline", "--config", config]);
  await run(["dist/cli.js", "verify", "--config", config]);
}

console.log(`pilot smoke complete: ${executed} executed, ${pilots.length - executed} skipped`);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${args.join(" ")} failed with ${code}`)));
  });
}
