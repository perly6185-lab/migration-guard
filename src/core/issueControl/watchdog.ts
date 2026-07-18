import type { LoadedConfig } from "../../types.js";
import { rollbackToCheckpoint } from "../checkpoint.js";
import { loadRunPackage } from "../migrationRun.js";
import type { IssueControlSuperviseIteration, IssueControlWatchdogRollback } from "../issueControl.js";

export async function runIssueControlWatchdogRollback(
  loaded: LoadedConfig,
  iteration: IssueControlSuperviseIteration
): Promise<IssueControlWatchdogRollback> {
  if (!iteration.runId) return { status: "blocked", error: "Watchdog rollback requires an iteration run id." };
  try {
    const pkg = await loadRunPackage(loaded, iteration.runId);
    const checkpointId = pkg.run.latestCheckpointId;
    if (!checkpointId) return { status: "blocked", error: `Run ${iteration.runId} has no latest checkpoint.` };
    return { status: "executed", checkpointId, message: await rollbackToCheckpoint(loaded, pkg, checkpointId) };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
