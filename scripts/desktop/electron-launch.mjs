import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const electronCli = path.join(root, "node_modules", "electron", "cli.js");
const args = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [electronCli, ...(args.length > 0 ? args : [root])], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: false
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
