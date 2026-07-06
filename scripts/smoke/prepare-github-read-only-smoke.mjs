#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const args = parseArgs(process.argv.slice(2));
const distConfigPath = path.join(repoRoot, "dist", "core", "config.js");
const distRunPath = path.join(repoRoot, "dist", "core", "migrationRun.js");

if (!existsSync(distConfigPath) || !existsSync(distRunPath)) {
  console.error("dist/ is missing. Run `npm run build` before this smoke helper.");
  process.exit(1);
}

const repo = args.repo;
if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  console.error("Missing or invalid --repo owner/name.");
  process.exit(1);
}

const { loadConfig } = await import(pathToFileURL(distConfigPath).href);
const { loadRunPackage } = await import(pathToFileURL(distRunPath).href);
const configPath = args.config ? path.resolve(process.cwd(), args.config) : undefined;
const runSelector = args.run ?? "latest";
const loaded = await loadConfig(configPath);
const pkg = await loadRunPackage(loaded, runSelector);
const command = [
  "node",
  "dist/cli.js",
  "sync-issues",
  "--config",
  path.relative(process.cwd(), loaded.path) || loaded.path,
  "--run",
  pkg.run.id,
  "--provider",
  "github",
  "--live-plan",
  "--repo",
  repo
];

if (args.labels) {
  command.push("--labels", args.labels);
}

const tokenPresent = Boolean(process.env.GITHUB_TOKEN);
if (args["require-token"] && !tokenPresent) {
  console.error("GITHUB_TOKEN is not set. This preflight did not call GitHub.");
  process.exit(1);
}

console.log(JSON.stringify({
  passed: true,
  readOnly: true,
  externalApiCalled: false,
  tokenPresent,
  repo,
  runId: pkg.run.id,
  issueCount: pkg.issues.length,
  targetRoot: pkg.run.targetRoot,
  command,
  commandText: command.map(shellQuote).join(" "),
  allowedNetwork: ["GET /repos/{owner}/{repo}/issues?state=open&per_page=100"],
  forbiddenNetwork: ["POST /issues", "PATCH /issues/{number}"],
  nextStep: "Run commandText only after explicit authorization for a real read-only GitHub smoke."
}, null, 2));

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

function shellQuote(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}
