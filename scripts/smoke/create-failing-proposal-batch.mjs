#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(process.cwd(), args.config ?? ".migration-guard.json");
const runSelector = args.run ?? "latest";
const prefix = args.prefix ?? `smoke-${Date.now()}`;

const distConfigPath = path.join(repoRoot, "dist", "core", "config.js");
if (!existsSync(distConfigPath)) {
  console.error("dist/ is missing. Run `npm run build` before this smoke helper.");
  process.exit(1);
}

const { loadConfig } = await import(pathToFileURL(distConfigPath).href);
const { writeJsonFile, writeTextFile } = await import(pathToFileURL(path.join(repoRoot, "dist", "core", "files.js")).href);
const { loadRunPackage, migrationRunDir } = await import(pathToFileURL(path.join(repoRoot, "dist", "core", "migrationRun.js")).href);
const { createAddFilePatch } = await import(pathToFileURL(path.join(repoRoot, "dist", "core", "patch.js")).href);

const loaded = await loadConfig(configPath);
const pkg = await loadRunPackage(loaded, runSelector);
const firstCreatedAt = new Date().toISOString();
const secondCreatedAt = new Date(Date.parse(firstCreatedAt) + 1000).toISOString();

const failing = await writeSmokeProposal({
  loaded,
  pkg,
  id: `${prefix}-fail`,
  createdAt: firstCreatedAt,
  title: "Smoke failing proposal",
  summary: "Adds a generated probe that exits non-zero so batch fail-fast can be verified.",
  generatedFile: `scripts/migration-guard/${prefix}-fail.mjs`,
  content: [
    "console.error(\"migration-guard smoke failure\");",
    "process.exit(1);",
    ""
  ].join("\n")
});

const skipped = await writeSmokeProposal({
  loaded,
  pkg,
  id: `${prefix}-skip`,
  createdAt: secondCreatedAt,
  title: "Smoke skipped proposal",
  summary: "Adds a generated probe that should be skipped after the first proposal fails.",
  generatedFile: `scripts/migration-guard/${prefix}-skip.mjs`,
  content: [
    "console.log(\"migration-guard smoke skipped proposal should not run\");",
    ""
  ].join("\n")
});

console.log(JSON.stringify({
  runId: pkg.run.id,
  proposals: [failing.id, skipped.id],
  nextCommand: `node dist/cli.js proposal batch apply --run ${pkg.run.id} --limit 2 --gate-policy fail-fast`
}, null, 2));

async function writeSmokeProposal({ loaded, pkg, id, createdAt, title, summary, generatedFile, content }) {
  const proposalDir = path.join(migrationRunDir(loaded, pkg.run.id), "proposals", id);
  const patchPath = path.join(proposalDir, "patch.diff");
  const command = `node ${generatedFile}`;
  const proposal = {
    version: 1,
    id,
    runId: pkg.run.id,
    createdAt,
    title,
    summary,
    risk: "low",
    patchPath,
    affectedFiles: [],
    generatedFiles: [generatedFile],
    recommendedChecks: [command],
    checkPlan: [{
      command,
      kind: "unit-test",
      phase: "pre-preview",
      critical: true
    }],
    patchKind: "action-probe",
    applyState: "proposed"
  };

  await writeTextFile(patchPath, createAddFilePatch(generatedFile, content));
  await writeJsonFile(path.join(proposalDir, "proposal.json"), proposal);
  return proposal;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}
