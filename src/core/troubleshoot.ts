import net from "node:net";
import path from "node:path";
import { diagnoseConfig } from "./configDoctor.js";
import { collectDashboardBlockers, collectRunsList } from "./dashboard.js";
import { pathExists } from "./files.js";
import { latestBaselinePath, latestRunPath } from "./snapshot.js";
import { listUiJobs, planOrphanUiJobs } from "./uiJobService.js";
import type { LoadedConfig } from "../types.js";

export interface ArtifactInspectionReport {
  version: 1;
  runId?: string;
  artifactsDir: string;
  checks: Array<{ name: string; path: string; exists: boolean }>;
  missingCount: number;
}

export async function inspectRunArtifacts(loaded: LoadedConfig, runSelector = "latest"): Promise<ArtifactInspectionReport> {
  const runs = await collectRunsList(loaded);
  const runId = runSelector === "latest" ? runs.latestRunId : runSelector;
  const checks = [
    { name: "artifacts-dir", path: loaded.artifactsDir, exists: await pathExists(loaded.artifactsDir) },
    { name: "baseline", path: latestBaselinePath(loaded), exists: await pathExists(latestBaselinePath(loaded)) },
    { name: "latest-verification", path: latestRunPath(loaded), exists: await pathExists(latestRunPath(loaded)) }
  ];
  if (runId) {
    const runDir = path.join(loaded.artifactsDir, "migration-runs", runId);
    checks.push({ name: "run", path: runDir, exists: await pathExists(runDir) });
  }
  return { version: 1, runId, artifactsDir: loaded.artifactsDir, checks, missingCount: checks.filter((check) => !check.exists).length };
}

export interface ServeDoctorReport {
  version: 1;
  host: string;
  port: number;
  status: "available" | "migration-guard-running" | "occupied" | "unreachable";
  url: string;
  nextCommand?: string;
}

export async function diagnoseServe(host = "127.0.0.1", port = 8787, fetchImpl: typeof fetch = fetch): Promise<ServeDoctorReport> {
  const url = `http://${host}:${port}`;
  if (await canListen(host, port)) return { version: 1, host, port, status: "available", url, nextCommand: `migration-guard serve --host ${host} --port ${port}` };
  try {
    const response = await fetchImpl(`${url}/api/session`, { signal: AbortSignal.timeout(1500) });
    const body = response.ok ? await response.json() as { version?: number; csrfToken?: string } : undefined;
    if (body?.version === 1 && typeof body.csrfToken === "string") return { version: 1, host, port, status: "migration-guard-running", url };
    return { version: 1, host, port, status: "occupied", url, nextCommand: `migration-guard serve --host ${host} --port ${port + 1}` };
  } catch {
    return { version: 1, host, port, status: "occupied", url, nextCommand: `migration-guard serve --host ${host} --port ${port + 1}` };
  }
}

export async function collectTroubleshootReport(loaded: LoadedConfig, options: { run?: string; host?: string; port?: number } = {}) {
  const run = options.run ?? "latest";
  const [config, runs, artifacts, jobs, orphanJobs, serve] = await Promise.all([
    diagnoseConfig(loaded),
    collectRunsList(loaded),
    inspectRunArtifacts(loaded, run),
    listUiJobs(loaded, new URLSearchParams({ status: "all", limit: "20" })),
    planOrphanUiJobs(loaded),
    diagnoseServe(options.host, options.port)
  ]);
  let blockers;
  let blockerError: string | undefined;
  try {
    blockers = await collectDashboardBlockers(loaded, { runId: run, checkTargetGit: true });
  } catch (error) {
    blockerError = error instanceof Error ? error.message : String(error);
  }
  const causes = [
    ...config.findings.filter((item) => item.severity === "error").map((item) => ({ area: "config", cause: item.message, nextCommand: item.fix })),
    ...(blockers?.blockers ?? []).map((item) => ({ area: item.scope, cause: item.reason, nextCommand: item.nextAction })),
    ...orphanJobs.candidates.map((item) => ({ area: "jobs", cause: `${item.id}: ${item.reason}`, nextCommand: "migration-guard jobs recover --apply" })),
    ...artifacts.checks.filter((item) => !item.exists).map((item) => ({ area: "artifacts", cause: `${item.name} is missing: ${item.path}`, nextCommand: artifactNextCommand(item.name) }))
  ];
  if (blockerError && runs.runCount > 0) causes.push({ area: "run", cause: blockerError, nextCommand: "migration-guard runs list --json" });
  return { version: 1, createdAt: new Date().toISOString(), status: causes.length === 0 ? "ok" : "attention", config, runs, blockers, jobs, orphanJobs, artifacts, serve, causes };
}

async function canListen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function artifactNextCommand(name: string): string {
  if (name === "baseline") return "migration-guard baseline";
  if (name === "latest-verification") return "migration-guard verify";
  return "migration-guard runs list --json";
}
