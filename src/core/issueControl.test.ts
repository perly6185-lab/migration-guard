import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import {
  advanceIssueControl,
  advanceIssueControlLoop,
  advanceIssueControlScheduler,
  autoIssueControl,
  collectIssueControlPlan,
  issueControlAdvanceLoopStatus,
  issueControlProgressStatus,
  issueControlSyncGate,
  pullIssueControl,
  renderIssueControlPlan,
  renderIssueControlSupervise,
  runIssueControlPlan,
  superviseIssueControl,
  writeIssueControlPlan
} from "./issueControl.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import { captureSnapshot, saveSnapshot } from "./snapshot.js";

test("issue-control pull reads GitHub issues from configured md2 repo", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-control-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify([{
        number: 1,
        title: "Bootstrap md2 target",
        body: [
          "mg_run_id: run-md2",
          "mg_issue_id: issue-bootstrap-md2",
          "mg_issue_type: task",
          "mg_status: ready",
          "mg_risk: high",
          "mg_owner: ai",
          "",
          "Initial import from md into md2."
        ].join("\n"),
        html_url: "https://github.com/perly6185-lab/md2/issues/1",
        state: "open",
        labels: [{ name: "team:migration" }, { name: "bootstrap" }],
        user: { login: "perly6185-lab" },
        created_at: "2026-07-11T00:00:00Z",
        updated_at: "2026-07-11T00:00:00Z"
      }, {
        number: 2,
        title: "Ignore pull request item",
        body: "",
        pull_request: {},
        state: "open",
        labels: []
      }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4999"
        }
      });
    };

    const report = await pullIssueControl(loaded, {
      labels: ["team:migration"],
      fetchImpl: mockFetch
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0]?.url ?? "", /repos\/perly6185-lab\/md2\/issues\?state=open&per_page=100&labels=team%3Amigration/);
    assert.equal((requests[0]?.init?.headers as Record<string, string>)?.authorization, undefined);
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]?.migrationGuard.issueId, "issue-bootstrap-md2");
    assert.equal(report.issues[0]?.migrationGuard.risk, "high");
    assert.match(report.outputPath ?? "", /issue-control-pull-/);
    assert.match(report.markdownPath ?? "", /issue-control-pull-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control plan maps md2 issues into guarded execution actions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-plan-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const pull = {
      version: 1 as const,
      id: "issue-control-pull-test",
      provider: "github" as const,
      repo: "perly6185-lab/md2",
      state: "open" as const,
      labels: [],
      createdAt: "2026-07-11T00:00:00.000Z",
      issueCount: 5,
      rateLimit: [],
      issues: [{
        number: 1,
        title: "Bootstrap md2 target",
        body: "Initial import",
        bodyHash: "hash-1",
        state: "open" as const,
        labels: ["bootstrap"],
        migrationGuard: {
          runId: "run-md2",
          issueId: "issue-bootstrap",
          taskId: "task-bootstrap",
          issueType: "task" as const,
          status: "ready",
          risk: "high" as const
        }
      }, {
        number: 2,
        title: "Proposal gate failed: patch-renderer",
        body: "mg_issue_id: issue-failure\nmg_issue_type: failure\nmg_status: failed",
        bodyHash: "hash-2",
        state: "open" as const,
        labels: [],
        migrationGuard: {
          runId: "run-md2",
          issueId: "issue-failure",
          issueType: "failure" as const,
          status: "failed",
          proposalId: "patch-renderer"
        }
      }, {
        number: 3,
        title: "Ready task",
        body: "mg_issue_id: issue-task",
        bodyHash: "hash-3",
        state: "open" as const,
        labels: [],
        migrationGuard: {
          runId: "run-md2",
          issueId: "issue-task",
          taskId: "task-plan",
          issueType: "task" as const,
          status: "ready"
        }
      }, {
        number: 5,
        title: "Normalize Pinia stores and persistence boundaries",
        body: "Acceptance: store imports stay stable; web tests pass; no app bootstrap drift",
        bodyHash: "hash-5",
        state: "open" as const,
        labels: ["mg-risk:high"],
        migrationGuard: {
          runId: "run-md2",
          issueId: "issue-state-stores",
          issueType: "task" as const,
          status: "planned",
          risk: "high" as const
        }
      }, {
        number: 4,
        title: "User note without metadata",
        body: "Please review.",
        bodyHash: "hash-4",
        state: "open" as const,
        labels: [],
        migrationGuard: {}
      }]
    };

    const plan = collectIssueControlPlan(pull);

    assert.deepEqual(plan.items.map((item) => item.action), [
      "bootstrap-target",
      "repair-proposal",
      "execute-task",
      "track",
      "review-external"
    ]);
    assert.equal(plan.summary.executableCount, 3);
    assert.equal(plan.summary.bootstrapCount, 1);
    assert.match(plan.items[1]?.recommendedCommand ?? "", /proposal repair/);
    assert.match(plan.items[2]?.recommendedCommand ?? "", /task run/);
    assert.equal(plan.items[3]?.reason, "Issue is mapped to Migration Guard but is not ready for automated execution.");
    assert.match(renderIssueControlPlan(plan), /issue-bootstrap/);

    const written = await writeIssueControlPlan(loaded, pull);
    assert.match(written.outputPath ?? "", /issue-control-plan-/);
    assert.equal(written.summary.externalReviewCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control run dry-runs a single executable issue without executing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-run-dry-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const plan = {
      version: 1 as const,
      id: "issue-control-plan-test",
      provider: "github" as const,
      repo: "perly6185-lab/md2",
      sourcePullId: "pull-test",
      createdAt: "2026-07-11T00:00:00.000Z",
      summary: {
        issueCount: 1,
        mappedCount: 1,
        executableCount: 1,
        bootstrapCount: 0,
        repairCount: 0,
        externalReviewCount: 0
      },
      items: [{
        issueNumber: 3,
        title: "Ready task",
        issueId: "issue-task",
        runId: "run-md2",
        taskId: "task-plan",
        issueType: "task" as const,
        status: "ready",
        labels: [],
        action: "execute-task" as const,
        executable: true,
        reason: "Ready task",
        recommendedCommand: "node dist/cli.js task run --config configs/md2-fast.migration-guard.json --run run-md2 --task task-plan"
      }]
    };

    const report = await runIssueControlPlan(loaded, plan, { onlyIssue: "issue-task" });

    assert.equal(report.mode, "dry-run");
    assert.equal(report.status, "planned");
    assert.equal(report.summary.executedCount, 0);
    assert.equal(report.items[0]?.status, "planned");
    assert.match(report.recommendedNextActions[0] ?? "", /--execute --only-issue issue-task/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control run executes one selected task issue", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-run-exec-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    const now = "2026-07-11T00:00:00.000Z";
    const runId = "run-md2";
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "run.json"), {
      version: 1,
      id: runId,
      goal: "issue-control run test",
      sourceRoot: targetRoot,
      targetRoot,
      artifactsDir: path.join(loaded.artifactsDir, "migration-runs", runId),
      status: "planned",
      mode: "dry-run",
      issueProvider: "github",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 0,
        testFiles: 0,
        taskCount: 1,
        riskLevel: "low",
        confidence: "high",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "task-graph.json"), {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      tasks: [{
        id: "task-manual",
        title: "Manual tracked change",
        description: "Track a manual code-change task.",
        type: "code-change",
        status: "ready",
        priority: 1,
        risk: "low",
        owner: "ai",
        dependsOn: [],
        affectedFiles: [],
        verificationCommands: [],
        acceptanceCriteria: [],
        createdAt: now,
        updatedAt: now
      }]
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "issues.json"), []);
    const plan = {
      version: 1 as const,
      id: "issue-control-plan-exec",
      provider: "github" as const,
      repo: "perly6185-lab/md2",
      sourcePullId: "pull-test",
      createdAt: now,
      summary: {
        issueCount: 1,
        mappedCount: 1,
        executableCount: 1,
        bootstrapCount: 0,
        repairCount: 0,
        externalReviewCount: 0
      },
      items: [{
        issueNumber: 7,
        title: "Execute manual task",
        issueId: "issue-manual",
        runId,
        taskId: "task-manual",
        issueType: "task" as const,
        status: "ready",
        labels: [],
        action: "execute-task" as const,
        executable: true,
        reason: "Ready task",
        recommendedCommand: "node dist/cli.js task run --config configs/md2-fast.migration-guard.json --run run-md2 --task task-manual"
      }]
    };

    const report = await runIssueControlPlan(loaded, plan, {
      execute: true,
      onlyIssue: "issue-manual"
    });

    assert.equal(report.mode, "execute");
    assert.equal(report.status, "complete");
    assert.equal(report.summary.executedCount, 1);
    assert.equal(report.items[0]?.status, "executed");
    assert.match(report.items[0]?.result ?? "", /Manual or AI code-change task/);
    assert.match(report.recommendedNextActions[0] ?? "", /sync-issues --live-plan --only-issue issue-manual/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control run execution requires explicit issue selection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-run-safe-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard"
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const plan = {
      version: 1 as const,
      id: "issue-control-plan-safe",
      provider: "github" as const,
      repo: "perly6185-lab/md2",
      sourcePullId: "pull-test",
      createdAt: "2026-07-11T00:00:00.000Z",
      summary: {
        issueCount: 1,
        mappedCount: 1,
        executableCount: 1,
        bootstrapCount: 0,
        repairCount: 0,
        externalReviewCount: 0
      },
      items: [{
        issueNumber: 9,
        title: "Ready task",
        issueId: "issue-ready",
        runId: "run-md2",
        taskId: "task-ready",
        labels: [],
        action: "execute-task" as const,
        executable: true,
        reason: "Ready task"
      }]
    };

    await assert.rejects(
      () => runIssueControlPlan(loaded, plan, { execute: true }),
      /--only-issue/
    );
    await assert.rejects(
      () => runIssueControlPlan(loaded, plan, { maxItems: 2 }),
      /max-items 1/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control auto dry-run skips high risk and selects one safe issue", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-auto-dry-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 1,
      title: "Bootstrap md2 target",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-bootstrap",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: high",
        "mg_task_id: task-bootstrap",
        "",
        "Initial import"
      ].join("\n"),
      state: "open",
      labels: [{ name: "bootstrap" }]
    }, {
      number: 2,
      title: "Ready safe task",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-task",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: medium",
        "mg_task_id: task-plan"
      ].join("\n"),
      state: "open",
      labels: []
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await autoIssueControl(loaded, { fetchImpl: mockFetch });

    assert.equal(report.mode, "dry-run");
    assert.equal(report.status, "planned");
    assert.equal(report.selectedIssueId, "issue-task");
    assert.equal(report.selection.find((item) => item.issueId === "issue-bootstrap")?.selected, false);
    assert.match(report.selection.find((item) => item.issueId === "issue-bootstrap")?.reason ?? "", /High risk/);
    assert.match(report.runPath ?? "", /issue-control-run-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control auto execute runs one selected safe task issue", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-auto-exec-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    const runId = "run-md2";
    const now = "2026-07-11T00:00:00.000Z";
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "run.json"), {
      version: 1,
      id: runId,
      goal: "issue-control auto execute test",
      sourceRoot: targetRoot,
      targetRoot,
      artifactsDir: path.join(loaded.artifactsDir, "migration-runs", runId),
      status: "planned",
      mode: "dry-run",
      issueProvider: "github",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 0,
        testFiles: 0,
        taskCount: 1,
        riskLevel: "low",
        confidence: "high",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "task-graph.json"), {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      tasks: [{
        id: "task-manual",
        title: "Manual tracked change",
        description: "Track a manual code-change task.",
        type: "code-change",
        status: "ready",
        priority: 1,
        risk: "low",
        owner: "ai",
        dependsOn: [],
        affectedFiles: [],
        verificationCommands: [],
        acceptanceCriteria: [],
        createdAt: now,
        updatedAt: now
      }]
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "issues.json"), []);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 3,
      title: "Ready auto task",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-manual",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: low",
        "mg_task_id: task-manual"
      ].join("\n"),
      state: "open",
      labels: []
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await autoIssueControl(loaded, {
      execute: true,
      fetchImpl: mockFetch
    });

    assert.equal(report.mode, "execute");
    assert.equal(report.status, "complete");
    assert.equal(report.selectedIssueId, "issue-manual");
    assert.match(report.runPath ?? "", /issue-control-run-/);
    assert.match(report.recommendedNextActions[0] ?? "", /sync-issues --live-plan --only-issue issue-manual/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control auto blocks when no safe executable item exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-auto-block-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 1,
      title: "High risk bootstrap only",
      body: [
        "mg_issue_id: issue-bootstrap",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: high",
        "mg_task_id: task-bootstrap"
      ].join("\n"),
      state: "open",
      labels: [{ name: "bootstrap" }]
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await autoIssueControl(loaded, { fetchImpl: mockFetch });

    assert.equal(report.status, "blocked");
    assert.equal(report.selectedIssueId, undefined);
    assert.match(report.recommendedNextActions[0] ?? "", /No safe executable issue/);
    assert.equal(report.runPath, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise dry-run plans multiple safe iterations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-dry-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 1,
      title: "High risk bootstrap",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-bootstrap",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: high",
        "mg_task_id: task-bootstrap"
      ].join("\n"),
      state: "open",
      labels: [{ name: "bootstrap" }]
    }, {
      number: 2,
      title: "Proposal gate failed: patch-renderer",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-failure",
        "mg_issue_type: failure",
        "mg_status: failed",
        "mg_risk: medium"
      ].join("\n"),
      state: "open",
      labels: []
    }, {
      number: 3,
      title: "Ready safe task",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-task",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: low",
        "mg_task_id: task-plan"
      ].join("\n"),
      state: "open",
      labels: []
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      labels: ["team:migration"],
      maxIterations: 2
    });

    assert.equal(report.mode, "dry-run");
    assert.equal(report.status, "planned");
    assert.equal(report.summary.selectedCount, 2);
    assert.equal(report.summary.plannedCount, 2);
    assert.deepEqual(report.iterations.map((iteration) => iteration.issueId), ["issue-failure", "issue-task"]);
    assert.equal(report.selection.find((item) => item.issueId === "issue-bootstrap")?.selected, false);
    assert.match(report.progressLedgerPath ?? "", /issue-control-supervise-progress-/);
    const ledger = await readJsonFile<{
      summary: { selectedCount: number; reachedCount: number; unreachedSelectedCount: number };
      items: Array<{ issueId?: string; state: string; selected: boolean; reached: boolean }>;
    }>(report.progressLedgerPath ?? "");
    assert.equal(ledger.summary.selectedCount, 2);
    assert.equal(ledger.summary.reachedCount, 2);
    assert.equal(ledger.summary.unreachedSelectedCount, 0);
    assert.equal(ledger.items.find((item) => item.issueId === "issue-bootstrap")?.selected, false);
    const progress = await issueControlProgressStatus(loaded, { input: report.progressLedgerPath });
    assert.equal(progress.status, "planned");
    assert.equal(progress.summary.selectedCount, 2);
    assert.equal(progress.unresolvedItems.length, 0);
    assert.equal(progress.automationDecision.disposition, "ready-to-execute");
    assert.equal(progress.automationDecision.canAutoContinue, true);
    assert.match(progress.automationDecision.nextCommand ?? "", /issue-control supervise/);
    assert.match(progress.automationDecision.nextCommand ?? "", /--config/);
    assert.match(progress.automationDecision.nextCommand ?? "", /--execute/);
    assert.match(progress.automationDecision.nextCommand ?? "", /--labels team:migration/);
    assert.match(progress.nextActions[0] ?? "", /--execute/);
    assert.match(progress.outputPath ?? "", /issue-control-progress-status-/);
    const advance = await advanceIssueControl(loaded, { input: report.progressLedgerPath });
    assert.equal(advance.status, "planned");
    assert.equal(advance.mode, "dry-run");
    assert.match(advance.nextCommand ?? "", /--execute/);
    assert.equal(advance.superviseReportPath, undefined);
    assert.match(advance.outputPath ?? "", /issue-control-advance-/);
    const advanceLoop = await advanceIssueControlLoop(loaded, {
      input: report.progressLedgerPath,
      maxSteps: 3
    });
    assert.equal(advanceLoop.status, "planned");
    assert.equal(advanceLoop.steps.length, 1);
    assert.equal(advanceLoop.steps[0]?.status, "planned");
    assert.equal(advanceLoop.steps[0]?.sourceLedgerPath, progress.sourceLedgerPath);
    assert.match(advanceLoop.outputPath ?? "", /issue-control-advance-loop-/);
    const loopState = await readJsonFile<{
      status: string;
      sourceLedgerPath?: string;
      lastLoopPath?: string;
      repeatedTerminalCount: number;
      repeatGuardActive: boolean;
      schedulerDecision?: { action: string; canRunUnattended: boolean; requiresHuman: boolean; exitCode: number };
    }>(advanceLoop.loopStatePath ?? "");
    assert.equal(loopState.status, "planned");
    assert.equal(loopState.sourceLedgerPath, progress.sourceLedgerPath);
    assert.equal(loopState.lastLoopPath, advanceLoop.outputPath);
    assert.equal(loopState.repeatedTerminalCount, 0);
    assert.equal(loopState.repeatGuardActive, false);
    assert.equal(loopState.schedulerDecision?.action, "review-plan");
    assert.equal(loopState.schedulerDecision?.canRunUnattended, false);
    assert.equal(loopState.schedulerDecision?.requiresHuman, true);
    assert.equal(loopState.schedulerDecision?.exitCode, 0);
    const executedAdvance = await advanceIssueControl(loaded, {
      input: report.progressLedgerPath,
      execute: true,
      fetchImpl: mockFetch
    });
    assert.equal(executedAdvance.status, "failed");
    assert.equal(executedAdvance.mode, "execute");
    assert.equal(executedAdvance.superviseStatus, "failed");
    assert.match(executedAdvance.superviseReportPath ?? "", /issue-control-supervise-/);
    const executedLoop = await advanceIssueControlLoop(loaded, {
      input: report.progressLedgerPath,
      execute: true,
      maxSteps: 3,
      fetchImpl: mockFetch
    });
    assert.equal(executedLoop.status, "failed");
    assert.equal(executedLoop.steps.length, 1);
    assert.equal(executedLoop.steps[0]?.superviseStatus, "failed");
    assert.match(renderIssueControlSupervise(report), /Issue Control Supervise/);
    assert.match(renderIssueControlSupervise(report), /Progress ledger/);
    assert.match(report.outputPath ?? "", /issue-control-supervise-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise execute runs selected task issues in order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-exec-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    const runId = "run-md2";
    const now = "2026-07-11T00:00:00.000Z";
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "run.json"), {
      version: 1,
      id: runId,
      goal: "issue-control supervise execute test",
      sourceRoot: targetRoot,
      targetRoot,
      artifactsDir: path.join(loaded.artifactsDir, "migration-runs", runId),
      status: "planned",
      mode: "dry-run",
      issueProvider: "github",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 0,
        testFiles: 0,
        taskCount: 2,
        riskLevel: "low",
        confidence: "high",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "task-graph.json"), {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      tasks: ["task-one", "task-two"].map((taskId, index) => ({
        id: taskId,
        title: `Manual tracked change ${index + 1}`,
        description: "Track a manual code-change task.",
        type: "code-change",
        status: "ready",
        priority: index + 1,
        risk: "low",
        owner: "ai",
        dependsOn: [],
        affectedFiles: [],
        verificationCommands: [],
        acceptanceCriteria: [],
        createdAt: now,
        updatedAt: now
      }))
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "issues.json"), []);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 4,
      title: "Ready task one",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-one",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: low",
        "mg_task_id: task-one"
      ].join("\n"),
      state: "open",
      labels: []
    }, {
      number: 5,
      title: "Ready task two",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-two",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: low",
        "mg_task_id: task-two"
      ].join("\n"),
      state: "open",
      labels: []
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      execute: true,
      repairOnFail: true,
      maxIterations: 2
    });

    assert.equal(report.mode, "execute");
    assert.equal(report.status, "complete");
    assert.equal(report.summary.executedCount, 2);
    assert.deepEqual(report.iterations.map((iteration) => iteration.status), ["executed", "executed"]);
    assert.equal(report.recoveryExecutionPath, undefined);
    assert.ok(report.iterations.every((iteration) => iteration.runPath?.includes("issue-control-run-")));
    assert.match(report.recommendedNextActions.join("\n"), /sync-issues --live-plan --only-issue issue-one/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise verify-each compares after executed iterations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-verify-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), "{}", "utf8");
    await saveSnapshot(loaded, await captureSnapshot(loaded, "baseline"));
    const runId = "run-md2";
    const now = "2026-07-11T00:00:00.000Z";
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "run.json"), {
      version: 1,
      id: runId,
      goal: "issue-control supervise verify test",
      sourceRoot: targetRoot,
      targetRoot,
      artifactsDir: path.join(loaded.artifactsDir, "migration-runs", runId),
      status: "planned",
      mode: "dry-run",
      issueProvider: "github",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 0,
        testFiles: 0,
        taskCount: 1,
        riskLevel: "low",
        confidence: "high",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "task-graph.json"), {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      tasks: [{
        id: "task-one",
        title: "Manual tracked change",
        description: "Track a manual code-change task.",
        type: "code-change",
        status: "ready",
        priority: 1,
        risk: "low",
        owner: "ai",
        dependsOn: [],
        affectedFiles: [],
        verificationCommands: [],
        acceptanceCriteria: [],
        createdAt: now,
        updatedAt: now
      }]
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "issues.json"), []);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 6,
      title: "Ready verified task",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-one",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: low",
        "mg_task_id: task-one"
      ].join("\n"),
      state: "open",
      labels: []
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      execute: true,
      verifyEach: true,
      repairOnFail: true,
      maxIterations: 1
    });

    assert.equal(report.status, "complete");
    assert.equal(report.summary.executedCount, 1);
    assert.equal(report.summary.verifiedCount, 1);
    assert.equal(report.iterations[0]?.verification?.status, "passed");
    assert.match(report.iterations[0]?.verification?.compareReportPath ?? "", /supervise-1-.*-compare\.json/);
    assert.match(renderIssueControlSupervise(report), /Verified: 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise verify-each blocks when baseline is missing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-no-baseline-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    const runId = "run-md2";
    const now = "2026-07-11T00:00:00.000Z";
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "run.json"), {
      version: 1,
      id: runId,
      goal: "issue-control supervise missing baseline test",
      sourceRoot: targetRoot,
      targetRoot,
      artifactsDir: path.join(loaded.artifactsDir, "migration-runs", runId),
      status: "planned",
      mode: "dry-run",
      issueProvider: "github",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 0,
        testFiles: 0,
        taskCount: 1,
        riskLevel: "low",
        confidence: "high",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "task-graph.json"), {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      tasks: [{
        id: "task-one",
        title: "Manual tracked change",
        description: "Track a manual code-change task.",
        type: "code-change",
        status: "ready",
        priority: 1,
        risk: "low",
        owner: "ai",
        dependsOn: [],
        affectedFiles: [],
        verificationCommands: [],
        acceptanceCriteria: [],
        createdAt: now,
        updatedAt: now
      }]
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "issues.json"), []);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 7,
      title: "Ready task missing baseline",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-one",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: low",
        "mg_task_id: task-one"
      ].join("\n"),
      state: "open",
      labels: []
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      execute: true,
      verifyEach: true,
      repairOnFail: true,
      maxIterations: 1
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.summary.executedCount, 1);
    assert.equal(report.summary.blockedCount, 1);
    assert.equal(report.iterations[0]?.verification?.status, "blocked");
    assert.equal(report.failureCategory, "missing-baseline");
    assert.equal(report.humanActionRequired, true);
    assert.match(report.recoveryPlanPath ?? "", /issue-control-recovery-plan-/);
    assert.match(report.recoveryExecutionPath ?? "", /issue-control-recovery-execution-/);
    assert.equal(report.recoveryExecutionStatus, "blocked");
    assert.match(report.stopReason ?? "", /blocked/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise recovery plan classifies probe diff", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-compare-diff-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: [{
        name: "state-file",
        type: "command",
        command: `"${process.execPath}" -e "process.stdout.write(require('fs').readFileSync('state.txt','utf8'))"`
      }],
      compare: {
        failOnCheckRegression: true,
        failOnProbeDiff: true
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, "before.ts"), "export const before = 1;\n", "utf8");
    await writeFile(path.join(targetRoot, "state.txt"), "before", "utf8");
    await saveSnapshot(loaded, await captureSnapshot(loaded, "baseline"));
    await writeFile(path.join(targetRoot, "after.ts"), "export const after = 1;\n", "utf8");
    await writeFile(path.join(targetRoot, "state.txt"), "after", "utf8");
    const runId = "run-md2";
    const now = "2026-07-11T00:00:00.000Z";
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "run.json"), {
      version: 1,
      id: runId,
      goal: "issue-control supervise compare diff test",
      sourceRoot: targetRoot,
      targetRoot,
      artifactsDir: path.join(loaded.artifactsDir, "migration-runs", runId),
      status: "planned",
      mode: "dry-run",
      issueProvider: "github",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 1,
        testFiles: 0,
        taskCount: 1,
        riskLevel: "low",
        confidence: "high",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "task-graph.json"), {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      tasks: [{
        id: "task-one",
        title: "Manual tracked change",
        description: "Track a manual code-change task.",
        type: "code-change",
        status: "ready",
        priority: 1,
        risk: "low",
        owner: "ai",
        dependsOn: [],
        affectedFiles: [],
        verificationCommands: [],
        acceptanceCriteria: [],
        createdAt: now,
        updatedAt: now
      }]
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "issues.json"), []);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 8,
      title: "Ready task compare diff",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-one",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: low",
        "mg_task_id: task-one"
      ].join("\n"),
      state: "open",
      labels: []
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      execute: true,
      verifyEach: true,
      maxIterations: 1
    });

    assert.equal(report.status, "failed");
    assert.equal(report.iterations[0]?.verification?.status, "failed");
    assert.equal(report.failureCategory, "probe-diff");
    assert.match(report.recoveryPlanPath ?? "", /issue-control-recovery-plan-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise recovery plan classifies task execution failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-task-failed-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    const runId = "run-md2";
    const now = "2026-07-11T00:00:00.000Z";
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "run.json"), {
      version: 1,
      id: runId,
      goal: "issue-control supervise task failure test",
      sourceRoot: targetRoot,
      targetRoot,
      artifactsDir: path.join(loaded.artifactsDir, "migration-runs", runId),
      status: "planned",
      mode: "dry-run",
      issueProvider: "github",
      createdAt: now,
      updatedAt: now,
      estimate: {
        sourceFiles: 0,
        testFiles: 0,
        taskCount: 0,
        riskLevel: "low",
        confidence: "high",
        estimatedVerificationRounds: 1,
        notes: [],
        updatedAt: now
      }
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "task-graph.json"), {
      version: 1,
      runId,
      createdAt: now,
      updatedAt: now,
      tasks: []
    });
    await writeJsonFile(path.join(loaded.artifactsDir, "migration-runs", runId, "issues.json"), []);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 9,
      title: "Ready missing task",
      body: [
        "mg_run_id: run-md2",
        "mg_issue_id: issue-missing-task",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: low",
        "mg_task_id: task-missing"
      ].join("\n"),
      state: "open",
      labels: []
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      execute: true,
      maxIterations: 1
    });

    assert.equal(report.status, "failed");
    assert.equal(report.failureCategory, "task-execution-failed");
    assert.equal(report.humanActionRequired, true);
    assert.match(report.recoveryPlanPath ?? "", /issue-control-recovery-plan-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise repair-on-fail attempts eligible proposal recovery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-repair-on-fail-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 10,
      title: "Proposal gate failed: patch-one",
      body: [
        "mg_run_id: run-missing",
        "mg_issue_id: issue-proposal-failure",
        "mg_issue_type: failure",
        "mg_status: failed",
        "mg_risk: medium"
      ].join("\n"),
      state: "open",
      labels: []
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      execute: true,
      repairOnFail: true,
      maxIterations: 1
    });

    assert.equal(report.status, "failed");
    assert.equal(report.failureCategory, "proposal-repair-needed");
    assert.equal(report.autoRepairEligible, true);
    assert.match(report.recoveryExecutionPath ?? "", /issue-control-recovery-execution-/);
    assert.equal(report.recoveryExecutionStatus, "failed");
    const execution = await readJsonFile<{ status: string; action: string; error?: string }>(report.recoveryExecutionPath ?? "");
    assert.equal(execution.action, "proposal-repair");
    assert.match(execution.error ?? "", /run-missing|ENOENT|no such file/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise stops after executed repair unless continuation is explicit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-repair-stop-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    await writeIssueControlContinuationRunFixture(loaded.artifactsDir, targetRoot);
    const mockFetch = issueControlContinuationFetch();

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      execute: true,
      repairOnFail: true,
      maxIterations: 2,
      recoveryExecutor: async (_loaded, superviseReport, plan, options) => ({
        version: 1,
        id: "issue-control-recovery-execution-test",
        createdAt: new Date().toISOString(),
        provider: superviseReport.provider,
        repo: superviseReport.repo,
        sourceSuperviseId: superviseReport.id,
        sourceRecoveryPlanId: plan.id,
        mode: options.execute ? "execute" : "dry-run",
        status: "executed",
        failureCategory: plan.failureCategory,
        autoRepairEligible: plan.autoRepairEligible,
        action: "proposal-repair",
        reason: "Injected recovery success for continuation gating test."
      })
    });

    assert.equal(report.status, "failed");
    assert.equal(report.iterations.length, 1);
    assert.equal(report.iterations[0]?.recoveryExecutionStatus, "executed");
    assert.equal(report.iterations[0]?.continuedAfterRepair, undefined);
    assert.equal(report.continuedAfterRepair, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise continues after explicitly executed repair", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-repair-continue-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    await writeIssueControlContinuationRunFixture(loaded.artifactsDir, targetRoot);
    const mockFetch = issueControlContinuationFetch();

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      execute: true,
      repairOnFail: true,
      continueAfterRepair: true,
      maxIterations: 2,
      recoveryExecutor: async (_loaded, superviseReport, plan, options) => ({
        version: 1,
        id: "issue-control-recovery-execution-test",
        createdAt: new Date().toISOString(),
        provider: superviseReport.provider,
        repo: superviseReport.repo,
        sourceSuperviseId: superviseReport.id,
        sourceRecoveryPlanId: plan.id,
        mode: options.execute ? "execute" : "dry-run",
        status: "executed",
        failureCategory: plan.failureCategory,
        autoRepairEligible: plan.autoRepairEligible,
        action: "proposal-repair",
        reason: "Injected recovery success for continuation gating test."
      })
    });

    assert.equal(report.status, "complete");
    assert.equal(report.continuedAfterRepair, true);
    assert.equal(report.continuedAfterRepairCount, 1);
    assert.deepEqual(report.iterations.map((iteration) => iteration.issueId), ["issue-proposal-failure", "issue-next-task"]);
    assert.equal(report.iterations[0]?.continuedAfterRepair, true);
    assert.equal(report.iterations[0]?.recoveryExecutionStatus, "executed");
    assert.equal(report.iterations[1]?.status, "executed");
    assert.equal(report.summary.failedCount, 1);
    assert.equal(report.summary.executedCount, 1);
    const ledger = await readJsonFile<{
      summary: { recoveredCount: number; continuedCount: number; unresolvedCount: number };
      items: Array<{ issueId?: string; state: string; recoveryExecutionStatus?: string; continuedAfterRepair?: boolean }>;
    }>(report.progressLedgerPath ?? "");
    assert.equal(ledger.summary.recoveredCount, 1);
    assert.equal(ledger.summary.continuedCount, 1);
    assert.equal(ledger.summary.unresolvedCount, 0);
    assert.equal(ledger.items.find((item) => item.issueId === "issue-proposal-failure")?.state, "continued");
    assert.equal(ledger.items.find((item) => item.issueId === "issue-proposal-failure")?.recoveryExecutionStatus, "executed");
    assert.equal(ledger.items.find((item) => item.issueId === "issue-next-task")?.state, "executed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise does not continue after failed repair execution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-repair-no-continue-"));
  const configPath = path.join(dir, ".migration-guard.json");
  const targetRoot = path.join(dir, "target");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot,
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      },
      checks: [],
      probes: []
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await mkdir(targetRoot, { recursive: true });
    await writeIssueControlContinuationRunFixture(loaded.artifactsDir, targetRoot);
    const mockFetch = issueControlContinuationFetch();

    const report = await superviseIssueControl(loaded, {
      fetchImpl: mockFetch,
      execute: true,
      repairOnFail: true,
      continueAfterRepair: true,
      maxIterations: 2,
      recoveryExecutor: async (_loaded, superviseReport, plan, options) => ({
        version: 1,
        id: "issue-control-recovery-execution-test",
        createdAt: new Date().toISOString(),
        provider: superviseReport.provider,
        repo: superviseReport.repo,
        sourceSuperviseId: superviseReport.id,
        sourceRecoveryPlanId: plan.id,
        mode: options.execute ? "execute" : "dry-run",
        status: "failed",
        failureCategory: plan.failureCategory,
        autoRepairEligible: plan.autoRepairEligible,
        action: "proposal-repair",
        reason: "Injected recovery failure for continuation gating test."
      })
    });

    assert.equal(report.status, "failed");
    assert.equal(report.iterations.length, 1);
    assert.equal(report.iterations[0]?.recoveryExecutionStatus, "failed");
    assert.match(report.iterations[0]?.recoveryContinuationReason ?? "", /not safe to continue/);
    assert.equal(report.continuedAfterRepair, undefined);
    const ledger = await readJsonFile<{
      summary: { unreachedSelectedCount: number; unresolvedCount: number };
      items: Array<{ issueId?: string; state: string; reached: boolean; reason: string }>;
    }>(report.progressLedgerPath ?? "");
    assert.equal(ledger.summary.unreachedSelectedCount, 1);
    assert.equal(ledger.summary.unresolvedCount, 1);
    assert.equal(ledger.items.find((item) => item.issueId === "issue-next-task")?.state, "selected");
    assert.equal(ledger.items.find((item) => item.issueId === "issue-next-task")?.reached, false);
    const progress = await issueControlProgressStatus(loaded);
    assert.equal(progress.status, "failed");
    assert.equal(progress.automationDecision.disposition, "blocked");
    assert.equal(progress.automationDecision.canAutoContinue, false);
    assert.equal(progress.automationDecision.requiresHuman, true);
    assert.equal(progress.unresolvedItems[0]?.issueId, "issue-proposal-failure");
    assert.equal(progress.unreachedSelectedItems[0]?.issueId, "issue-next-task");
    assert.match(progress.nextActions.join("\n"), /not reached/);
    const advance = await advanceIssueControl(loaded, {
      input: report.progressLedgerPath,
      execute: true,
      fetchImpl: mockFetch
    });
    assert.equal(advance.status, "blocked");
    assert.equal(advance.superviseReportPath, undefined);
    const advanceLoop = await advanceIssueControlLoop(loaded, {
      input: report.progressLedgerPath,
      execute: true,
      maxSteps: 3,
      fetchImpl: mockFetch
    });
    assert.equal(advanceLoop.status, "blocked");
    assert.equal(advanceLoop.steps.length, 1);
    assert.equal(advanceLoop.steps[0]?.superviseReportPath, undefined);
    const loopState = await readJsonFile<{
      status: string;
      sourceLedgerPath?: string;
      repeatedTerminalCount: number;
      repeatGuardActive: boolean;
    }>(advanceLoop.loopStatePath ?? "");
    assert.equal(loopState.status, "blocked");
    assert.equal(loopState.sourceLedgerPath, report.progressLedgerPath);
    assert.equal(loopState.repeatedTerminalCount, 1);
    assert.equal(loopState.repeatGuardActive, false);
    const repeatedLoop = await advanceIssueControlLoop(loaded, {
      input: report.progressLedgerPath,
      execute: true,
      maxSteps: 3,
      fetchImpl: mockFetch
    });
    assert.equal(repeatedLoop.status, "blocked");
    assert.equal(repeatedLoop.steps.length, 0);
    assert.equal(repeatedLoop.repeatGuard?.triggered, true);
    assert.equal(repeatedLoop.repeatGuard?.repeatedTerminalCount, 2);
    assert.match(repeatedLoop.stopReason, /repeat guard/);
    const guardedState = await readJsonFile<{
      repeatedTerminalCount: number;
      repeatGuardActive: boolean;
    }>(repeatedLoop.loopStatePath ?? "");
    assert.equal(guardedState.repeatedTerminalCount, 2);
    assert.equal(guardedState.repeatGuardActive, true);
    const status = await issueControlAdvanceLoopStatus(loaded);
    assert.equal(status.status, "blocked");
    assert.equal(status.sourceLedgerPath, report.progressLedgerPath);
    assert.equal(status.repeatGuardActive, true);
    assert.match(status.nextAction, /Repeat guard/);
    assert.equal(status.schedulerDecision?.action, "stop-for-recovery");
    assert.equal(status.schedulerDecision?.canRunUnattended, false);
    assert.equal(status.schedulerDecision?.requiresHuman, true);
    assert.equal(status.schedulerDecision?.exitCode, 1);
    assert.match(status.schedulerDecision?.reason ?? "", /Repeat guard/);
    const explicitStatus = await issueControlAdvanceLoopStatus(loaded, {
      input: repeatedLoop.loopStatePath
    });
    assert.equal(explicitStatus.lastLoopPath, repeatedLoop.outputPath);
    assert.equal(explicitStatus.schedulerDecision?.action, "stop-for-recovery");
    const forcedLoop = await advanceIssueControlLoop(loaded, {
      input: report.progressLedgerPath,
      execute: true,
      maxSteps: 3,
      ignoreRepeatGuard: true,
      fetchImpl: mockFetch
    });
    assert.equal(forcedLoop.status, "blocked");
    assert.equal(forcedLoop.steps.length, 1);
    assert.equal(forcedLoop.repeatGuard?.triggered, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control supervise blocks when no safe executable issue exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-supervise-block-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify([{
      number: 1,
      title: "High risk bootstrap only",
      body: [
        "mg_issue_id: issue-bootstrap",
        "mg_issue_type: task",
        "mg_status: ready",
        "mg_risk: high",
        "mg_task_id: task-bootstrap"
      ].join("\n"),
      state: "open",
      labels: [{ name: "bootstrap" }]
    }]), { status: 200, headers: { "content-type": "application/json" } });

    const report = await superviseIssueControl(loaded, { fetchImpl: mockFetch });

    assert.equal(report.status, "blocked");
    assert.equal(report.summary.selectedCount, 0);
    assert.equal(report.iterations.length, 0);
    assert.match(report.stopReason ?? "", /No safe executable/);
    const progress = await issueControlProgressStatus(loaded, { input: report.progressLedgerPath });
    assert.equal(progress.status, "blocked");
    assert.equal(progress.automationDecision.disposition, "blocked");
    assert.equal(progress.automationDecision.canAutoContinue, false);
    assert.doesNotMatch(progress.nextActions.join("\n"), /--execute/);
    const advance = await advanceIssueControl(loaded, { input: report.progressLedgerPath });
    assert.equal(advance.status, "blocked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control advance-status treats max-step guard as unattended continuation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-advance-status-max-step-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const statePath = path.join(loaded.artifactsDir, "issue-control", "issue-control-advance-loop-state.json");
    await writeJsonFile(statePath, {
      version: 1,
      id: "issue-control-advance-loop-state",
      updatedAt: "2026-07-11T00:00:00.000Z",
      mode: "execute",
      maxSteps: 3,
      status: "complete",
      stopReason: "Reached max steps 3.",
      sourceLedgerPath: path.join(loaded.artifactsDir, "issue-control", "issue-control-supervise-progress-old.json"),
      lastLoopId: "issue-control-advance-loop-old",
      repeatedTerminalCount: 0,
      repeatGuardActive: false,
      nextAction: "older state without scheduler decision",
      outputPath: statePath,
      markdownPath: statePath.replace(/\.json$/, ".md")
    });

    const status = await issueControlAdvanceLoopStatus(loaded);
    assert.equal(status.schedulerDecision?.action, "run-advance-loop");
    assert.equal(status.schedulerDecision?.canRunUnattended, true);
    assert.equal(status.schedulerDecision?.requiresHuman, false);
    assert.equal(status.schedulerDecision?.exitCode, 0);
    assert.match(status.schedulerDecision?.nextCommand ?? "", /--max-steps 3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control advance-scheduler plans bounded continuation without executing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-advance-scheduler-plan-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const statePath = path.join(loaded.artifactsDir, "issue-control", "issue-control-advance-loop-state.json");
    await writeJsonFile(statePath, {
      version: 1,
      id: "issue-control-advance-loop-state",
      updatedAt: "2026-07-11T00:00:00.000Z",
      mode: "execute",
      maxSteps: 3,
      status: "complete",
      stopReason: "Reached max steps 3.",
      lastLoopId: "issue-control-advance-loop-old",
      repeatedTerminalCount: 0,
      repeatGuardActive: false,
      nextAction: "older state without scheduler decision",
      outputPath: statePath,
      markdownPath: statePath.replace(/\.json$/, ".md")
    });

    const report = await advanceIssueControlScheduler(loaded);

    assert.equal(report.mode, "dry-run");
    assert.equal(report.status, "planned");
    assert.equal(report.schedulerDecision.action, "run-advance-loop");
    assert.match(report.reason, /planned the next bounded advance loop/);
    assert.equal(report.loopReportPath, undefined);
    assert.match(report.outputPath ?? "", /issue-control-advance-scheduler-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control advance-scheduler blocks non-executable recovery decisions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-advance-scheduler-block-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const statePath = path.join(loaded.artifactsDir, "issue-control", "issue-control-advance-loop-state.json");
    await writeJsonFile(statePath, {
      version: 1,
      id: "issue-control-advance-loop-state",
      updatedAt: "2026-07-11T00:00:00.000Z",
      mode: "execute",
      maxSteps: 3,
      status: "blocked",
      stopReason: "Repeat guard is active for the same failed or blocked source ledger.",
      lastLoopId: "issue-control-advance-loop-blocked",
      repeatedTerminalCount: 2,
      repeatGuardActive: true,
      nextAction: "Repeat guard is active.",
      outputPath: statePath,
      markdownPath: statePath.replace(/\.json$/, ".md")
    });

    const report = await advanceIssueControlScheduler(loaded, { execute: true });

    assert.equal(report.mode, "execute");
    assert.equal(report.status, "blocked");
    assert.equal(report.schedulerDecision.action, "stop-for-recovery");
    assert.match(report.reason, /not executable by advance-scheduler/);
    assert.equal(report.loopReportPath, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control advance-scheduler execute dispatches bounded loop and reports blocked result", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-advance-scheduler-execute-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const issueControlDir = path.join(loaded.artifactsDir, "issue-control");
    const statePath = path.join(issueControlDir, "issue-control-advance-loop-state.json");
    const ledgerPath = path.join(issueControlDir, "issue-control-supervise-progress-blocked.json");
    await writeJsonFile(statePath, {
      version: 1,
      id: "issue-control-advance-loop-state",
      updatedAt: "2026-07-11T00:00:00.000Z",
      mode: "execute",
      maxSteps: 2,
      status: "complete",
      stopReason: "Reached max steps 2.",
      sourceLedgerPath: ledgerPath,
      lastLoopId: "issue-control-advance-loop-old",
      repeatedTerminalCount: 0,
      repeatGuardActive: false,
      nextAction: "older state without scheduler decision",
      outputPath: statePath,
      markdownPath: statePath.replace(/\.json$/, ".md")
    });
    await writeJsonFile(ledgerPath, {
      version: 1,
      id: "issue-control-supervise-progress-blocked",
      createdAt: "2026-07-11T00:00:00.000Z",
      sourceSuperviseId: "issue-control-supervise-blocked",
      provider: "github",
      repo: "perly6185-lab/md2",
      mode: "execute",
      status: "failed",
      controlOptions: {
        state: "open",
        labels: ["team:migration"],
        execute: true,
        maxIterations: 2,
        allowHighRisk: false,
        verifyEach: false,
        repairOnFail: false,
        continueAfterRepair: false
      },
      summary: {
        issueCount: 1,
        selectedCount: 1,
        reachedCount: 1,
        unreachedSelectedCount: 0,
        recoveredCount: 0,
        continuedCount: 0,
        unresolvedCount: 1
      },
      items: [{
        issueNumber: 1,
        issueId: "issue-failed",
        runId: "run-md2",
        title: "Failed issue",
        action: "execute-task",
        selected: true,
        reached: true,
        state: "failed",
        reason: "Injected blocked scheduler execution fixture.",
        artifactPaths: [],
        events: []
      }]
    });

    const report = await advanceIssueControlScheduler(loaded, { execute: true });

    assert.equal(report.status, "blocked");
    assert.equal(report.loopStatus, "blocked");
    assert.match(report.loopReportPath ?? "", /issue-control-advance-loop-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control sync-gate writes reviewed live-plan handoff when scheduler is ready to sync", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-sync-gate-ready-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const issueControlDir = path.join(loaded.artifactsDir, "issue-control");
    const statePath = path.join(issueControlDir, "issue-control-advance-loop-state.json");
    const ledgerPath = path.join(issueControlDir, "issue-control-supervise-progress-complete.json");
    await writeJsonFile(ledgerPath, {
      version: 1,
      id: "issue-control-supervise-progress-complete",
      createdAt: "2026-07-11T00:00:00.000Z",
      sourceSuperviseId: "issue-control-supervise-complete",
      provider: "github",
      repo: "perly6185-lab/md2",
      mode: "execute",
      status: "complete",
      summary: {
        issueCount: 1,
        selectedCount: 1,
        reachedCount: 1,
        unreachedSelectedCount: 0,
        recoveredCount: 0,
        continuedCount: 0,
        unresolvedCount: 0
      },
      items: [{
        issueNumber: 7,
        issueId: "issue-done",
        runId: "run-md2",
        title: "Completed issue",
        action: "execute-task",
        selected: true,
        reached: true,
        state: "executed",
        reason: "Completed safely.",
        artifactPaths: [],
        events: []
      }]
    });
    await writeJsonFile(statePath, {
      version: 1,
      id: "issue-control-advance-loop-state",
      updatedAt: "2026-07-11T00:00:00.000Z",
      mode: "execute",
      maxSteps: 3,
      status: "complete",
      stopReason: "Supervision completed.",
      sourceLedgerPath: ledgerPath,
      lastLoopId: "issue-control-advance-loop-complete",
      repeatedTerminalCount: 0,
      repeatGuardActive: false,
      nextAction: "Review completed loop artifacts and refresh md2 issue state.",
      outputPath: statePath,
      markdownPath: statePath.replace(/\.json$/, ".md")
    });

    const report = await issueControlSyncGate(loaded, {
      labels: ["team:migration", "source:md", "target:md2"]
    });

    assert.equal(report.status, "ready");
    assert.equal(report.runId, "run-md2");
    assert.equal(report.runIdSource, "ledger");
    assert.deepEqual(report.completedIssueIds, ["issue-done"]);
    assert.match(report.recommendedSyncCommand ?? "", /sync-issues/);
    assert.match(report.recommendedSyncCommand ?? "", /--run run-md2/);
    assert.match(report.recommendedSyncCommand ?? "", /--live-plan/);
    assert.match(report.recommendedSyncCommand ?? "", /--only-issue issue-done/);
    assert.match(report.recommendedSyncCommand ?? "", /team:migration,source:md,target:md2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control sync-gate stays not-ready while scheduler should continue bounded loops", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-sync-gate-not-ready-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard",
      issueSync: {
        githubRepo: "perly6185-lab/md2"
      }
    }), "utf8");
    const loaded = await loadConfig(configPath);
    const statePath = path.join(loaded.artifactsDir, "issue-control", "issue-control-advance-loop-state.json");
    await writeJsonFile(statePath, {
      version: 1,
      id: "issue-control-advance-loop-state",
      updatedAt: "2026-07-11T00:00:00.000Z",
      mode: "execute",
      maxSteps: 3,
      status: "complete",
      stopReason: "Reached max steps 3.",
      lastLoopId: "issue-control-advance-loop-paused",
      repeatedTerminalCount: 0,
      repeatGuardActive: false,
      nextAction: "Continue the bounded loop.",
      outputPath: statePath,
      markdownPath: statePath.replace(/\.json$/, ".md")
    });

    const report = await issueControlSyncGate(loaded);

    assert.equal(report.status, "not-ready");
    assert.equal(report.schedulerDecision.action, "run-advance-loop");
    assert.equal(report.recommendedSyncCommand, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-control requires a GitHub repo from option or config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-guard-issue-repo-"));
  const configPath = path.join(dir, ".migration-guard.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      targetRoot: ".",
      artifactsDir: ".migration-guard"
    }), "utf8");
    const loaded = await loadConfig(configPath);
    await assert.rejects(
      () => pullIssueControl(loaded, { fetchImpl: async () => new Response("[]") }),
      /issueSync\.githubRepo/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeIssueControlContinuationRunFixture(artifactsDir: string, targetRoot: string): Promise<void> {
  const runId = "run-md2";
  const now = "2026-07-11T00:00:00.000Z";
  await writeJsonFile(path.join(artifactsDir, "migration-runs", runId, "run.json"), {
    version: 1,
    id: runId,
    goal: "issue-control continuation test",
    sourceRoot: targetRoot,
    targetRoot,
    artifactsDir: path.join(artifactsDir, "migration-runs", runId),
    status: "planned",
    mode: "dry-run",
    issueProvider: "github",
    createdAt: now,
    updatedAt: now,
    estimate: {
      sourceFiles: 0,
      testFiles: 0,
      taskCount: 1,
      riskLevel: "low",
      confidence: "high",
      estimatedVerificationRounds: 1,
      notes: [],
      updatedAt: now
    }
  });
  await writeJsonFile(path.join(artifactsDir, "migration-runs", runId, "task-graph.json"), {
    version: 1,
    runId,
    createdAt: now,
    updatedAt: now,
    tasks: [{
      id: "task-next",
      title: "Next safe task",
      description: "Task that proves supervisor continued after recovery.",
      type: "code-change",
      status: "ready",
      priority: 1,
      risk: "low",
      owner: "ai",
      dependsOn: [],
      affectedFiles: [],
      verificationCommands: [],
      acceptanceCriteria: [],
      createdAt: now,
      updatedAt: now
    }]
  });
  await writeJsonFile(path.join(artifactsDir, "migration-runs", runId, "issues.json"), []);
}

function issueControlContinuationFetch(): typeof fetch {
  return async () => new Response(JSON.stringify([{
    number: 11,
    title: "Proposal gate failed: patch-broken",
    body: [
      "mg_run_id: run-missing",
      "mg_issue_id: issue-proposal-failure",
      "mg_issue_type: failure",
      "mg_status: failed",
      "mg_risk: medium"
    ].join("\n"),
    state: "open",
    labels: []
  }, {
    number: 12,
    title: "Next ready task",
    body: [
      "mg_run_id: run-md2",
      "mg_issue_id: issue-next-task",
      "mg_issue_type: task",
      "mg_status: ready",
      "mg_risk: low",
      "mg_task_id: task-next"
    ].join("\n"),
    state: "open",
    labels: []
  }]), { status: 200, headers: { "content-type": "application/json" } });
}
