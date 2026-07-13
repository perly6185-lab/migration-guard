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
import type {
  LoadedConfig
} from "../types.js";

export interface UiServerOptions {
  host?: string;
  port?: number;
  open?: boolean;
  fetchImpl?: typeof fetch;
}

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
  const csrfToken = createUiCsrfToken();
  const server = http.createServer((request, response) => {
    void handleUiRequest(loaded, options, csrfToken, request, response);
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
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function handleUiRequest(
  loaded: LoadedConfig,
  options: UiServerOptions,
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
      sendJson(response, await gcUiJobs(loaded, await readUiPostParams(request, url.searchParams)));
      return;
    }
    const jobDetailMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/detail$/);
    if (request.method === "GET" && jobDetailMatch) {
      sendJson(response, await collectUiJobDetail(loaded, jobDetailMatch[1] ?? ""));
      return;
    }
    const cancelJobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelJobMatch) {
      sendJson(response, await cancelUiJob(loaded, cancelJobMatch[1] ?? ""));
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
    }
  </style>
</head>
<body>
  <header>
    <h1>Migration Guard</h1>
    <div class="toolbar">
      <select id="runSelect" aria-label="Run selector"><option value="">latest</option></select>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <aside class="stack">
      <section><div class="panel-head"><h2>Status</h2></div><div id="stats" class="grid"><p class="muted">Loading...</p></div><p id="runMeta" class="run-meta"></p></section>
      <section><div class="panel-head"><h2>Guarded Actions</h2></div><div class="actions">
        <button data-action="readiness">Write Readiness</button>
        <button data-action="verify" data-confirm="Capture a verification snapshot for the configured target. This writes a run artifact and may take a while. Continue?">Capture Snapshot</button>
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
      <section><div class="panel-head"><h2>Blockers</h2></div><div id="blockers"><p class="muted">Loading...</p></div></section>
      <section><div class="panel-head"><h2>Runs</h2></div><div id="runs"><p class="muted">Loading...</p></div></section>
      <section><div class="panel-head"><h2>Ready Tasks</h2></div><div id="tasks"><p class="muted">Loading...</p></div></section>
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
        '<dl class="kv"><dt>Risk</dt><dd>' + escapeHtml(task.risk) + '</dd><dt>Owner</dt><dd>' + escapeHtml(task.owner) + '</dd><dt>Issue</dt><dd>' + escapeHtml(task.issueId || 'none') + '</dd></dl></details>').join('') + '</div>';
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
        loadRunScoped(),
        loadJobs(),
        json('/api/audit')
          .then(audit => { document.getElementById('audit').textContent = JSON.stringify(audit.slice(-8), null, 2); })
          .catch(error => { document.getElementById('audit').textContent = error.message || String(error); })
      ]);
    }
    function actionJobPath(name) {
      if (name === 'readiness') return '/api/jobs/actions/readiness';
      if (name === 'verify') return '/api/jobs/actions/verify';
      return '/api/jobs/actions/issue-control-dry-run';
    }
    function actionJobParams(name) {
      if (name === 'readiness') return runScopedParams();
      if (name === 'verify') return {};
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
      if (target instanceof HTMLElement && target.dataset.diffBatchDecision !== undefined) recordDiffBatchDecisionFromForm(target);
      if (target instanceof HTMLElement && target.dataset.diffDecision !== undefined) recordDiffDecisionFromForm(target);
    });
    load().catch(error => { document.getElementById('monitor').textContent = error.stack || error.message; });
  </script>
</body>
</html>`;
}
