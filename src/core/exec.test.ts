import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runShellCommand } from "./exec.js";

test("runShellCommand timeout terminates descendant processes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-exec-"));
  const marker = path.join(dir, "descendant-finished.txt");
  const childScript = path.join(dir, "child.mjs");
  const parentScript = path.join(dir, "parent.mjs");

  try {
    await writeFile(childScript, `import { writeFileSync } from "node:fs";\nsetTimeout(() => writeFileSync(${JSON.stringify(marker)}, "finished"), 10000);\nsetInterval(() => {}, 1000);\n`);
    await writeFile(parentScript, `import { spawn } from "node:child_process";\nspawn(process.execPath, [${JSON.stringify(childScript)}]);\nsetInterval(() => {}, 1000);\n`);
    const result = await runShellCommand(`"${process.execPath}" "${parentScript}"`, {
      cwd: dir,
      timeoutMs: 100,
      maxOutputBytes: 1024
    });

    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 10500));
    await assert.rejects(() => readFile(marker, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
