import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
runNode(path.join(
  rustRoot,
  "internal",
  "dynamic-engine-runtime",
  "scripts",
  "compatibility-gate.mjs",
));
run(rustRoot, ["fmt", "--all", "--check"]);
run(rustRoot, [
  "clippy",
  "--workspace",
  "--all-targets",
  "--all-features",
  "--offline",
  "--",
  "-D",
  "warnings",
]);
run(rustRoot, [
  "test",
  "--workspace",
  "--all-targets",
  "--all-features",
  "--offline",
]);

run(rustRoot, [
  "check",
  "-p",
  "zboss-rust",
  "--no-default-features",
  "--features",
  "production",
  "--offline",
]);

console.log("unified ZBoss Rust workspace gate passed (2 packages, one lock)");

function runNode(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: rustRoot,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`node ${script} failed`);
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
}

function run(cwd, args) {
  const result = spawnSync("cargo", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`cargo ${args.join(" ")} failed in ${cwd}`);
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
}
