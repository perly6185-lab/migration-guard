import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runShellCommand } from "./exec.js";
import { sha256 } from "./hash.js";

export interface AssessmentSourceIdentity {
  revision: string;
  dirty: boolean;
  dirtyFingerprint: string;
  identity: string;
}

export async function captureAssessmentSourceIdentity(root: string): Promise<AssessmentSourceIdentity> {
  const gitRoot = await findGitRoot(root);
  const git = gitRoot
    ? `git -c safe.directory=${JSON.stringify(gitRoot.replaceAll("\\", "/"))}`
    : "git";
  const [head, status, trackedDiff, untracked] = await Promise.all([
    runShellCommand(`${git} rev-parse --verify HEAD`, { cwd: root, timeoutMs: 15000, maxOutputBytes: 4096 }),
    runShellCommand(`${git} status --short --untracked-files=all`, { cwd: root, timeoutMs: 15000, maxOutputBytes: 4 * 1024 * 1024 }),
    runShellCommand(`${git} diff --binary --no-ext-diff HEAD --`, { cwd: root, timeoutMs: 30000, maxOutputBytes: 64 * 1024 * 1024 }),
    runShellCommand(`${git} ls-files --others --exclude-standard -z`, { cwd: root, timeoutMs: 15000, maxOutputBytes: 4 * 1024 * 1024 })
  ]);
  const revision = head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : "unversioned";
  const normalizedStatus = revision === "unversioned" ? "" : status.exitCode === 0 ? normalizeAssessmentGitStatus(status.stdout) : `status-unavailable:${status.error ?? status.stderr}`;
  const dirty = normalizedStatus.length > 0;
  const untrackedHashes = dirty && untracked.exitCode === 0
    ? await hashUntrackedAssessmentFiles(root, untracked.stdout)
    : [];
  const fingerprintPayload = dirty
    ? [
      normalizedStatus,
      trackedDiff.exitCode === 0 ? trackedDiff.stdout : `diff-unavailable:${trackedDiff.error ?? trackedDiff.stderr}`,
      ...untrackedHashes
    ].join("\n\0\n")
    : "";
  const dirtyFingerprint = sha256(fingerprintPayload);
  return { revision, dirty, dirtyFingerprint, identity: dirty ? `${revision}+dirty:${dirtyFingerprint.slice(0, 12)}` : revision };
}

async function findGitRoot(root: string): Promise<string | undefined> {
  let current = path.resolve(root);
  while (true) {
    try {
      await access(path.join(current, ".git"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

export function normalizeAssessmentGitStatus(value: string): string {
  return value.replace(/\r\n/g, "\n").split("\n")
    .filter((line) => line.trim() && !/(?:^|[\s\\/])\.migration-guard[\\/]/.test(line))
    .sort()
    .join("\n");
}

async function hashUntrackedAssessmentFiles(root: string, value: string): Promise<string[]> {
  const paths = value.split("\0").filter((file) => file && !isGeneratedAssessmentPath(file)).sort();
  return Promise.all(paths.map(async (file) => {
    try {
      const content = await readFile(path.resolve(root, file));
      return `${file}\0${sha256(content.toString("base64"))}`;
    } catch (error) {
      return `${file}\0unreadable:${error instanceof Error ? error.message : String(error)}`;
    }
  }));
}

function isGeneratedAssessmentPath(value: string): boolean {
  return /(?:^|[\\/])\.migration-guard[\\/]/.test(value);
}
