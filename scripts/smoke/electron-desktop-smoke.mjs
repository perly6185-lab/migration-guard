import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const userDataDir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-electron-smoke-userdata-"));
const cwd = await mkdtemp(path.join(os.tmpdir(), "migration-guard-electron-smoke-cwd-"));

try {
  await access(path.join(root, "dist", "desktop", "main.js"));
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assertScript(packageJson, "desktop:dev");
  assertScript(packageJson, "desktop:pack");
  assertScript(packageJson, "desktop:dist");
  assertScript(packageJson, "desktop:smoke");
  if (packageJson.main !== "dist/desktop/main.js") {
    throw new Error("package.json main must point at dist/desktop/main.js for Electron.");
  }
  if (packageJson.build?.extraMetadata?.main !== "dist/desktop/main.js") {
    throw new Error("electron-builder extraMetadata.main must point at dist/desktop/main.js.");
  }
  if (!packageJson.build?.win?.target) {
    throw new Error("electron-builder Windows target is not configured.");
  }

  const output = await runElectronSmoke(cwd, userDataDir);
  if (!/Migration Guard Desktop UI:\s+http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    throw new Error(`Electron smoke did not report a local UI URL. Output:\n${output}`);
  }

  await access(path.join(userDataDir, "host", ".migration-guard.json"));
  console.log("Electron desktop smoke passed.");
} finally {
  await rm(cwd, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}

function assertScript(packageJson, name) {
  if (typeof packageJson.scripts?.[name] !== "string") {
    throw new Error(`Missing npm script: ${name}`);
  }
}

async function runElectronSmoke(cwd, userDataDir) {
  const electronCli = path.join(root, "node_modules", "electron", "cli.js");
  const env = {
    ...process.env,
    MG_DESKTOP_SMOKE: "1",
    MG_DESKTOP_USER_DATA_DIR: userDataDir
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [electronCli, root], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for Electron desktop smoke. Output:\n${output}`));
    }, 30000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`Electron desktop smoke failed with exit code ${exitCode}. Output:\n${output}`);
  }
  return output;
}
