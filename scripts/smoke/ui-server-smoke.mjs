import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const outputDir = process.env.MG_UI_SMOKE_OUTPUT_DIR
  ? path.resolve(root, process.env.MG_UI_SMOKE_OUTPUT_DIR)
  : path.join(os.tmpdir(), "migration-guard-ui-smoke");

await mkdir(outputDir, { recursive: true });

const server = spawn(process.execPath, ["dist/cli.js", "serve", "--port", "0"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  const url = await waitForServerUrl(server);
  const html = await (await fetch(url)).text();
  assertIncludes(html, "Migration Guard", "root HTML title");
  assertIncludes(html, "Run selector", "run selector");
  assertIncludes(html, "New refactoring project", "workspace creation dialog");
  assertIncludes(html, "Source repository directory", "workspace source input");
  assertIncludes(html, "Refactored target directory", "workspace target input");
  assertIncludes(html, "background:#fff", "opaque dialog surface");
  assertIncludes(html, "dialog-close", "dialog close control");
  assertIncludes(html, "Check project", "workspace review action");
  assertIncludes(html, "data-paste-path", "workspace path paste actions");
  assertIncludes(html, "workspacePreviewRevision", "stale workspace preview guard");
  assertIncludes(html, "data-work-view=\"workspace\"", "workspace view navigation");
  assertIncludes(html, "data-work-view=\"execution\"", "execution view navigation");
  assertIncludes(html, "data-work-view=\"monitoring\"", "monitoring view navigation");
  assertIncludes(html, "data-work-view=\"reports\"", "reports view navigation");
  assertIncludes(html, "data-stage=\"baseline\"", "refactoring stage strip");
  assertIncludes(html, "Current step", "guided workflow focus");
  assertIncludes(html, "CLI and advanced next actions", "advanced CLI fallback");
  assertIncludes(html, "Guarded Actions", "guarded actions");
  assertIncludes(html, "Project Workflow", "project workflow");
  assertIncludes(html, "Auto advance", "safe workflow auto advance");
  assertIncludes(html, "Project Portfolio", "project portfolio");
  assertIncludes(html, "Deliverables", "report deliverables");
  assertIncludes(html, "data-requires-workspace", "workspace view locks");
  assertIncludes(html, "Capture Baseline", "baseline action");
  assertIncludes(html, "Create Checkpoint", "checkpoint action");
  assertIncludes(html, "Recovery Center", "recovery center");
  assertIncludes(html, "Project History", "project history");
  assertIncludes(html, "Review plan", "task execution planning");
  assertIncludes(html, "Task Board", "complete task board");
  assertIncludes(html, "Execute task", "task execution confirmation");
  assertIncludes(html, "Run Detail", "run detail");
  assertIncludes(html, "Recent Jobs", "recent jobs");
  assertIncludes(html, "Job status filter", "job status filter");
  assertIncludes(html, "Job run filter", "job run filter");
  assertIncludes(html, "Job Detail", "job detail");
  assertIncludes(html, "jobDuration", "job duration rendering");
  assertIncludes(html, "Job timeline", "job timeline");
  assertIncludes(html, "data-job-retry", "job retry action");
  assertIncludes(html, "data-job-cancel", "job cancel action");
  assertIncludes(html, "jobGcPlan", "job GC controls");
  assertIncludes(html, "data-diff-decision", "diff decision workflow");
  assertIncludes(html, "data-diff-batch-decision", "diff batch decision workflow");
  assertIncludes(html, "aria-label=\"Run selector\"", "run selector aria label");
  assertIncludes(html, "aria-label=\"Job status filter\"", "job status aria label");
  assertIncludes(html, "aria-label=\"Job timeline\"", "job timeline aria label");

  const session = await getJson(`${url}/api/session`);
  if (typeof session.csrfToken !== "string" || session.csrfToken.length < 16) {
    throw new Error("/api/session did not return a CSRF token.");
  }

  const runs = await getJson(`${url}/api/runs`);
  if (!Number.isInteger(runs.runCount)) {
    throw new Error("/api/runs did not return runCount.");
  }
  const workspaces = await getJson(`${url}/api/workspaces`);
  if (!Array.isArray(workspaces.workspaces)) {
    throw new Error("/api/workspaces did not return a workspace registry.");
  }
  const portfolio = await getJson(`${url}/api/workspaces/portfolio`);
  if (!Array.isArray(portfolio.projects)) {
    throw new Error("/api/workspaces/portfolio did not return projects.");
  }

  const capabilities = await getJson(`${url}/api/actions/capabilities`);
  if (!Array.isArray(capabilities.actions) || capabilities.actions.length < 6) {
    throw new Error("/api/actions/capabilities did not return action capabilities.");
  }

  const jobs = await getJson(`${url}/api/jobs`);
  if (!Array.isArray(jobs.jobs)) {
    throw new Error("/api/jobs did not return jobs.");
  }
  const recovery = await getJson(`${url}/api/recovery`);
  if (!Array.isArray(recovery.checkpoints)) {
    throw new Error("/api/recovery did not return checkpoints.");
  }
  const activeJobs = await getJson(`${url}/api/jobs?status=active&limit=5`);
  if (activeJobs.filters?.status !== "active" || activeJobs.filters?.limit !== 5) {
    throw new Error("/api/jobs did not apply status/limit filters.");
  }
  const gcPlan = await postJson(`${url}/api/jobs/gc`, session.csrfToken, {
    keepLatest: 50,
    status: "terminal"
  });
  if (!Array.isArray(gcPlan.candidates) || gcPlan.apply !== false) {
    throw new Error("/api/jobs/gc did not return a dry-run plan.");
  }

  const outsideArtifact = await fetch(`${url}/api/artifact?path=${encodeURIComponent(path.join(root, "package.json"))}`);
  if (outsideArtifact.status !== 403) {
    throw new Error(`/api/artifact allowed an out-of-artifacts path: ${outsideArtifact.status}`);
  }

  const chrome = findChrome();
  if (chrome) {
    await screenshot(chrome, url, "1365,900", path.join(outputDir, "ui-desktop.png"));
    await assertScreenshot(path.join(outputDir, "ui-desktop.png"));
    await screenshot(chrome, url, "390,844", path.join(outputDir, "ui-mobile.png"));
    await assertScreenshot(path.join(outputDir, "ui-mobile.png"));
    await screenshot(chrome, `${url}?newProject=1`, "1365,900", path.join(outputDir, "ui-new-project-desktop.png"));
    await assertScreenshot(path.join(outputDir, "ui-new-project-desktop.png"));
    await screenshot(chrome, `${url}?newProject=1`, "390,844", path.join(outputDir, "ui-new-project-mobile.png"));
    await assertScreenshot(path.join(outputDir, "ui-new-project-mobile.png"));
    for (const view of ["execution", "monitoring", "reports"]) {
      await screenshot(chrome, `${url}?view=${view}`, "1365,900", path.join(outputDir, `ui-${view}-desktop.png`));
      await assertScreenshot(path.join(outputDir, `ui-${view}-desktop.png`));
    }
    await screenshot(chrome, `${url}?view=monitoring`, "390,844", path.join(outputDir, "ui-monitoring-mobile.png"));
    await assertScreenshot(path.join(outputDir, "ui-monitoring-mobile.png"));
    console.log(`Screenshots: ${outputDir}`);
  } else {
    console.log("Chrome not found; skipped screenshot capture.");
  }
  console.log("UI smoke passed.");
} finally {
  server.kill();
}

async function assertScreenshot(outputPath) {
  const stats = await import("node:fs/promises").then((fs) => fs.stat(outputPath));
  if (!stats.isFile() || stats.size < 1000) {
    throw new Error(`Screenshot was not captured correctly: ${outputPath}`);
  }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function postJson(url, csrfToken, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-migration-guard-csrf": csrfToken
    },
    body: JSON.stringify(body || {})
  });
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`Missing ${label}: ${expected}`);
  }
}

async function waitForServerUrl(child) {
  let buffer = "";
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for UI server URL."));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/Migration Guard UI:\s+(http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`UI server exited before ready with code ${code}. Output:\n${buffer}`));
    });
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

async function screenshot(chrome, url, windowSize, outputPath) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "migration-guard-chrome-"));
  await rm(outputPath, { force: true });
  const startedAt = Date.now();
  try {
    await new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile.replace(/\\/g, "/")}`,
      "--virtual-time-budget=5000",
      `--window-size=${windowSize}`,
      `--screenshot=${outputPath.replace(/\\/g, "/")}`,
      url
    ], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Chrome screenshot failed with code ${code}: ${stderr}`));
      }
    });
    });
    await waitForScreenshot(outputPath);
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
  const stats = await import("node:fs/promises").then((fs) => fs.stat(outputPath));
  if (stats.mtimeMs < startedAt) throw new Error(`Screenshot was not refreshed: ${outputPath}`);
}

async function waitForScreenshot(outputPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const stats = await import("node:fs/promises").then((fs) => fs.stat(outputPath)).catch(() => undefined);
    if (stats?.isFile() && stats.size > 1000) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome exited without writing a screenshot: ${outputPath}`);
}
