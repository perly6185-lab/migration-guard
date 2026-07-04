#!/usr/bin/env node
import path from "node:path";
import { CONFIG_FILE_NAME, initConfigFile, loadConfig } from "./core/config.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "./core/files.js";
import { renderAiBrief } from "./core/aiBrief.js";
import { renderCompareReport, renderScanSummary, renderSnapshotSummary } from "./core/markdown.js";
import { renderMigrationPlan } from "./core/plan.js";
import { scanProject } from "./core/scan.js";
import { captureSnapshot, latestBaselinePath, latestRunPath, loadSnapshot, saveSnapshot } from "./core/snapshot.js";
import { compareSnapshots } from "./core/compare.js";
import type { CompareReport } from "./types.js";

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "init":
      await commandInit(args);
      return;
    case "scan":
      await commandScan(args);
      return;
    case "baseline":
      await commandBaseline(args);
      return;
    case "verify":
      await commandVerify(args);
      return;
    case "compare":
      await commandCompare(args);
      return;
    case "plan":
      await commandPlan(args);
      return;
    case "ai-brief":
      await commandAiBrief(args);
      return;
    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const [key, inlineValue] = withoutPrefix.split("=", 2);
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return {
    command,
    options,
    positionals
  };
}

async function commandInit(args: ParsedArgs): Promise<void> {
  const targetRoot = stringOption(args, "target") ?? args.positionals[0] ?? ".";
  const configPath = path.resolve(process.cwd(), CONFIG_FILE_NAME);
  const force = Boolean(args.options.force);

  await initConfigFile(configPath, targetRoot, force);
  await ensureDir(path.resolve(process.cwd(), ".migration-guard"));

  console.log(`Created ${configPath}`);
  console.log("Next: edit probes in .migration-guard.json, then run `migration-guard baseline`.");
}

async function commandScan(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const scan = await scanProject(loaded);
  const outputPath = path.join(loaded.artifactsDir, "scan", `${Date.now()}.json`);

  await writeJsonFile(outputPath, scan);

  if (args.options.json) {
    console.log(JSON.stringify(scan, null, 2));
  } else {
    console.log(renderScanSummary(scan));
    console.log("");
    console.log(`Wrote ${outputPath}`);
  }
}

async function commandBaseline(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const snapshot = await captureSnapshot(loaded, "baseline");
  const outputPath = await saveSnapshot(loaded, snapshot);

  console.log(renderSnapshotSummary(snapshot));
  console.log(`Wrote ${outputPath}`);
}

async function commandVerify(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const snapshot = await captureSnapshot(loaded, "run");
  const outputPath = await saveSnapshot(loaded, snapshot);
  const baselinePath = stringOption(args, "baseline") ?? latestBaselinePath(loaded);

  console.log(renderSnapshotSummary(snapshot));
  console.log(`Wrote ${outputPath}`);

  if (!await pathExists(baselinePath)) {
    console.log(`No baseline found at ${baselinePath}. Run baseline first or pass --baseline.`);
    return;
  }

  const baseline = await loadSnapshot(baselinePath);
  const report = compareSnapshots(baseline, snapshot, loaded.config.compare);
  const reportPath = await writeCompareArtifacts(loaded.artifactsDir, report);

  console.log("");
  console.log(renderCompareReport(report));
  console.log("");
  console.log(`Wrote ${reportPath}`);

  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function commandCompare(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const baselinePath = stringOption(args, "baseline") ?? args.positionals[0] ?? latestBaselinePath(loaded);
  const currentPath = stringOption(args, "current") ?? args.positionals[1] ?? latestRunPath(loaded);
  const baseline = await readJsonFile<Awaited<ReturnType<typeof loadSnapshot>>>(path.resolve(process.cwd(), baselinePath));
  const current = await readJsonFile<Awaited<ReturnType<typeof loadSnapshot>>>(path.resolve(process.cwd(), currentPath));
  const report = compareSnapshots(baseline, current, loaded.config.compare);
  const reportPath = await writeCompareArtifacts(loaded.artifactsDir, report);

  console.log(renderCompareReport(report));
  console.log("");
  console.log(`Wrote ${reportPath}`);

  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function commandPlan(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const scan = await scanProject(loaded);
  const plan = renderMigrationPlan(scan);
  const outputPath = path.join(loaded.artifactsDir, "migration-plan.md");

  await writeTextFile(outputPath, plan);
  console.log(plan);
  console.log("");
  console.log(`Wrote ${outputPath}`);
}

async function commandAiBrief(args: ParsedArgs): Promise<void> {
  const loaded = await loadFromArgs(args);
  const scan = await scanProject(loaded);
  const baselinePath = stringOption(args, "baseline") ?? latestBaselinePath(loaded);
  const currentPath = stringOption(args, "current") ?? latestRunPath(loaded);
  const baseline = await loadOptionalSnapshot(baselinePath);
  const current = await loadOptionalSnapshot(currentPath);
  const compareReport = baseline && current
    ? compareSnapshots(baseline, current, loaded.config.compare)
    : undefined;
  const brief = renderAiBrief({
    loaded,
    scan,
    baseline,
    current,
    compareReport
  });
  const outputPath = stringOption(args, "output")
    ? path.resolve(process.cwd(), stringOption(args, "output") as string)
    : path.join(loaded.artifactsDir, "ai", `brief-${Date.now()}.md`);

  await writeTextFile(outputPath, brief);
  console.log(brief);
  console.log("");
  console.log(`Wrote ${outputPath}`);
}

async function loadOptionalSnapshot(filePath: string) {
  return await pathExists(filePath) ? loadSnapshot(filePath) : undefined;
}

async function writeCompareArtifacts(artifactsDir: string, report: CompareReport): Promise<string> {
  const reportPath = path.join(artifactsDir, "compare", `${Date.now()}.json`);
  const markdownPath = reportPath.replace(/\.json$/, ".md");

  await writeJsonFile(reportPath, report);
  await writeTextFile(markdownPath, renderCompareReport(report));
  return reportPath;
}

async function loadFromArgs(args: ParsedArgs) {
  return loadConfig(stringOption(args, "config"));
}

function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === "string" ? value : undefined;
}

function printHelp(): void {
  console.log(`Migration Guard

Usage:
  migration-guard init [--target <path>] [--force]
  migration-guard scan [--config <path>] [--json]
  migration-guard baseline [--config <path>]
  migration-guard verify [--config <path>] [--baseline <path>]
  migration-guard compare [--config <path>] [--baseline <path>] [--current <path>]
  migration-guard plan [--config <path>]
  migration-guard ai-brief [--config <path>] [--baseline <path>] [--current <path>] [--output <path>]

Behavior consistency workflow:
  1. init      Create .migration-guard.json
  2. baseline  Capture the current behavior
  3. verify    Re-run checks and probes after a small migration step
  4. compare   Inspect behavior drift explicitly
  5. ai-brief  Give an AI assistant the current evidence and operating rules
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
