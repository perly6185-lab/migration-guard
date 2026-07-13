import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const pilots = ["ascllcreator", "cursormade", "aiway"];
const rows = [];
for (const project of pilots) {
  const root = path.join(".migration-guard", "pilots", project);
  const baselinePath = path.join(root, "latest-baseline.json");
  const runPath = path.join(root, "latest-run.json");
  const compareDir = path.join(root, "compare");
  if (!existsSync(baselinePath) || !existsSync(runPath) || !existsSync(compareDir)) {
    rows.push({ project, status: "skipped", reason: "pilot artifacts not found" });
    continue;
  }
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const run = JSON.parse(await readFile(runPath, "utf8"));
  const { readdir } = await import("node:fs/promises");
  const compareFile = (await readdir(compareDir)).filter((name) => name.endsWith(".json")).sort().at(-1);
  const compare = compareFile ? JSON.parse(await readFile(path.join(compareDir, compareFile), "utf8")) : undefined;
  rows.push({ project, status: compare?.passed ? "passed" : "failed", baselineDurationMs: sumDuration(baseline), verifyDurationMs: sumDuration(run), differences: compare?.differences?.length ?? 0, inheritedFailures: compare?.checkHealth?.inheritedFailure ?? 0, regressions: compare?.checkHealth?.regression ?? 0, changedFailures: compare?.checkHealth?.changedFailure ?? 0 });
}
const executed = rows.filter((row) => row.status !== "skipped");
const report = { version: 1, createdAt: new Date().toISOString(), go: executed.length >= 3 && executed.every((row) => row.status === "passed" && row.regressions === 0 && row.changedFailures === 0), projects: rows, metrics: { configuredProjects: pilots.length, executedProjects: executed.length, passedProjects: executed.filter((row) => row.status === "passed").length, totalDifferences: executed.reduce((sum, row) => sum + row.differences, 0) } };
await writeFile(path.join(".migration-guard", "rc-feedback-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.go && executed.length >= 3) process.exitCode = 1;

function sumDuration(snapshot) { return [...(snapshot.checks ?? []), ...(snapshot.probes ?? [])].reduce((sum, item) => sum + (item.durationMs ?? 0), 0); }
