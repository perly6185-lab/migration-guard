import type { LoadedConfig } from "../../types.js";
import { runShellCommand } from "../exec.js";

export async function readIssueControlTargetClean(loaded: LoadedConfig): Promise<{ passed: boolean; reason: string }> {
  const result = await runShellCommand("git status --short", {
    cwd: loaded.targetRoot,
    timeoutMs: 30000,
    maxOutputBytes: loaded.config.output.maxOutputBytes
  });
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  if (result.exitCode !== 0 || result.timedOut || result.error) {
    return { passed: false, reason: result.error ?? (output || "git status failed for target root.") };
  }
  return { passed: output.length === 0, reason: output.length === 0 ? "Target repository is clean." : `Target repository has uncommitted changes: ${output}` };
}
