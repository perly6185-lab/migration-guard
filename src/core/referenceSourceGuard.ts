import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import {
  captureAssessmentSourceIdentity,
  type AssessmentSourceIdentity
} from "./assessmentSourceIdentity.js";
import { sha256 } from "./hash.js";

export interface ReferenceSourceSnapshot {
  root: string;
  directories: string[];
  identity: AssessmentSourceIdentity;
  treeHash: string;
  fileCount: number;
}

export async function captureReferenceSourceSnapshot(
  root: string,
  directories: string[]
): Promise<ReferenceSourceSnapshot> {
  const resolvedRoot = path.resolve(root);
  const normalizedDirectories = [...new Set(directories.map(normalizeSourceDirectory))].sort();
  const records: string[] = [];
  let fileCount = 0;
  for (const directory of normalizedDirectories) {
    const absolute = path.resolve(resolvedRoot, directory);
    assertNestedSourcePath(resolvedRoot, absolute, directory);
    const entries = await collectSourceTreeRecords(resolvedRoot, absolute);
    if (entries.length === 0) records.push(`directory:${directory}:empty-or-missing`);
    else {
      records.push(...entries);
      fileCount += entries.filter((entry) => entry.startsWith("file:")).length;
    }
  }
  if (fileCount === 0) {
    throw new Error(`MG-SOURCE-DIRECTORIES-EMPTY:${resolvedRoot}`);
  }
  return {
    root: resolvedRoot,
    directories: normalizedDirectories,
    identity: await captureAssessmentSourceIdentity(resolvedRoot),
    treeHash: sha256(records.sort().join("\n")),
    fileCount
  };
}

export async function assertReferenceSourceSnapshotUnchanged(
  before: ReferenceSourceSnapshot,
  operation: string
): Promise<void> {
  const after = await captureReferenceSourceSnapshot(before.root, before.directories);
  if (!referenceSourceSnapshotsEqual(before, after)) {
    throw new Error(`MG-SOURCE-READ-ONLY-VIOLATION:${operation}:${before.root}`);
  }
}

export function referenceSourceSnapshotsEqual(
  left: ReferenceSourceSnapshot,
  right: ReferenceSourceSnapshot
): boolean {
  return stableSnapshot(left) === stableSnapshot(right);
}

function normalizeSourceDirectory(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === "." || normalized.split("/").includes("..")) {
    throw new Error(`MG-SOURCE-DIRECTORY-UNSAFE:${value}`);
  }
  return normalized;
}

function assertNestedSourcePath(root: string, candidate: string, configured: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`MG-SOURCE-DIRECTORY-ESCAPES-ROOT:${configured}`);
  }
}

async function collectSourceTreeRecords(root: string, directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  const records: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      records.push(...await collectSourceTreeRecords(root, absolute));
    } else if (entry.isSymbolicLink()) {
      records.push(`link:${relative}:${await readlink(absolute)}`);
    } else if (entry.isFile()) {
      const content = await readFile(absolute);
      records.push(`file:${relative}:${sha256(content.toString("base64"))}`);
    }
  }
  return records;
}

function stableSnapshot(value: ReferenceSourceSnapshot): string {
  return [
    value.identity.revision,
    value.identity.dirty,
    value.identity.dirtyFingerprint,
    value.treeHash,
    value.fileCount
  ].join("\u001f");
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === "ENOENT";
}
