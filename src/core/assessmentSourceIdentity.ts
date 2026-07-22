import { runShellCommand } from "./exec.js";
import { sha256 } from "./hash.js";

export interface AssessmentSourceIdentity {
  revision: string;
  dirty: boolean;
  dirtyFingerprint: string;
  identity: string;
}

export async function captureAssessmentSourceIdentity(root: string): Promise<AssessmentSourceIdentity> {
  const [head, status] = await Promise.all([
    runShellCommand("git rev-parse --verify HEAD", { cwd: root, timeoutMs: 5000, maxOutputBytes: 4096 }),
    runShellCommand("git status --short --untracked-files=all", { cwd: root, timeoutMs: 15000, maxOutputBytes: 4 * 1024 * 1024 })
  ]);
  const revision = head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : "unversioned";
  const normalizedStatus = revision === "unversioned" ? "" : status.exitCode === 0 ? normalizeAssessmentGitStatus(status.stdout) : `status-unavailable:${status.error ?? status.stderr}`;
  const dirty = normalizedStatus.length > 0;
  const dirtyFingerprint = sha256(normalizedStatus);
  return { revision, dirty, dirtyFingerprint, identity: dirty ? `${revision}+dirty:${dirtyFingerprint.slice(0, 12)}` : revision };
}

export function normalizeAssessmentGitStatus(value: string): string {
  return value.replace(/\r\n/g, "\n").split("\n")
    .filter((line) => line.trim() && !/(?:^|[\s\\/])\.migration-guard[\\/]/.test(line))
    .sort()
    .join("\n");
}
