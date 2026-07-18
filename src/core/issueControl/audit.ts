import { promises as fs } from "node:fs";
import path from "node:path";
import type { LoadedConfig } from "../../types.js";

export function issueControlAuditLogPath(loaded: LoadedConfig): string {
  return path.join(loaded.artifactsDir, "issue-control", "issue-control-unattended-audit.jsonl");
}

export async function appendIssueControlAudit(
  loaded: LoadedConfig,
  event: Record<string, unknown>
): Promise<void> {
  const filePath = issueControlAuditLogPath(loaded);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    ...event
  })}\n`, "utf8");
}
