import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { collectDashboard, collectDashboardBlockers, collectRunsList } from "./dashboard.js";
import { pathExists } from "./files.js";
import { loadRunPackage } from "./migrationRun.js";
import { superviseIssueControl } from "./issueControl.js";
import {
  assessRefactorReadiness,
  writeRefactorReadinessReport
} from "./refactorReadiness.js";
import { captureSnapshot, saveSnapshot } from "./snapshot.js";
import { UiHttpError } from "./uiHttpError.js";
import { readArtifactText } from "./uiArtifacts.js";
import { collectActionCapabilities, requireActionCapability } from "./uiActionCapabilities.js";
import {
  collectDiffArtifacts,
  recordUiDiffDecision,
  recordUiDiffDecisionBatch
} from "./uiDiffService.js";
import {
  cancelUiJob,
  collectUiJobDetail,
  createUiJobRunner,
  createUiActionJob,
  gcUiJobs,
  listUiJobs,
  readUiJob,
  recoverOrphanUiJobs,
  uiActionIdParam,
  uiJobSearchParams
} from "./uiJobService.js";
import {
  createUiCsrfToken,
  readUiPostParams,
  requireCsrfToken,
  sendHtml,
  sendJson,
  sendText,
  positiveIntegerParam,
  trimmedParam
} from "./uiRequest.js";
import type { UiActionId } from "./uiJobTypes.js";
import { applyUiRecoveryPlan, collectUiRecovery, writeUiRecoveryPlan } from "./uiRecovery.js";
import { writeUiTaskExecutionPlan } from "./uiTaskExecution.js";
import {
  archiveUiWorkspace,
  collectActiveUiWorkspaceOverview,
  createUiWorkspace,
  listUiWorkspaces,
  previewUiWorkspace,
  resolveActiveUiWorkspace,
  selectUiWorkspace,
  type UiWorkspaceInput
} from "./uiWorkspace.js";
import type {
  LoadedConfig
} from "../types.js";

export interface UiServerOptions {
  host?: string;
  port?: number;
  open?: boolean;
  fetchImpl?: typeof fetch;
}

type UiServerRequestOptions = UiServerOptions & {
  jobRunner: ReturnType<typeof createUiJobRunner>;
};

export interface UiServerHandle {
  url: string;
  server: http.Server;
  close: () => Promise<void>;
}

