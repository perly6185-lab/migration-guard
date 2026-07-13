import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const atomicWrites = new Map<string, Promise<void>>();

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeAtomicFile(filePath, content);
}

export async function writeTextFile(filePath: string, value: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeAtomicFile(filePath, value);
}

async function writeAtomicFile(filePath: string, content: string): Promise<void> {
  const previous = atomicWrites.get(filePath) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => replaceAtomicFile(filePath, content));
  atomicWrites.set(filePath, pending);
  try {
    await pending;
  } finally {
    if (atomicWrites.get(filePath) === pending) {
      atomicWrites.delete(filePath);
    }
  }
}

async function replaceAtomicFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function resolveMaybeRelative(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}
