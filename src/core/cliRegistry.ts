import type { CliCommandRegistry, CliCommandRequest } from "./cliDispatch.js";

export const CLI_COMMAND_NAMES = [
  "help", "--help", "-h", "init", "doctor", "config", "health-debt", "scan", "baseline", "verify",
  "compare", "diff", "plan", "ai-brief", "run", "status", "issues", "runs", "serve", "tasks", "actions",
  "report", "readiness", "one-shot", "checkpoint", "resume", "rollback", "task", "action", "proposal",
  "sync-issues", "issue-control", "self-refactor", "ci", "contract", "dual-run", "preview", "artifacts", "handoff", "policy"
] as const;

export type CliCommandName = typeof CLI_COMMAND_NAMES[number];

export function validateCliCommandRegistry<T extends CliCommandRequest>(registry: CliCommandRegistry<T>): void {
  const missing = CLI_COMMAND_NAMES.filter((command) => registry[command] === undefined);
  const unexpected = Object.keys(registry).filter((command) => !CLI_COMMAND_NAMES.includes(command as CliCommandName));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`Invalid CLI command registry; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
  }
}
