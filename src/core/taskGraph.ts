import type {
  MigrationEstimate,
  MigrationTask,
  MigrationTaskGraph,
  MigrationTaskStatus,
  ScanSummary
} from "../types.js";

export function createTaskGraph(runId: string, scan: ScanSummary, goal: string, adapter?: string): MigrationTaskGraph {
  const createdAt = new Date().toISOString();
  const tasks: MigrationTask[] = [
    createTask("task-analyze", "Analyze repository", "Scan project structure, stack hints, dependency edges, and high-risk files.", "analyze", [], "engine", "low", 10, [], ["scan summary exists"], createdAt),
    createTask("task-baseline", "Capture behavior baseline", "Run configured checks and probes before migration changes.", "baseline", ["task-analyze"], "engine", "medium", 20, [], ["latest baseline exists"], createdAt),
    createTask("task-plan", "Create migration plan", "Generate the first migration task graph and verification strategy.", "plan", ["task-baseline"], "engine", "medium", 30, [], ["task graph is valid"], createdAt),
    createTask("task-verify", "Verify migrated behavior", "Run checks and behavior probes against the target project.", "verify", ["task-plan"], "engine", "medium", 80, [], ["critical checks pass", "probe differences are resolved or accepted"], createdAt),
    createTask("task-report", "Generate final report", "Summarize completed tasks, unresolved risks, accepted differences, and final verification evidence.", "report", ["task-verify"], "engine", "low", 100, [], ["final report exists"], createdAt)
  ];

  const goalText = `${goal} ${adapter ?? ""}`.toLowerCase();
  if (goalText.includes("webpack") || goalText.includes("vite") || adapter === "js-vite") {
    tasks.splice(
      3,
      0,
      createTask("task-js-vite-package", "Update package scripts for Vite", "Replace common Webpack dev/build scripts with Vite equivalents when package.json contains Webpack signals.", "adapter", ["task-plan"], "engine", "medium", 40, ["package.json"], ["package scripts are Vite-compatible"], createdAt, "js-vite:package"),
      createTask("task-js-vite-config", "Create Vite config scaffold", "Create a conservative vite.config.ts when the project has Webpack signals and no Vite config.", "adapter", ["task-js-vite-package"], "engine", "medium", 50, ["vite.config.ts"], ["Vite config exists or is intentionally skipped"], createdAt, "js-vite:config"),
      createTask("task-js-vite-env", "Check environment variable compatibility", "Inspect source files for Webpack-specific environment access and report required follow-up work.", "adapter", ["task-js-vite-config"], "engine", "medium", 60, [], ["environment compatibility report exists"], createdAt, "js-vite:env")
    );
    const verify = tasks.find((task) => task.id === "task-verify");
    if (verify) {
      verify.dependsOn = ["task-js-vite-env"];
    }
  } else {
    const firstRisk = scan.riskFiles[0];
    tasks.splice(
      3,
      0,
      createTask("task-low-risk-change", "Execute first low-risk migration task", "Make the first scoped behavior-preserving migration change, preferably in a leaf module.", "code-change", ["task-plan"], "ai", firstRisk && firstRisk.score >= 30 ? "high" : "medium", 40, firstRisk ? [firstRisk.path] : [], ["change is scoped", "verification command is known"], createdAt)
    );
    const verify = tasks.find((task) => task.id === "task-verify");
    if (verify) {
      verify.dependsOn = ["task-low-risk-change"];
    }
  }

  markReadyTasks(tasks);

  return {
    version: 1,
    runId,
    createdAt,
    updatedAt: createdAt,
    tasks
  };
}

export function createEstimate(scan: ScanSummary, graph: MigrationTaskGraph): MigrationEstimate {
  const highRiskFiles = scan.riskFiles.filter((file) => file.score >= 30).length;
  const riskLevel = highRiskFiles >= 5 || scan.sourceFiles >= 500
    ? "high"
    : highRiskFiles >= 1 || scan.sourceFiles >= 80
      ? "medium"
      : "low";
  const confidence = scan.testFiles === 0
    ? "low"
    : scan.testFiles >= Math.max(3, Math.ceil(scan.sourceFiles * 0.2))
      ? "high"
      : "medium";

  return {
    sourceFiles: scan.sourceFiles,
    testFiles: scan.testFiles,
    taskCount: graph.tasks.length,
    riskLevel,
    confidence,
    estimatedVerificationRounds: Math.max(2, Math.ceil(graph.tasks.length / 2)),
    notes: [
      `Package manager: ${scan.packageManager}`,
      `Stack hints: ${scan.stackHints.join(", ") || "none"}`,
      `High-risk files: ${scan.riskFiles.length}`
    ],
    updatedAt: new Date().toISOString()
  };
}

export function validateTaskGraph(graph: MigrationTaskGraph): string[] {
  const errors: string[] = [];
  const ids = new Set(graph.tasks.map((task) => task.id));

  for (const task of graph.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        errors.push(`Task ${task.id} depends on missing task ${dependency}.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));

  function visit(id: string): void {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      errors.push(`Task graph contains a dependency cycle at ${id}.`);
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const task of graph.tasks) {
    visit(task.id);
  }

  return errors;
}

export function getReadyTasks(graph: MigrationTaskGraph): MigrationTask[] {
  const done = new Set(graph.tasks.filter((task) => task.status === "done").map((task) => task.id));
  return graph.tasks.filter((task) => task.status === "ready" && task.dependsOn.every((dependency) => done.has(dependency)));
}

export function updateTaskStatus(graph: MigrationTaskGraph, taskId: string, status: MigrationTaskStatus, result?: string): MigrationTask | undefined {
  const task = graph.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return undefined;
  }

  task.status = status;
  task.updatedAt = new Date().toISOString();
  if (result !== undefined) {
    task.result = result;
  }
  markReadyTasks(graph.tasks);
  graph.updatedAt = new Date().toISOString();
  return task;
}

export function insertFailureTask(graph: MigrationTaskGraph, failedTaskId: string, title: string, message: string): MigrationTask {
  const createdAt = new Date().toISOString();
  const task = createTask(
    `task-failure-${Date.now()}`,
    title,
    message,
    "replan",
    [failedTaskId],
    "engine",
    "high",
    70,
    [],
    ["failure is analyzed", "follow-up task is planned"],
    createdAt
  );
  graph.tasks.push(task);
  markReadyTasks(graph.tasks);
  graph.updatedAt = createdAt;
  return task;
}

function createTask(
  id: string,
  title: string,
  description: string,
  type: MigrationTask["type"],
  dependsOn: string[],
  owner: MigrationTask["owner"],
  risk: MigrationTask["risk"],
  priority: number,
  affectedFiles: string[],
  acceptanceCriteria: string[],
  createdAt: string,
  executor?: string
): MigrationTask {
  return {
    id,
    title,
    description,
    type,
    status: dependsOn.length === 0 ? "ready" : "planned",
    priority,
    risk,
    owner,
    dependsOn,
    affectedFiles,
    verificationCommands: ["migration-guard verify"],
    acceptanceCriteria,
    executor,
    createdAt,
    updatedAt: createdAt
  };
}

function markReadyTasks(tasks: MigrationTask[]): void {
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  for (const task of tasks) {
    if (task.status === "planned" && task.dependsOn.every((dependency) => done.has(dependency))) {
      task.status = "ready";
      task.updatedAt = new Date().toISOString();
    }
  }
}