export async function startUiServer(
  loaded: LoadedConfig,
  options: UiServerOptions = {}
): Promise<UiServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  await recoverOrphanUiJobs(loaded);
  const initialWorkspace = await resolveActiveUiWorkspace(loaded);
  if (initialWorkspace.workspace) await recoverOrphanUiJobs(initialWorkspace.loaded);
  const jobRunner = createUiJobRunner();
  const requestOptions = { ...options, jobRunner };
  const csrfToken = createUiCsrfToken();
  const server = http.createServer((request, response) => {
    void handleUiRequest(loaded, requestOptions, csrfToken, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  return {
    url,
    server,
    close: async () => {
      let closeError: Error | undefined;
      await new Promise<void>((resolve) => {
        server.close((error) => {
          closeError = error ?? undefined;
          resolve();
        });
      });
      await jobRunner.drain();
      if (closeError) throw closeError;
    }
  };
}

async function handleUiRequest(
  hostLoaded: LoadedConfig,
  options: UiServerRequestOptions,
  csrfToken: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, renderUiHtml(csrfToken));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/session") {
      sendJson(response, { version: 1, csrfToken });
      return;
    }
    if (request.method === "POST") {
      requireCsrfToken(request, csrfToken);
    }
    if (request.method === "GET" && url.pathname === "/api/workspaces") {
      sendJson(response, await listUiWorkspaces(hostLoaded));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/workspaces/active") {
      sendJson(response, await collectActiveUiWorkspaceOverview(hostLoaded));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/workspaces/preview") {
      sendJson(response, await previewUiWorkspace(workspaceInput(await readUiPostParams(request, url.searchParams))));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/workspaces") {
      sendJson(response, await createUiWorkspace(hostLoaded, workspaceInput(await readUiPostParams(request, url.searchParams))), 201);
      return;
    }
    const selectWorkspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/select$/);
    if (request.method === "POST" && selectWorkspaceMatch) {
      const workspace = await selectUiWorkspace(hostLoaded, selectWorkspaceMatch[1] ?? "");
      const selected = await resolveActiveUiWorkspace(hostLoaded);
      await recoverOrphanUiJobs(selected.loaded);
      sendJson(response, workspace);
      return;
    }
    const archiveWorkspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/archive$/);
    if (request.method === "POST" && archiveWorkspaceMatch) {
      sendJson(response, await archiveUiWorkspace(hostLoaded, archiveWorkspaceMatch[1] ?? ""));
      return;
    }
    const activeWorkspace = await resolveActiveUiWorkspace(hostLoaded);
    const loaded = activeWorkspace.loaded;
    if (request.method === "GET" && url.pathname === "/api/recovery") {
      sendJson(response, await collectUiRecovery(loaded, url.searchParams.get("run") ?? "latest"));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/recovery/plan") {
      const params = await readUiPostParams(request, url.searchParams);
      const checkpointId = trimmedParam(params, "checkpoint");
      if (!checkpointId) throw new UiHttpError("checkpoint is required", 400);
      sendJson(response, await writeUiRecoveryPlan(loaded, params.get("run") ?? "latest", checkpointId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/recovery/apply") {
      const params = await readUiPostParams(request, url.searchParams);
      const planHash = trimmedParam(params, "planHash");
      if (!planHash) throw new UiHttpError("planHash is required", 400);
      sendJson(response, await applyUiRecoveryPlan(loaded, params.get("run") ?? "latest", planHash));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/tasks/plan") {
      const params = await readUiPostParams(request, url.searchParams);
      const taskId = trimmedParam(params, "task");
      if (!taskId) throw new UiHttpError("task is required", 400);
      sendJson(response, await writeUiTaskExecutionPlan(loaded, params.get("run") ?? "latest", taskId));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(response, await collectDashboard(loaded, {
        runId: url.searchParams.get("run") ?? undefined,
        checkTargetGit: true
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/blockers") {
      sendJson(response, await collectDashboardBlockers(loaded, {
        runId: url.searchParams.get("run") ?? undefined,
        checkTargetGit: true
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/runs") {
      sendJson(response, await collectRunsList(loaded));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/diffs") {
      sendJson(response, await collectDiffArtifacts(loaded, url.searchParams.get("run") ?? undefined));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/audit") {
      sendJson(response, await readAuditLog(loaded));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/actions/capabilities") {
      sendJson(response, await collectActionCapabilities(loaded, url.searchParams));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/artifact") {
      const artifact = await readArtifactText(loaded, url.searchParams.get("path"));
      sendText(response, artifact.content, artifact.contentType, url.searchParams.get("download") === "1" ? path.basename(url.searchParams.get("path") ?? "artifact.txt") : undefined);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      sendJson(response, await listUiJobs(loaded, url.searchParams));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/jobs/gc") {
      sendJson(response, await gcUiJobs(loaded, await readUiPostParams(request, url.searchParams), options.jobRunner));
      return;
    }
    const jobDetailMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/detail$/);
    if (request.method === "GET" && jobDetailMatch) {
      sendJson(response, await collectUiJobDetail(loaded, jobDetailMatch[1] ?? ""));
      return;
    }
    const cancelJobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelJobMatch) {
      sendJson(response, await cancelUiJob(loaded, cancelJobMatch[1] ?? "", options.jobRunner));
      return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      sendJson(response, await readUiJob(loaded, jobMatch[1] ?? ""));
      return;
    }
    const retryJobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (request.method === "POST" && retryJobMatch) {
      const previousJob = await readUiJob(loaded, retryJobMatch[1] ?? "");
      if (previousJob.action === "task-execute") {
        sendJson(response, { error: "Task execution requires a fresh reviewed plan and cannot be retried directly." }, 409);
        return;
      }
      if (previousJob.status !== "failed") {
        sendJson(response, { error: "Only failed jobs can be retried." }, 409);
        return;
      }
      const retryParams = uiJobSearchParams(previousJob);
      const unavailable = await requireActionCapability(loaded, retryParams, previousJob.action);
      if (unavailable) {
        sendJson(response, unavailable, 409);
        return;
      }
      sendJson(response, await createUiActionJob(loaded, options, previousJob.action, retryParams, {
        retryOf: previousJob.id
      }), 202);
      return;
    }
    const jobActionMatch = url.pathname.match(/^\/api\/jobs\/actions\/([^/]+)$/);
    if (request.method === "POST" && jobActionMatch) {
      const action = uiActionIdParam(jobActionMatch[1] ?? "");
      const params = await readUiPostParams(request, url.searchParams);
      const unavailable = await requireActionCapability(loaded, params, action);
      if (unavailable) {
        sendJson(response, unavailable, 409);
        return;
      }
      sendJson(response, await createUiActionJob(loaded, options, action, params), 202);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/actions/readiness") {
      const params = await readUiPostParams(request, url.searchParams);
      const unavailable = await requireActionCapability(loaded, params, "readiness");
      if (unavailable) {
        sendJson(response, unavailable, 409);
        return;
      }
      const pkg = await loadRunPackage(loaded, params.get("run") ?? "latest");
      sendJson(response, await writeRefactorReadinessReport(loaded, pkg, await assessRefactorReadiness(loaded, pkg)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/actions/verify") {
      const params = await readUiPostParams(request, url.searchParams);
      const unavailable = await requireActionCapability(loaded, params, "verify");
      if (unavailable) {
        sendJson(response, unavailable, 409);
        return;
      }
      const snapshotPath = await saveSnapshot(loaded, await captureSnapshot(loaded, "run"));
      sendJson(response, { status: "complete", snapshotPath });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/actions/issue-control-dry-run") {
      const params = await readUiPostParams(request, url.searchParams);
      const unavailable = await requireActionCapability(loaded, params, "issue-control-dry-run");
      if (unavailable) {
        sendJson(response, unavailable, 409);
        return;
      }
      const labels = params.get("labels")?.split(",").map((label) => label.trim()).filter(Boolean);
      const repo = trimmedParam(params, "repo");
      sendJson(response, await superviseIssueControl(loaded, {
        repo,
        labels,
        execute: false,
        fetchImpl: options.fetchImpl,
        maxIterations: positiveIntegerParam(params, "maxIterations") ?? 3
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/actions/diff-decision") {
      sendJson(response, await recordUiDiffDecision(loaded, await readUiPostParams(request, url.searchParams)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/actions/diff-decision-batch") {
      sendJson(response, await recordUiDiffDecisionBatch(loaded, await readUiPostParams(request, url.searchParams)));
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  } catch (error) {
    sendJson(response, { error: error instanceof Error ? error.message : String(error) }, error instanceof UiHttpError ? error.status : 500);
  }
}

function workspaceInput(params: URLSearchParams): UiWorkspaceInput {
  return {
    name: params.get("name") ?? "",
    sourceRoot: params.get("sourceRoot") ?? "",
    targetRoot: params.get("targetRoot") ?? "",
    goal: params.get("goal") ?? ""
  };
}

async function resolveOptionalRunId(loaded: LoadedConfig, runSelector: string | undefined): Promise<string | undefined> {
  return runSelector ? (await loadRunPackage(loaded, runSelector)).run.id : undefined;
}

async function readAuditLog(loaded: LoadedConfig): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(loaded.artifactsDir, "issue-control", "issue-control-unattended-audit.jsonl");
  if (!await pathExists(filePath)) {
    return [];
  }
  const content = await fs.readFile(filePath, "utf8");
  return content.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function renderUiHtml(csrfToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Migration Guard</title>
  <style>
    :root { color-scheme: light; --bg:#f5f7fa; --panel:#ffffff; --ink:#1f252e; --muted:#5f6978; --line:#d8dee7; --soft:#eef2f7; --ok:#13795b; --warn:#9a6700; --bad:#c52727; --blue:#1f5fbf; --blue-soft:#e9f1ff; }
    * { box-sizing:border-box; }
    body { margin:0; font:14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--ink); overflow-x:hidden; }
    header { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:14px 18px; background:#222831; color:white; position:sticky; top:0; z-index:2; }
    h1 { margin:0; font-size:18px; font-weight:700; }
    main { display:grid; grid-template-columns:320px 1fr; gap:14px; padding:14px; }
    aside, .stack { display:grid; align-content:start; gap:14px; min-width:0; }
    section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; min-width:0; }
    h2 { margin:0; font-size:15px; }
    h3 { margin:14px 0 8px; font-size:13px; }
    button, select, input { border:1px solid var(--line); background:white; color:var(--ink); border-radius:6px; padding:7px 9px; font:inherit; }
    button { cursor:pointer; }
    button:hover:not(:disabled) { border-color:var(--blue); color:var(--blue); }
    button:disabled { cursor:not-allowed; opacity:.56; }
    select { min-width:260px; max-width:48vw; overflow:hidden; text-overflow:ellipsis; }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:7px 6px; vertical-align:top; word-break:break-word; }
    th { color:var(--muted); font-weight:600; }
    details { border:1px solid var(--line); border-radius:8px; padding:9px 10px; background:#fbfcfd; }
    details + details { margin-top:8px; }
    summary { cursor:pointer; font-weight:600; }
    pre { max-height:260px; overflow:auto; background:#111827; color:#e5e7eb; padding:10px; border-radius:8px; }
    code, .mono { font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; }
    .toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .toolbar.compact select { min-width:120px; max-width:180px; }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
    .grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }
    .stat { border:1px solid var(--line); border-radius:8px; padding:10px; background:#fbfcfd; min-height:74px; }
    .stat span { display:block; color:var(--muted); }
    .stat strong { display:block; font-size:24px; line-height:1.15; margin-top:3px; }
    .stat.ok strong { color:var(--ok); } .stat.warn strong { color:var(--warn); } .stat.bad strong { color:var(--bad); }
    .actions { display:flex; flex-wrap:wrap; gap:8px; }
    .action-form { display:grid; gap:8px; margin-top:10px; }
    .field { display:grid; gap:4px; color:var(--muted); }
    .field input { width:100%; color:var(--ink); }
    .action-note, .muted { color:var(--muted); }
    .action-note { margin:10px 0 0; }
    .status-line { margin-top:10px; border:1px solid var(--line); border-radius:8px; padding:9px 10px; background:#fbfcfd; }
    .status-line.ok { border-color:#9bd3be; background:#ecf8f3; }
    .status-line.bad { border-color:#efb2b2; background:#fff1f1; }
    .error { border:1px solid #efb2b2; background:#fff1f1; color:#8c1d1d; border-radius:8px; padding:9px 10px; }
    .badge { display:inline-flex; align-items:center; border-radius:999px; padding:2px 8px; font-size:12px; background:var(--soft); color:var(--muted); }
    .badge.bad { background:#fff1f1; color:var(--bad); }
    .badge.warn { background:#fff8e6; color:var(--warn); }
    .badge.ok { background:#ecf8f3; color:var(--ok); }
    .blocker-list { display:grid; gap:8px; }
    .blocker { border:1px solid var(--line); border-radius:8px; padding:10px; background:#fbfcfd; }
    .blocker-title { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
    .blocker-title strong { font-size:14px; }
    .evidence { margin:8px 0 0; padding-left:18px; color:var(--muted); }
    .command { display:flex; align-items:flex-start; gap:8px; margin-top:8px; padding:8px; border-radius:8px; background:var(--blue-soft); }
    .command code { flex:1; min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
    .copy { flex:0 0 auto; padding:4px 7px; font-size:12px; }
    .artifact { color:var(--blue); text-decoration:none; }
    .artifact:hover { text-decoration:underline; }
    .table-wrap { overflow:auto; }
    .kv { display:grid; grid-template-columns:140px minmax(0, 1fr); gap:7px 12px; }
    .kv dt { color:var(--muted); }
    .kv dd { margin:0; min-width:0; overflow-wrap:anywhere; }
    .item-list { display:grid; gap:8px; }
    .run-meta, summary, .blocker, td { overflow-wrap:anywhere; word-break:break-word; }
    .run-meta { margin:10px 0 0; color:var(--muted); }
    .diff-meta { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
    .diff-decision { border-top:1px solid var(--line); padding-top:10px; margin-top:10px; }
    .decision-form { display:grid; grid-template-columns:160px minmax(180px, 1fr) minmax(140px, 220px) auto; gap:8px; align-items:end; margin-top:8px; }
    .decision-form label { display:grid; gap:4px; color:var(--muted); }
    .decision-form input, .decision-form select { width:100%; }
    .timeline { margin:10px 0 0; padding:0; list-style:none; display:grid; gap:7px; }
    .timeline li { border-left:3px solid var(--line); padding-left:9px; color:var(--muted); }
    .timeline strong { color:var(--ink); }
    .job-actions { margin-top:10px; }
    .empty { margin:0; color:var(--muted); }
    dialog { width:min(680px, calc(100vw - 28px)); max-height:calc(100vh - 28px); overflow:auto; overflow-x:hidden; border:1px solid #aeb8c5; border-radius:8px; padding:0; color:var(--ink); background:#fff; box-shadow:0 24px 70px rgba(8,15,24,.38); }
    dialog::backdrop { background:rgba(18,25,34,.68); backdrop-filter:blur(2px); }
    .dialog-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px 18px; border-bottom:1px solid var(--line); background:#f7f9fc; position:sticky; top:0; z-index:1; }
    .dialog-head h2 { margin:0; font-size:17px; }
    .dialog-close { width:34px; height:34px; display:grid; place-items:center; padding:0; font-size:22px; line-height:1; color:var(--muted); }
    .dialog-body { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px 16px; padding:20px 18px; background:#fff; }
    .dialog-body > * { min-width:0; }
    .dialog-body .field { color:#374151; font-weight:600; }
    .dialog-body .field input { min-height:40px; font-weight:400; background:#fbfcfe; border-color:#c8d0db; }
    .dialog-body .field input:focus { outline:2px solid rgba(31,95,191,.18); border-color:var(--blue); background:#fff; }
    .dialog-body .path-field, .dialog-body .goal-field, .dialog-body .status-line { grid-column:1 / -1; }
    .dialog-body .path-field input { font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:13px; }
    .dialog-actions { display:flex; justify-content:flex-end; gap:8px; padding:14px 18px; border-top:1px solid var(--line); background:#f7f9fc; position:sticky; bottom:0; }
    .primary-button { background:var(--blue); border-color:var(--blue); color:#fff; font-weight:600; }
    .primary-button:hover:not(:disabled) { background:#174e9d; border-color:#174e9d; color:#fff; }
    .workspace-summary { padding:10px; border-left:3px solid var(--blue); background:var(--blue-soft); }
    @media (max-width:900px) {
      header { align-items:flex-start; }
      main { grid-template-columns:1fr; }
      select { min-width:0; max-width:100%; width:100%; }
      .toolbar { width:100%; }
      .toolbar button { flex:0 0 auto; }
    }
    @media (max-width:520px) {
      header { display:grid; }
      .toolbar { display:grid; grid-template-columns:minmax(0, 1fr); }
      .toolbar button { width:max-content; }
      select { width:calc(100vw - 36px); }
      .toolbar.compact { grid-template-columns:1fr; }
      .toolbar.compact select { max-width:100%; }
      .kv { grid-template-columns:1fr; }
      .grid { grid-template-columns:1fr; }
      .command { display:grid; }
      .decision-form { grid-template-columns:1fr; }
      .actions { display:grid; grid-template-columns:1fr; }
      .actions button { width:100%; }
      dialog { left:auto; right:auto; width:calc(100vw - 64px); min-width:0; max-width:340px; max-height:calc(100vh - 16px); margin:auto; }
      .dialog-body { grid-template-columns:1fr; padding:16px; }
      .dialog-body .field { grid-column:1; }
      .dialog-body input { min-width:0; max-width:100%; }
      .dialog-body .status-line { overflow-wrap:anywhere; }
      .dialog-actions { padding:12px 16px; flex-wrap:wrap; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Migration Guard</h1>
    <div class="toolbar">
      <select id="workspaceSelect" aria-label="Project selector"><option value="">Host project</option></select>
      <button id="newWorkspace">New project</button>
      <select id="runSelect" aria-label="Run selector"><option value="">latest</option></select>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <dialog id="workspaceDialog">
    <div class="dialog-head"><h2>New refactoring project</h2><button id="closeWorkspace" class="dialog-close" title="Close" aria-label="Close">&times;</button></div>
    <div class="dialog-body">
      <label class="field">Project name <input id="workspaceName" autocomplete="off" placeholder="Checkout service migration"></label>
      <label class="field goal-field">Refactoring goal <input id="workspaceGoal" autocomplete="off" placeholder="Migrate the service while preserving behavior"></label>
      <label class="field path-field">Source repository directory <input id="workspaceSource" autocomplete="off" placeholder="D:\\projects\\legacy-service"></label>
      <label class="field path-field">Refactored target directory <input id="workspaceTarget" autocomplete="off" placeholder="D:\\projects\\new-service"></label>
      <div id="workspacePreview" class="status-line">Enter both local repository directories, then run detection.</div>
    </div>
    <div class="dialog-actions"><button id="previewWorkspace">Detect</button><button id="createWorkspace" class="primary-button" disabled>Create project</button></div>
  </dialog>
  <main>
    <aside class="stack">
      <section><div class="panel-head"><h2>Project Workflow</h2></div><div id="workspaceOverview"><p class="muted">Loading...</p></div><div class="actions job-actions">
        <button data-action="scan">Scan Project</button>
        <button data-action="baseline">Capture Baseline</button>
        <button data-action="verify">Verify</button>
        <button data-action="checkpoint">Create Checkpoint</button>
      </div></section>
      <section><div class="panel-head"><h2>Status</h2></div><div id="stats" class="grid"><p class="muted">Loading...</p></div><p id="runMeta" class="run-meta"></p></section>
      <section><div class="panel-head"><h2>Guarded Actions</h2></div><div class="actions">
        <button data-action="readiness">Write Readiness</button>
        <button data-action="issue-control-dry-run">Issue Dry-run</button>
      </div><div class="action-form">
        <label class="field">Repo <input id="issueRepo" placeholder="owner/name"></label>
        <label class="field">Labels <input id="issueLabels" placeholder="label-a,label-b"></label>
        <label class="field">Max iterations <input id="issueMaxIterations" type="number" min="1" max="10" value="3"></label>
      </div><p class="action-note">Snapshot writes an artifact. Issue control stays dry-run.</p><div id="actionHints" class="status-line" hidden></div><div id="actionStatus" class="status-line" hidden></div></section>
      <section><div class="panel-head"><h2>Recent Jobs</h2><div class="toolbar compact">
        <select id="jobStatusFilter" aria-label="Job status filter">
          <option value="all">all jobs</option>
          <option value="active">active</option>
          <option value="failed">failed</option>
          <option value="succeeded">succeeded</option>
          <option value="cancelled">cancelled</option>
        </select>
        <select id="jobRunFilter" aria-label="Job run filter">
          <option value="all">all runs</option>
          <option value="current">current run</option>
        </select>
      </div></div><div class="toolbar compact">
        <label class="field">Keep <input id="jobGcKeep" type="number" min="0" max="500" value="50"></label>
        <button id="jobGcPlan">Plan GC</button>
        <button id="jobGcApply">Apply GC</button>
      </div><div id="jobGcStatus" class="status-line" hidden></div><div id="jobs"><p class="muted">Loading...</p></div></section>
      <section><div class="panel-head"><h2>Unattended Audit</h2></div><pre id="audit">[]</pre></section>
    </aside>
    <div class="stack">
      <section><div class="panel-head"><h2>Next Actions</h2></div><div id="nextActions"><p class="muted">Loading...</p></div></section>
      <section><div class="panel-head"><h2>Run Detail</h2></div><div id="runDetail"><p class="muted">Loading...</p></div></section>
      <section><div class="panel-head"><h2>Job Detail</h2><button id="clearJobDetail">Clear</button></div><div id="jobDetail"><p class="muted">Select a job.</p></div></section>
      <section><div class="panel-head"><h2>Recovery Center</h2></div><div id="recovery"><p class="muted">Loading...</p></div><div id="recoveryPlan" class="status-line" hidden></div></section>
      <section><div class="panel-head"><h2>Blockers</h2></div><div id="blockers"><p class="muted">Loading...</p></div></section>
      <section><div class="panel-head"><h2>Project History</h2></div><div id="runs"><p class="muted">Loading...</p></div></section>
      <section><div class="panel-head"><h2>Ready Tasks</h2></div><div id="tasks"><p class="muted">Loading...</p></div><div id="taskExecutionPlan" class="status-line" hidden></div></section>
      <section><div class="panel-head"><h2>Stuck Proposals</h2></div><div id="proposals"><p class="muted">Loading...</p></div></section>
      <section><div class="panel-head"><h2>Evidence / Diff</h2><div class="toolbar compact">
        <select id="diffStatusFilter" aria-label="Diff status filter">
          <option value="all">all status</option>
          <option value="failed">failed</option>
          <option value="passed">passed</option>
        </select>
        <select id="diffSeverityFilter" aria-label="Diff severity filter">
          <option value="all">all severity</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
          <option value="unknown">unknown</option>
        </select>
      </div></div><div id="diffs"><p class="muted">Loading...</p></div></section>
      <section><div class="panel-head"><h2>Monitor</h2></div><pre id="monitor">{}</pre></section>
    </div>
  </main>
  <script>
    window.MG_CSRF_TOKEN = ${JSON.stringify(csrfToken)};
    let actionCapabilities = null;
    let latestDiffs = [];
    let jobsRefreshTimer = null;
    let jobsLoading = false;

    async function json(path, options) {
      const requestOptions = options || {};
      if ((requestOptions.method || 'GET').toUpperCase() !== 'GET') {
        requestOptions.headers = {
          ...(requestOptions.headers || {}),
          'x-migration-guard-csrf': window.MG_CSRF_TOKEN
        };
      }
      const res = await fetch(path, requestOptions);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      return body;
    }
    function postJson(path, values) {
      return json(path, {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify(values || {})
      });
    }
    function workspaceValues() {
      return {
        name: document.getElementById('workspaceName').value,
        sourceRoot: document.getElementById('workspaceSource').value,
        targetRoot: document.getElementById('workspaceTarget').value,
        goal: document.getElementById('workspaceGoal').value
      };
    }
    function renderWorkspaceOverview(report) {
      const container = document.getElementById('workspaceOverview');
      if (!report.managed || !report.workspace) {
        container.innerHTML = '<p class="muted">Register a source and target project to track a refactoring workflow.</p>';
        return;
      }
      const workspace = report.workspace;
      const rows = [
        ['Project', workspace.name], ['Goal', workspace.goal], ['Source', workspace.sourceRoot],
        ['Target', workspace.targetRoot], ['Stack', (workspace.detected || []).join(', ') || workspace.packageManager],
        ['Checks', (report.checks || []).join(', ') || 'none']
      ];
      const progress = (report.progress || []).map(step => '<li><strong>' + (step.complete ? 'Complete' : 'Pending') + '</strong> ' + escapeHtml(step.label) + (step.complete && step.evidence ? '<div>' + artifactHtml(step.evidence) + '</div>' : '') + '</li>').join('');
      container.innerHTML = '<dl class="kv">' + rows.map(row => '<dt>' + escapeHtml(row[0]) + '</dt><dd>' + escapeHtml(row[1]) + '</dd>').join('') + '</dl><ol class="timeline">' + progress + '</ol>';
    }
    function renderRecovery(report) {
      const checkpoints = report.checkpoints || [];
      if (!checkpoints.length) return '<p class="muted">No recovery checkpoints for this run.</p>';
      return '<div class="item-list">' + checkpoints.map(checkpoint => '<details><summary>' + badge('checkpoint', 'ok') + ' ' + escapeHtml(checkpoint.id) + '</summary><dl class="kv"><dt>Created</dt><dd>' + escapeHtml(checkpoint.createdAt) + '</dd><dt>Branch</dt><dd>' + escapeHtml(checkpoint.gitBranch || 'unknown') + '</dd><dt>HEAD</dt><dd class="mono">' + escapeHtml(checkpoint.gitHead || 'unavailable') + '</dd><dt>Untracked</dt><dd>' + escapeHtml(String((checkpoint.untrackedFiles || []).length)) + '</dd><dt>Note</dt><dd>' + escapeHtml(checkpoint.note || 'none') + '</dd></dl><div class="job-actions"><button data-recovery-plan="' + attr(checkpoint.id) + '">Plan recovery</button></div></details>').join('') + '</div>';
    }
    async function loadRecovery() {
      try { document.getElementById('recovery').innerHTML = renderRecovery(await json(withRun('/api/recovery'))); }
      catch (error) { document.getElementById('recovery').innerHTML = errorHtml(error); }
    }
    async function planRecovery(button) {
      const status = document.getElementById('recoveryPlan');
      status.hidden = false; status.className = 'status-line'; status.textContent = 'Checking current Git and side-effect state...'; button.disabled = true;
      try {
        const plan = await postJson('/api/recovery/plan', { run: selectedRun() || undefined, checkpoint: button.dataset.recoveryPlan });
        status.className = 'status-line ' + (plan.passed ? 'ok' : 'bad');
        status.innerHTML = '<strong>Recovery plan ' + (plan.passed ? 'ready' : 'blocked') + '</strong><dl class="kv"><dt>Strategy</dt><dd>' + escapeHtml(plan.strategy) + '</dd><dt>Checkpoint</dt><dd>' + escapeHtml(plan.checkpointId) + '</dd><dt>Current HEAD</dt><dd class="mono">' + escapeHtml(plan.currentHead || 'unavailable') + '</dd><dt>Plan hash</dt><dd class="mono">' + escapeHtml(plan.planHash) + '</dd></dl>' + (plan.blockers || []).map(item => '<div class="error">' + escapeHtml(item) + '</div>').join('') + (plan.warnings || []).map(item => '<div class="muted">Warning: ' + escapeHtml(item) + '</div>').join('') + (plan.passed ? '<div class="job-actions"><button data-recovery-apply="' + attr(plan.planHash) + '">Apply recovery</button></div>' : '');
      } catch (error) { status.className = 'status-line bad'; status.innerHTML = errorHtml(error); }
      finally { button.disabled = false; }
    }
    async function applyRecovery(button) {
      if (!confirm('Apply this reviewed recovery plan? Target files and Git state may change. Continue?')) return;
      const status = document.getElementById('recoveryPlan');
      button.disabled = true; status.className = 'status-line'; status.textContent = 'Revalidating and applying recovery...';
      try {
        const result = await postJson('/api/recovery/apply', { run: selectedRun() || undefined, planHash: button.dataset.recoveryApply });
        status.className = 'status-line ok'; status.innerHTML = '<strong>Recovery applied</strong><div>' + escapeHtml(result.message) + '</div><div>' + artifactHtml(result.outputPath) + '</div>';
        await load();
      } catch (error) { status.className = 'status-line bad'; status.innerHTML = errorHtml(error); button.disabled = false; }
    }
    async function loadWorkspaceOverview() {
      try { renderWorkspaceOverview(await json('/api/workspaces/active')); }
      catch (error) { document.getElementById('workspaceOverview').innerHTML = errorHtml(error); }
    }
    async function loadWorkspaces() {
      const registry = await json('/api/workspaces');
      const select = document.getElementById('workspaceSelect');
      select.innerHTML = '<option value="">Host project</option>' + (registry.workspaces || []).filter(item => item.status === 'active').map(item => '<option value="' + attr(item.id) + '">' + escapeHtml(item.name) + ' · ' + escapeHtml(item.packageManager) + '</option>').join('');
      select.value = registry.activeWorkspaceId || '';
    }
    async function previewWorkspace() {
      const status = document.getElementById('workspacePreview');
      const create = document.getElementById('createWorkspace');
      status.className = 'status-line'; status.textContent = 'Detecting repositories and target stack...'; create.disabled = true;
      try {
        const preview = await postJson('/api/workspaces/preview', workspaceValues());
        status.className = 'status-line ' + (preview.valid ? 'ok' : 'bad');
        const detection = preview.detection;
        status.innerHTML = (preview.errors || []).map(error => '<div>' + escapeHtml(error) + '</div>').join('') +
          (detection ? '<div class="workspace-summary"><strong>' + escapeHtml((detection.detected || []).join(', ') || 'Unknown stack') + '</strong><div>Package manager: ' + escapeHtml(detection.packageManager) + ' · confidence: ' + escapeHtml(detection.confidence) + '</div><div>Source Git: ' + (preview.source.git ? 'yes' : 'no') + ' · Target Git: ' + (preview.target.git ? 'yes' : 'no') + ' · Existing config: ' + (preview.target.configExists ? 'yes' : 'no') + '</div><div>Checks: ' + escapeHtml((detection.recommendedChecks || []).map(check => check.name).join(', ') || 'none') + '</div></div>' : '');
        create.disabled = !preview.valid;
      } catch (error) { status.className = 'status-line bad'; status.innerHTML = errorHtml(error); }
    }
    async function createWorkspace() {
      const button = document.getElementById('createWorkspace');
      const status = document.getElementById('workspacePreview');
      button.disabled = true; status.className = 'status-line'; status.textContent = 'Creating config and initial migration run...';
      try {
        await postJson('/api/workspaces', workspaceValues());
        window.location.reload();
      } catch (error) { status.className = 'status-line bad'; status.innerHTML = errorHtml(error); button.disabled = false; }
    }
    function selectedRun() {
      return document.getElementById('runSelect').value;
    }
    function withRun(path) {
      const run = selectedRun();
      return run ? path + '?run=' + encodeURIComponent(run) : path;
    }
    function appendQuery(path, values) {
      const params = new URLSearchParams();
      Object.entries(values).forEach(([key, value]) => {
        if (value !== undefined && value !== null && String(value).trim() !== '') params.set(key, String(value).trim());
      });
      const query = params.toString();
      return query ? path + '?' + query : path;
    }
    function runScopedParams() {
      return {
        run: selectedRun() || undefined
      };
    }
    function issueControlParams() {
      return {
        repo: document.getElementById('issueRepo').value,
        labels: document.getElementById('issueLabels').value,
        maxIterations: document.getElementById('issueMaxIterations').value
      };
    }
    function jobListParams() {
      return {
        status: document.getElementById('jobStatusFilter')?.value || 'all',
        run: document.getElementById('jobRunFilter')?.value === 'current' ? selectedRun() || undefined : undefined,
        limit: 20
      };
    }
    function table(rows, columns) {
      if (!rows.length) return '<p class="muted">none</p>';
      return '<div class="table-wrap"><table><thead><tr>' + columns.map(c => '<th>' + c.label + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(row => '<tr>' + columns.map(c => '<td>' + escapeHtml(String(c.value(row) ?? '')) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }
    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    function attr(value) {
      return escapeHtml(String(value ?? ''));
    }
    function empty() {
      return '<p class="empty">none</p>';
    }
    function errorHtml(error) {
      return '<div class="error">' + escapeHtml(error.message || String(error)) + '</div>';
    }
    function artifactHtml(value) {
      const text = String(value || '');
      const escaped = escapeHtml(text);
      if (!looksLikeArtifactPath(text)) return escaped;
      return '<a class="artifact mono" target="_blank" rel="noreferrer" href="/api/artifact?path=' + encodeURIComponent(text) + '">' + escaped + '</a>';
    }
    function looksLikeArtifactPath(value) {
      return /\\.migration-guard/.test(value) || /\\.(json|jsonl|md|txt|log)$/i.test(value);
    }
    function badge(value, tone) {
      return '<span class="badge ' + (tone || '') + '">' + escapeHtml(String(value)) + '</span>';
    }
    function toneFor(value) {
      if (value === true || value === 'go' || value === 'passed' || value === 'clean' || value === 'succeeded' || value === 'complete') return 'ok';
      if (value === false || value === 'hold' || value === 'blocked' || value === 'failed') return 'bad';
      if (value === 'warning' || value === 'warn' || value === 'queued' || value === 'running' || value === 'started') return 'warn';
      return '';
    }
    function renderRuns(report) {
      const select = document.getElementById('runSelect');
      const previous = select.value;
      const selected = previous && report.runs.some(row => row.runId === previous)
        ? previous
        : report.latestRunId || report.runs[0]?.runId || '';
      select.innerHTML = report.runs.length
        ? report.runs.map(row => '<option value="' + escapeHtml(row.runId) + '">' + escapeHtml(row.runId + ' · ' + row.status) + '</option>').join('')
        : '<option value="">no runs</option>';
      select.disabled = report.runs.length === 0;
      select.value = selected;
      document.getElementById('runs').innerHTML = table(report.runs, [
        {label:'Run', value:r=>r.runId},
        {label:'Goal', value:r=>r.goal},
        {label:'Status', value:r=>r.status},
        {label:'Readiness', value:r=>r.readinessStatus || 'unknown'},
        {label:'Blocked', value:r=>r.blockedCount},
        {label:'Updated', value:r=>r.updatedAt}
      ]);
    }
    function renderDashboard(dashboard) {
      document.getElementById('stats').innerHTML = [
        ['Readiness', dashboard.readiness?.status || 'unknown', toneFor(dashboard.readiness?.status)],
        ['Blockers', dashboard.summary.blockerCount, dashboard.summary.blockerCount > 0 ? 'bad' : 'ok'],
        ['Warnings', dashboard.summary.warningCount, dashboard.summary.warningCount > 0 ? 'warn' : 'ok'],
        ['Ready tasks', dashboard.summary.readyTaskCount, ''],
        ['Stuck proposals', dashboard.summary.stuckProposalCount, dashboard.summary.stuckProposalCount > 0 ? 'bad' : 'ok'],
        ['Runs', dashboard.runs.runCount, '']
      ].map(([k,v,tone]) => '<div class="stat ' + tone + '"><span>' + k + '</span><strong>' + escapeHtml(String(v)) + '</strong></div>').join('');
      document.getElementById('runMeta').textContent = dashboard.run.goal + ' · ' + dashboard.run.status + ' · updated ' + dashboard.run.updatedAt;
      document.getElementById('runDetail').innerHTML = renderRunDetail(dashboard);
      document.getElementById('tasks').innerHTML = renderTasks(dashboard.readyTasks);
      document.getElementById('proposals').innerHTML = renderProposals(dashboard.stuckProposals);
      document.getElementById('nextActions').innerHTML = renderNextActions(dashboard.recommendedNextActions || []);
      document.getElementById('monitor').textContent = JSON.stringify({
        runId: dashboard.runId,
        progress: dashboard.progress,
        git: dashboard.git,
        generatedAt: dashboard.createdAt
      }, null, 2);
    }
    function renderRunDetail(dashboard) {
      const git = dashboard.git
        ? dashboard.git.checked === false ? 'not checked' : dashboard.git.clean ? 'clean' : 'dirty'
        : 'unknown';
      const rows = [
        ['Run', dashboard.runId],
        ['Goal', dashboard.run.goal],
        ['Status', dashboard.run.status],
        ['Mode', dashboard.run.mode],
        ['Target', dashboard.run.targetRoot],
        ['Checkpoint', dashboard.run.latestCheckpointId || 'none'],
        ['Updated', dashboard.run.updatedAt],
        ['Git', git]
      ];
      return '<dl class="kv">' + rows.map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(String(value)) + '</dd>').join('') + '</dl>';
    }
    function renderTasks(tasks) {
      if (!tasks.length) return empty();
      return '<div class="item-list">' + tasks.map(task => '<details><summary>' + escapeHtml(task.taskId + ' · ' + task.title) + '</summary>' +
        '<dl class="kv"><dt>Risk</dt><dd>' + escapeHtml(task.risk) + '</dd><dt>Owner</dt><dd>' + escapeHtml(task.owner) + '</dd><dt>Issue</dt><dd>' + escapeHtml(task.issueId || 'none') + '</dd><dt>Description</dt><dd>' + escapeHtml(task.description || '') + '</dd><dt>Affected paths</dt><dd>' + escapeHtml((task.affectedFiles || []).join(', ') || 'none') + '</dd><dt>Verification</dt><dd>' + escapeHtml((task.verificationCommands || []).join(', ') || 'none') + '</dd><dt>Acceptance</dt><dd>' + escapeHtml((task.acceptanceCriteria || []).join(', ') || 'none') + '</dd></dl><div class="job-actions"><button data-task-plan="' + attr(task.taskId) + '">Review plan</button></div></details>').join('') + '</div>';
    }
    async function planTaskExecution(button) {
      const status = document.getElementById('taskExecutionPlan');
      status.hidden = false; status.className = 'status-line'; status.textContent = 'Checking task, path budget, baseline and repository state...'; button.disabled = true;
      try {
        const plan = await postJson('/api/tasks/plan', { run: selectedRun() || undefined, task: button.dataset.taskPlan });
        status.className = 'status-line ' + (plan.passed ? 'ok' : 'bad');
        status.innerHTML = '<strong>Task plan ' + (plan.passed ? 'ready' : 'blocked') + '</strong><dl class="kv"><dt>Task</dt><dd>' + escapeHtml(plan.task.id + ' · ' + plan.task.title) + '</dd><dt>Risk</dt><dd>' + escapeHtml(plan.task.risk) + '</dd><dt>Owner</dt><dd>' + escapeHtml(plan.task.owner) + '</dd><dt>Paths</dt><dd>' + escapeHtml((plan.affectedPaths || []).join(', ') || 'none') + '</dd><dt>Git HEAD</dt><dd class="mono">' + escapeHtml(plan.gitHead || 'unavailable') + '</dd><dt>Baseline</dt><dd>' + (plan.baselineAvailable ? artifactHtml(plan.baselinePath) : 'missing') + '</dd><dt>Plan hash</dt><dd class="mono">' + escapeHtml(plan.planHash) + '</dd></dl>' + (plan.blockers || []).map(item => '<div class="error">' + escapeHtml(item) + '</div>').join('') + (plan.warnings || []).map(item => '<div class="muted">Warning: ' + escapeHtml(item) + '</div>').join('') + (plan.passed ? '<div class="job-actions"><button data-task-execute="' + attr(plan.task.id) + '" data-plan-hash="' + attr(plan.planHash) + '">Execute task</button></div>' : '');
      } catch (error) { status.className = 'status-line bad'; status.innerHTML = errorHtml(error); }
      finally { button.disabled = false; }
    }
    async function executeTaskPlan(button) {
      if (!confirm('Execute this reviewed task plan? A checkpoint will be created before the task and verification will run afterward. Continue?')) return;
      const status = document.getElementById('taskExecutionPlan');
      button.disabled = true; status.className = 'status-line'; status.textContent = 'Queueing guarded task execution...';
      try {
        const created = await postJson('/api/jobs/actions/task-execute', { run: selectedRun() || undefined, task: button.dataset.taskExecute, planHash: button.dataset.planHash });
        const finished = await pollJob(created.jobId);
        status.className = 'status-line ' + (finished.result?.status === 'accepted' ? 'ok' : 'bad');
        status.innerHTML = renderJobStatus(finished);
        await load();
      } catch (error) { status.className = 'status-line bad'; status.innerHTML = errorHtml(error); button.disabled = false; }
    }
    function renderProposals(proposals) {
      if (!proposals.length) return empty();
      return '<div class="item-list">' + proposals.map(proposal => '<details><summary>' + escapeHtml(proposal.proposalId + ' · ' + proposal.title) + '</summary>' +
        '<dl class="kv"><dt>State</dt><dd>' + escapeHtml(proposal.state) + '</dd><dt>Risk</dt><dd>' + escapeHtml(proposal.risk) + '</dd><dt>Task</dt><dd>' + escapeHtml(proposal.taskId || 'none') + '</dd><dt>Action</dt><dd>' + escapeHtml(proposal.actionId || 'none') + '</dd><dt>Verification</dt><dd>' + artifactHtml(proposal.lastVerificationPath || 'none') + '</dd><dt>Rollback</dt><dd>' + artifactHtml(proposal.lastRollbackPath || 'none') + '</dd></dl></details>').join('') + '</div>';
    }
    function renderNextActions(actions) {
      if (!actions.length) return empty();
      return actions.map(action => '<div class="command"><code>' + escapeHtml(action) + '</code><button class="copy" data-copy="' + escapeHtml(action) + '">Copy</button></div>').join('');
    }
    function renderBlockers(report) {
      if (!report.blockers.length) return empty();
      return '<div class="blocker-list">' + report.blockers.map(blocker => {
        const evidence = blocker.evidence?.length
          ? '<ul class="evidence">' + blocker.evidence.map(item => '<li>' + artifactHtml(item) + '</li>').join('') + '</ul>'
          : '';
        const next = blocker.nextAction
          ? '<div class="command"><code>' + escapeHtml(blocker.nextAction) + '</code><button class="copy" data-copy="' + escapeHtml(blocker.nextAction) + '">Copy</button></div>'
          : '';
        return '<article class="blocker"><div class="blocker-title">' +
          badge(blocker.severity, toneFor(blocker.severity)) + badge(blocker.scope, '') +
          '<strong>' + escapeHtml(blocker.title) + '</strong></div>' +
          '<div>' + escapeHtml(blocker.reason) + '</div>' + evidence + next + '</article>';
      }).join('') + '</div>';
    }
    function renderDiffs(diffs) {
      const statusFilter = document.getElementById('diffStatusFilter')?.value || 'all';
      const severityFilter = document.getElementById('diffSeverityFilter')?.value || 'all';
      const filtered = diffs.filter(diff => {
        if (statusFilter === 'passed' && diff.passed !== true) return false;
        if (statusFilter === 'failed' && diff.passed !== false) return false;
        if (severityFilter === 'all') return true;
        return (diff.differences || []).some(item => (item.severity || 'unknown') === severityFilter);
      });
      if (!filtered.length) return empty();
      return filtered.map(diff => {
        const visibleDifferences = severityFilter === 'all'
          ? diff.differences
          : (diff.differences || []).filter(item => (item.severity || 'unknown') === severityFilter);
        const diffRows = visibleDifferences?.length
          ? visibleDifferences.map(difference => renderDiffDecision(diff.path, difference)).join('')
          : empty();
        return '<details><summary>' + artifactHtml(diff.path) + '</summary>' +
          '<div class="diff-meta">' +
            badge(diff.passed, toneFor(diff.passed)) +
            badge((diff.differenceCount || 0) + ' diff(s)', diff.differenceCount ? 'warn' : 'ok') +
            (diff.coverage ? badge(diff.coverage.decided + '/' + diff.coverage.total + ' decided', diff.coverage.pendingRisk ? 'warn' : 'ok') : '') +
            (diff.policy ? badge('policy ' + diff.policy.status, toneFor(diff.policy.status)) : '') +
          '</div>' +
          renderDiffBatchDecision(diff) +
          diffRows + '</details>';
      }).join('');
    }
    function renderDiffBatchDecision(diff) {
      if (!diff.differenceCount) return '';
      return '<article class="diff-decision">' +
        '<div class="blocker-title">' + badge('batch', '') + '<strong>Batch decision</strong></div>' +
        '<div class="decision-form" data-batch-compare="' + attr(diff.path) + '">' +
          '<label>Severity <select data-field="severity">' +
            '<option value="all">all</option>' +
            '<option value="error">error</option>' +
            '<option value="warn">warn</option>' +
            '<option value="info">info</option>' +
          '</select></label>' +
          '<label>Decision <select data-field="classification">' +
            '<option value="intentional">intentional</option>' +
            '<option value="accidental">accidental</option>' +
            '<option value="unknown">unknown</option>' +
          '</select></label>' +
          '<label>Reason <input data-field="reason" placeholder="why these differences share one classification"></label>' +
          '<label>Approved by <input data-field="approvedBy" placeholder="optional"></label>' +
          '<button data-diff-batch-decision>Record batch</button>' +
        '</div>' +
      '</article>';
    }
    function renderDiffDecision(comparePath, difference) {
      const current = difference.decision;
      const currentSummary = current
        ? '<div class="muted">Current decision: ' + badge(current.classification, toneFor(current.classification)) + ' ' + escapeHtml(current.reason || '') + '</div>'
        : '<div class="muted">Current decision: pending</div>';
      return '<article class="diff-decision">' +
        '<div class="blocker-title">' + badge(difference.severity || 'unknown', toneFor(difference.severity)) + badge(difference.area, '') + '<strong>' + escapeHtml(difference.name) + '</strong></div>' +
        '<div>' + escapeHtml(difference.message || '') + '</div>' +
        currentSummary +
        '<div class="decision-form" data-compare="' + attr(comparePath) + '" data-area="' + attr(difference.area) + '" data-name="' + attr(difference.name) + '" data-severity="' + attr(difference.severity || '') + '" data-message="' + attr(difference.message || '') + '">' +
          '<label>Decision <select data-field="classification">' +
            '<option value="intentional"' + (current?.classification === 'intentional' ? ' selected' : '') + '>intentional</option>' +
            '<option value="accidental"' + (current?.classification === 'accidental' ? ' selected' : '') + '>accidental</option>' +
            '<option value="unknown"' + (current?.classification === 'unknown' ? ' selected' : '') + '>unknown</option>' +
          '</select></label>' +
          '<label>Reason <input data-field="reason" value="' + attr(current?.reason || '') + '" placeholder="why this classification is correct"></label>' +
          '<label>Approved by <input data-field="approvedBy" value="' + attr(current?.approvedBy || '') + '" placeholder="optional"></label>' +
          '<button data-diff-decision>Record</button>' +
        '</div>' +
      '</article>';
    }
    function renderActionResult(name, result) {
      const paths = [result.outputPath, result.markdownPath, result.snapshotPath].filter(Boolean);
      const summary = [
        result.status ? 'status: ' + result.status : undefined,
        result.mode ? 'mode: ' + result.mode : undefined,
        result.summary?.blockerCount !== undefined ? 'blockers: ' + result.summary.blockerCount : undefined,
        result.summary?.warningCount !== undefined ? 'warnings: ' + result.summary.warningCount : undefined
      ].filter(Boolean).join(' · ');
      return '<strong>' + escapeHtml(name) + ' complete</strong>' +
        (summary ? '<div class="muted">' + escapeHtml(summary) + '</div>' : '') +
        (paths.length ? '<ul class="evidence">' + paths.map(item => '<li>' + artifactHtml(item) + '</li>').join('') + '</ul>' : '');
    }
    function actionLabel(actionId) {
      return actionCapabilities?.actions?.find(action => action.id === actionId)?.label || actionId;
    }
    function renderJobs(report) {
      const jobs = report.jobs || [];
      const summary = '<p class="muted">showing ' + jobs.length + ' of ' + (report.totalCount || 0) + ' · active ' + (report.activeCount || 0) + (report.activeCount ? ' · auto-refreshing' : '') + '</p>';
      if (!jobs.length) return summary + empty();
      return summary + '<div class="item-list">' + jobs.map(job => renderJobCard(job)).join('') + '</div>';
    }
    function renderJobCard(job) {
      const paths = job.artifactPaths || [];
      const details = [
        ['Job', job.id],
        ['Retry of', job.retryOf || 'none'],
        ['Action', actionLabel(job.action)],
        ['Status', job.status],
        ['Attempt', job.attempt || 1],
        ['Owner', job.ownerId || 'none'],
        ['Last heartbeat', job.heartbeatAt || 'none'],
        ['Lease age', job.heartbeatAt ? Math.max(0, Date.now() - Date.parse(job.heartbeatAt)) + ' ms' : 'none'],
        ['Recovery reason', job.recoveryReason || 'none'],
        ['Run', job.runId || 'none'],
        ['Started', job.startedAt || 'not started'],
        ['Finished', job.finishedAt || 'not finished']
      ];
      return '<details' + (job.status === 'running' || job.status === 'queued' ? ' open' : '') + '><summary>' +
        badge(job.status, toneFor(job.status)) + ' ' + escapeHtml(actionLabel(job.action)) + '</summary>' +
        '<dl class="kv">' + details.map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(String(value)) + '</dd>').join('') + '</dl>' +
        (job.error ? '<div class="error">' + escapeHtml(job.error) + '</div>' : '') +
        renderJobEvents(job) +
        renderJobActions(job) +
        renderArtifactList(paths.map(path => ({ path, kind: artifactKind(path), label: path.split(/[\\\\/]/).pop() || path }))) +
      '</details>';
    }
    function renderJobStatus(job) {
      const paths = job.artifactPaths || [];
      return '<strong>' + escapeHtml(actionLabel(job.action)) + ' ' + escapeHtml(job.status) + '</strong>' +
        '<div class="muted">job: ' + escapeHtml(job.id) + (job.runId ? ' · run: ' + escapeHtml(job.runId) : '') + '</div>' +
        (job.error ? '<div>' + escapeHtml(job.error) + '</div>' : '') +
        (job.status === 'succeeded' && job.result ? renderActionResult(actionLabel(job.action), job.result) : '') +
        renderJobEvents(job) +
        renderArtifactList(paths.map(path => ({ path, kind: artifactKind(path), label: path.split(/[\\\\/]/).pop() || path })));
    }
    function renderJobActions(job) {
      const actions = ['<button data-job-detail="' + attr(job.id) + '">Details</button>'];
      if (job.status === 'queued') actions.push('<button data-job-cancel="' + attr(job.id) + '">Cancel</button>');
      if (job.status === 'failed') actions.push('<button data-job-retry="' + attr(job.id) + '" data-job-action="' + attr(job.action) + '">Retry</button>');
      return '<div class="toolbar compact job-actions">' + actions.join('') + '</div>';
    }
    function renderJobEvents(job) {
      const events = job.events || [];
      if (!events.length) return '';
      return '<ol class="timeline" aria-label="Job timeline">' + events.map(event => {
        const artifacts = event.artifactPaths?.length
          ? '<ul class="evidence">' + event.artifactPaths.map(item => '<li>' + artifactHtml(item) + '</li>').join('') + '</ul>'
          : '';
        return '<li>' + badge(event.type, toneFor(event.type)) + ' <strong>' + escapeHtml(event.at || '') + '</strong><div>' + escapeHtml(event.message || '') + '</div>' + artifacts + '</li>';
      }).join('') + '</ol>';
    }
    function artifactKind(path) {
      if (/\\.json$/i.test(path)) return 'json';
      if (/\\.md$/i.test(path)) return 'markdown';
      if (/\\.(jsonl|log)$/i.test(path)) return 'log';
      if (/\\.txt$/i.test(path)) return 'text';
      return 'other';
    }
    function renderArtifactList(artifacts) {
      if (!artifacts?.length) return '';
      return '<ul class="evidence">' + artifacts.map(item => '<li>' + badge(item.kind || artifactKind(item.path), '') + ' ' + artifactHtml(item.path) + '</li>').join('') + '</ul>';
    }
    function renderJobDetail(report) {
      const job = report.job;
      const chain = report.retryChain || [];
      const children = report.retryChildren || [];
      const rows = [
        ['Job', job.id],
        ['Action', actionLabel(job.action)],
        ['Status', job.status],
        ['Attempt', job.attempt || 1],
        ['Owner', job.ownerId || 'none'],
        ['Last heartbeat', job.heartbeatAt || 'none'],
        ['Lease duration', job.leaseDurationMs ? job.leaseDurationMs + ' ms' : 'none'],
        ['Recovery reason', job.recoveryReason || 'none'],
        ['Run', job.runId || 'none'],
        ['Retry root', report.retryRootId || job.id],
        ['Retry of', job.retryOf || 'none'],
        ['Created', job.createdAt],
        ['Updated', job.updatedAt],
        ['Started', job.startedAt || 'not started'],
        ['Finished', job.finishedAt || 'not finished']
      ];
      return '<div class="diff-meta">' + badge(job.status, toneFor(job.status)) + badge(actionLabel(job.action), '') + '</div>' +
        '<dl class="kv">' + rows.map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(String(value)) + '</dd>').join('') + '</dl>' +
        (job.error ? '<div class="error">' + escapeHtml(job.error) + '</div>' : '') +
        '<h3>Retry Chain</h3>' + (chain.length ? '<div class="command"><code>' + escapeHtml(chain.map(item => item.id + ':' + item.status).join(' -> ')) + '</code></div>' : empty()) +
        '<h3>Retry Children</h3>' + (children.length ? table(children, [
          {label:'Job', value:j=>j.id},
          {label:'Status', value:j=>j.status},
          {label:'Updated', value:j=>j.updatedAt}
        ]) : empty()) +
        '<h3>Artifacts</h3>' + (report.artifacts?.length ? renderArtifactList(report.artifacts) : empty()) +
        '<h3>Timeline</h3>' + renderJobEvents(job) +
        '<h3>Params</h3><pre>' + escapeHtml(JSON.stringify(job.params || {}, null, 2)) + '</pre>' +
        '<h3>Result</h3><pre>' + escapeHtml(JSON.stringify(job.result || {}, null, 2)) + '</pre>';
    }
    function renderActionCapabilities(report) {
      actionCapabilities = report;
      const hints = [];
      report.actions.forEach(action => {
        const button = document.querySelector('button[data-action="' + action.id + '"]');
        if (!button) return;
        button.textContent = action.label;
        button.disabled = !action.enabled;
        button.title = action.reason || '';
        if (action.confirmMessage) button.dataset.confirm = action.confirmMessage;
        if (!action.enabled) {
          hints.push(action.label + ': ' + (action.reason || 'unavailable'));
        }
        if (action.id === 'issue-control-dry-run') {
          const repoInput = document.getElementById('issueRepo');
          const maxInput = document.getElementById('issueMaxIterations');
          if (!repoInput.value && action.defaults?.repo) repoInput.value = action.defaults.repo;
          if (!maxInput.value && action.defaults?.maxIterations) maxInput.value = action.defaults.maxIterations;
        }
      });
      const hintBox = document.getElementById('actionHints');
      hintBox.hidden = hints.length === 0;
      hintBox.className = hints.length === 0 ? 'status-line' : 'status-line bad';
      hintBox.innerHTML = hints.map(item => '<div>' + escapeHtml(item) + '</div>').join('');
    }
    async function loadActionCapabilities() {
      const params = {
        ...runScopedParams(),
        ...issueControlParams()
      };
      try {
        const report = await json(appendQuery('/api/actions/capabilities', params));
        renderActionCapabilities(report);
      } catch (error) {
        const hintBox = document.getElementById('actionHints');
        hintBox.hidden = false;
        hintBox.className = 'status-line bad';
        hintBox.innerHTML = errorHtml(error);
      }
    }
    async function loadRuns() {
      const runs = await json('/api/runs');
      renderRuns(runs);
      return runs;
    }
    async function loadJobs() {
      if (jobsLoading) return;
      jobsLoading = true;
      return await json(appendQuery('/api/jobs', jobListParams()))
        .then(report => {
          document.getElementById('jobs').innerHTML = renderJobs(report);
          scheduleJobsRefresh(report);
          return report;
        })
        .catch(error => {
          document.getElementById('jobs').innerHTML = errorHtml(error);
          clearJobsRefresh();
        })
        .finally(() => {
          jobsLoading = false;
        });
    }
    function clearJobsRefresh() {
      if (jobsRefreshTimer) {
        clearTimeout(jobsRefreshTimer);
        jobsRefreshTimer = null;
      }
    }
    function scheduleJobsRefresh(report) {
      clearJobsRefresh();
      const hasVisibleActiveJob = (report.jobs || []).some(job => job.status === 'queued' || job.status === 'running');
      if (report.activeCount > 0 || hasVisibleActiveJob) {
        jobsRefreshTimer = setTimeout(() => { loadJobs(); }, 1500);
      }
    }
    async function loadRunScoped() {
      const dashboardPromise = json(withRun('/api/dashboard'))
        .then(renderDashboard)
        .catch(error => {
          document.getElementById('stats').innerHTML = errorHtml(error);
          document.getElementById('nextActions').innerHTML = errorHtml(error);
          document.getElementById('tasks').innerHTML = errorHtml(error);
          document.getElementById('proposals').innerHTML = errorHtml(error);
          document.getElementById('monitor').textContent = error.message || String(error);
        });
      const blockersPromise = json(withRun('/api/blockers'))
        .then(report => { document.getElementById('blockers').innerHTML = renderBlockers(report); })
        .catch(error => { document.getElementById('blockers').innerHTML = errorHtml(error); });
      const diffsPromise = json(withRun('/api/diffs'))
        .then(diffs => {
          latestDiffs = diffs;
          document.getElementById('diffs').innerHTML = renderDiffs(latestDiffs);
        })
        .catch(error => { document.getElementById('diffs').innerHTML = errorHtml(error); });
      await Promise.all([dashboardPromise, blockersPromise, diffsPromise, loadActionCapabilities()]);
    }
    async function load() {
      await loadRuns().catch(error => { document.getElementById('runs').innerHTML = errorHtml(error); });
      await Promise.all([
        loadWorkspaceOverview(),
        loadRecovery(),
        loadRunScoped(),
        loadJobs(),
        json('/api/audit')
          .then(audit => { document.getElementById('audit').textContent = JSON.stringify(audit.slice(-8), null, 2); })
          .catch(error => { document.getElementById('audit').textContent = error.message || String(error); })
      ]);
    }
    function actionJobPath(name) {
      return '/api/jobs/actions/' + encodeURIComponent(name);
    }
    function actionJobParams(name) {
      if (name === 'readiness' || name === 'checkpoint') return runScopedParams();
      if (name !== 'issue-control-dry-run') return {};
      return issueControlParams();
    }
    function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    async function pollJob(jobId) {
      const status = document.getElementById('actionStatus');
      for (;;) {
        const job = await json('/api/jobs/' + encodeURIComponent(jobId));
        status.hidden = false;
        status.className = 'status-line ' + toneFor(job.status);
        status.innerHTML = renderJobStatus(job);
        await loadJobs();
        if (job.status === 'succeeded' || job.status === 'failed') {
          return job;
        }
        await wait(900);
      }
    }
    async function startActionJob(name, button) {
      const capability = actionCapabilities?.actions?.find(action => action.id === name);
      if (capability && !capability.enabled) {
        const status = document.getElementById('actionStatus');
        status.hidden = false;
        status.className = 'status-line bad';
        status.innerHTML = '<strong>' + escapeHtml(capability.label) + ' unavailable</strong><div>' + escapeHtml(capability.reason || 'Action is disabled.') + '</div>';
        return;
      }
      if (button.dataset.confirm && !confirm(button.dataset.confirm)) return;
      const status = document.getElementById('actionStatus');
      status.hidden = false;
      status.className = 'status-line';
      status.textContent = 'Queueing ' + button.textContent + '...';
      document.querySelectorAll('button[data-action]').forEach(btn => { btn.disabled = true; });
      try {
        const created = await postJson(actionJobPath(name), actionJobParams(name));
        status.className = 'status-line warn';
        status.innerHTML = renderJobStatus(created.job);
        await loadJobs();
        const finished = await pollJob(created.jobId);
        if (finished.status === 'succeeded') {
          await load();
        }
      } catch (error) {
        status.className = 'status-line bad';
        status.innerHTML = '<strong>' + escapeHtml(button.textContent) + ' failed</strong><div>' + escapeHtml(error.message || String(error)) + '</div>';
      } finally {
        if (actionCapabilities) renderActionCapabilities(actionCapabilities);
      }
    }
    async function retryJob(button) {
      const jobId = button.dataset.jobRetry;
      if (!jobId) return;
      if (button.dataset.jobAction === 'verify' && !confirm('Retry the verification snapshot job? This writes a new run artifact. Continue?')) return;
      const status = document.getElementById('actionStatus');
      status.hidden = false;
      status.className = 'status-line';
      status.textContent = 'Queueing retry...';
      button.disabled = true;
      try {
        const created = await postJson('/api/jobs/' + encodeURIComponent(jobId) + '/retry');
        status.className = 'status-line warn';
        status.innerHTML = renderJobStatus(created.job);
        await loadJobs();
        const finished = await pollJob(created.jobId);
        if (finished.status === 'succeeded') {
          await load();
        }
      } catch (error) {
        status.className = 'status-line bad';
        status.innerHTML = '<strong>Retry failed</strong><div>' + escapeHtml(error.message || String(error)) + '</div>';
      } finally {
        button.disabled = false;
      }
    }
    async function loadJobDetail(jobId) {
      const detail = document.getElementById('jobDetail');
      detail.innerHTML = '<p class="muted">Loading job detail...</p>';
      try {
        const report = await json('/api/jobs/' + encodeURIComponent(jobId) + '/detail');
        detail.innerHTML = renderJobDetail(report);
      } catch (error) {
        detail.innerHTML = errorHtml(error);
      }
    }
    async function cancelJob(button) {
      const jobId = button.dataset.jobCancel;
      if (!jobId) return;
      const status = document.getElementById('actionStatus');
      status.hidden = false;
      status.className = 'status-line';
      status.textContent = 'Cancelling job...';
      button.disabled = true;
      try {
        const job = await postJson('/api/jobs/' + encodeURIComponent(jobId) + '/cancel');
        status.className = 'status-line';
        status.innerHTML = renderJobStatus(job);
        await loadJobs();
        await loadJobDetail(job.id);
      } catch (error) {
        status.className = 'status-line bad';
        status.innerHTML = '<strong>Cancel failed</strong><div>' + escapeHtml(error.message || String(error)) + '</div>';
      } finally {
        button.disabled = false;
      }
    }
    async function gcJobs(apply) {
      const status = document.getElementById('jobGcStatus');
      status.hidden = false;
      status.className = 'status-line';
      status.textContent = apply ? 'Applying job GC...' : 'Planning job GC...';
      try {
        const report = await postJson('/api/jobs/gc', {
          keepLatest: document.getElementById('jobGcKeep').value,
          status: 'terminal',
          apply
        });
        status.className = 'status-line ' + (apply ? 'ok' : '');
        status.innerHTML = '<strong>Job GC ' + (apply ? 'applied' : 'planned') + '</strong><div class="muted">candidates: ' + report.candidateCount + ' · deleted: ' + report.deletedCount + '</div>' +
          (report.candidates?.length ? '<ul class="evidence">' + report.candidates.slice(0, 8).map(item => '<li>' + escapeHtml(item.id + ' · ' + item.status) + '</li>').join('') + '</ul>' : '');
        await loadJobs();
      } catch (error) {
        status.className = 'status-line bad';
        status.innerHTML = '<strong>Job GC failed</strong><div>' + escapeHtml(error.message || String(error)) + '</div>';
      }
    }
    async function recordDiffDecisionFromForm(button) {
      const form = button.closest('.decision-form');
      if (!form) return;
      const reason = form.querySelector('[data-field="reason"]').value.trim();
      const status = document.getElementById('actionStatus');
      status.hidden = false;
      if (!reason) {
        status.className = 'status-line bad';
        status.innerHTML = '<strong>Diff decision failed</strong><div>Reason is required.</div>';
        return;
      }
      button.disabled = true;
      status.className = 'status-line';
      status.textContent = 'Recording diff decision...';
      try {
        const result = await postJson('/api/actions/diff-decision', {
          run: selectedRun() || undefined,
          compare: form.dataset.compare,
          area: form.dataset.area,
          name: form.dataset.name,
          severity: form.dataset.severity,
          message: form.dataset.message,
          as: form.querySelector('[data-field="classification"]').value,
          reason,
          approvedBy: form.querySelector('[data-field="approvedBy"]').value
        });
        status.className = 'status-line ok';
        status.innerHTML = '<strong>Diff decision recorded</strong><div class="muted">Policy: ' + escapeHtml(result.policy.status) + ' · ' + escapeHtml(result.policy.reason) + '</div><ul class="evidence"><li>' + artifactHtml(result.ledgerPath) + '</li></ul>';
        await loadRunScoped();
      } catch (error) {
        status.className = 'status-line bad';
        status.innerHTML = '<strong>Diff decision failed</strong><div>' + escapeHtml(error.message || String(error)) + '</div>';
      } finally {
        button.disabled = false;
      }
    }
    async function recordDiffBatchDecisionFromForm(button) {
      const form = button.closest('.decision-form');
      if (!form) return;
      const reason = form.querySelector('[data-field="reason"]').value.trim();
      const status = document.getElementById('actionStatus');
      status.hidden = false;
      if (!reason) {
        status.className = 'status-line bad';
        status.innerHTML = '<strong>Batch decision failed</strong><div>Reason is required.</div>';
        return;
      }
      button.disabled = true;
      status.className = 'status-line';
      status.textContent = 'Recording batch diff decision...';
      try {
        const result = await postJson('/api/actions/diff-decision-batch', {
          run: selectedRun() || undefined,
          compare: form.dataset.batchCompare,
          severity: form.querySelector('[data-field="severity"]').value,
          as: form.querySelector('[data-field="classification"]').value,
          reason,
          approvedBy: form.querySelector('[data-field="approvedBy"]').value
        });
        status.className = 'status-line ok';
        status.innerHTML = '<strong>Batch decision recorded</strong><div class="muted">decisions: ' + result.decisions.length + ' · policy: ' + escapeHtml(result.policy.status) + '</div><ul class="evidence"><li>' + artifactHtml(result.ledgerPath) + '</li></ul>';
        await loadRunScoped();
      } catch (error) {
        status.className = 'status-line bad';
        status.innerHTML = '<strong>Batch decision failed</strong><div>' + escapeHtml(error.message || String(error)) + '</div>';
      } finally {
        button.disabled = false;
      }
    }
    function copyText(value) {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(value).catch(() => {});
        return;
      }
      const textarea = document.createElement('textarea');
      textarea.value = value;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    document.getElementById('refresh').addEventListener('click', load);
    document.getElementById('newWorkspace').addEventListener('click', () => document.getElementById('workspaceDialog').showModal());
    document.getElementById('closeWorkspace').addEventListener('click', () => document.getElementById('workspaceDialog').close());
    document.getElementById('previewWorkspace').addEventListener('click', previewWorkspace);
    document.getElementById('createWorkspace').addEventListener('click', createWorkspace);
    document.getElementById('workspaceSelect').addEventListener('change', async event => {
      if (!event.target.value) return;
      await postJson('/api/workspaces/' + encodeURIComponent(event.target.value) + '/select');
      window.location.reload();
    });
    document.getElementById('clearJobDetail').addEventListener('click', () => {
      document.getElementById('jobDetail').innerHTML = '<p class="muted">Select a job.</p>';
    });
    document.getElementById('jobGcPlan').addEventListener('click', () => gcJobs(false));
    document.getElementById('jobGcApply').addEventListener('click', () => {
      if (confirm('Delete the planned terminal UI job ledgers? Continue?')) gcJobs(true);
    });
    document.getElementById('runSelect').addEventListener('change', () => {
      loadRunScoped();
      loadJobs();
      loadRecovery();
    });
    ['diffStatusFilter', 'diffSeverityFilter'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => {
        document.getElementById('diffs').innerHTML = renderDiffs(latestDiffs);
      });
    });
    ['issueRepo', 'issueLabels', 'issueMaxIterations'].forEach(id => {
      document.getElementById(id).addEventListener('change', loadActionCapabilities);
    });
    ['jobStatusFilter', 'jobRunFilter'].forEach(id => {
      document.getElementById(id).addEventListener('change', loadJobs);
    });
    document.querySelectorAll('button[data-action]').forEach(btn => btn.addEventListener('click', () => startActionJob(btn.dataset.action, btn)));
    document.addEventListener('click', event => {
      const target = event.target;
      if (target instanceof HTMLElement && target.dataset.copy) copyText(target.dataset.copy);
      if (target instanceof HTMLElement && target.dataset.jobDetail) loadJobDetail(target.dataset.jobDetail);
      if (target instanceof HTMLElement && target.dataset.jobCancel) cancelJob(target);
      if (target instanceof HTMLElement && target.dataset.jobRetry) retryJob(target);
      if (target instanceof HTMLElement && target.dataset.recoveryPlan) planRecovery(target);
      if (target instanceof HTMLElement && target.dataset.recoveryApply) applyRecovery(target);
      if (target instanceof HTMLElement && target.dataset.taskPlan) planTaskExecution(target);
      if (target instanceof HTMLElement && target.dataset.taskExecute) executeTaskPlan(target);
      if (target instanceof HTMLElement && target.dataset.diffBatchDecision !== undefined) recordDiffBatchDecisionFromForm(target);
      if (target instanceof HTMLElement && target.dataset.diffDecision !== undefined) recordDiffDecisionFromForm(target);
    });
    if (new URLSearchParams(window.location.search).get('newProject') === '1') {
      document.getElementById('workspaceDialog').showModal();
    }
    Promise.all([loadWorkspaces(), load()]).catch(error => { document.getElementById('monitor').textContent = error.stack || error.message; });
  </script>
</body>
</html>`;
}
