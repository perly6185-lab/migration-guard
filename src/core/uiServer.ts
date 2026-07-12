import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { collectDashboard, collectDashboardBlockers, collectRunsList } from "./dashboard.js";
import { pathExists, readJsonFile } from "./files.js";
import { loadRunPackage } from "./migrationRun.js";
import { assessRefactorReadiness, writeRefactorReadinessReport } from "./refactorReadiness.js";
import { captureSnapshot, saveSnapshot } from "./snapshot.js";
import { superviseIssueControl } from "./issueControl.js";
import type { LoadedConfig, CompareReport } from "../types.js";

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
  const server = http.createServer((request, response) => {
    void handleUiRequest(loaded, options, request, response);
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
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, renderUiHtml());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(response, await collectDashboard(loaded, { checkTargetGit: true }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/blockers") {
      sendJson(response, await collectDashboardBlockers(loaded, { checkTargetGit: true }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/runs") {
      sendJson(response, await collectRunsList(loaded));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/diffs") {
      sendJson(response, await collectDiffArtifacts(loaded));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/audit") {
      sendJson(response, await readAuditLog(loaded));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/actions/readiness") {
      const pkg = await loadRunPackage(loaded, url.searchParams.get("run") ?? "latest");
      sendJson(response, await writeRefactorReadinessReport(loaded, pkg, await assessRefactorReadiness(loaded, pkg)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/actions/verify") {
      const snapshotPath = await saveSnapshot(loaded, await captureSnapshot(loaded, "run"));
      sendJson(response, { status: "complete", snapshotPath });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/actions/issue-control-dry-run") {
      const labels = url.searchParams.get("labels")?.split(",").map((label) => label.trim()).filter(Boolean);
      sendJson(response, await superviseIssueControl(loaded, {
        labels,
        execute: false,
        fetchImpl: options.fetchImpl,
        maxIterations: Number(url.searchParams.get("maxIterations") ?? 3)
      }));
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  } catch (error) {
    sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function collectDiffArtifacts(loaded: LoadedConfig): Promise<Array<{
  path: string;
  id?: string;
  passed?: boolean;
  differenceCount?: number;
  differences: Array<{ area: string; name: string; severity?: string; message: string }>;
}>> {
  const files = await findJsonFiles(loaded.artifactsDir);
  const reports = [];
  for (const file of files.filter((item) => /compare.*\.json$|diff.*\.json$/.test(path.basename(item)))) {
    try {
      const report = await readJsonFile<Partial<CompareReport> & { id?: string }>(file);
      if (!Array.isArray(report.differences)) {
        continue;
      }
      reports.push({
        path: file,
        id: report.id,
        passed: report.passed,
        differenceCount: report.differences.length,
        differences: report.differences.slice(0, 20).map((difference) => ({
          area: difference.area,
          name: difference.name,
          severity: difference.severity,
          message: difference.message
        }))
      });
    } catch {
      // Ignore non-report JSON files; the UI is observational.
    }
  }
  return reports.sort((a, b) => a.path.localeCompare(b.path));
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

async function findJsonFiles(root: string): Promise<string[]> {
  if (!await pathExists(root)) {
    return [];
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files;
}

function sendJson(response: http.ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data, null, 2));
}

function sendHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

function renderUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Migration Guard</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#ffffff; --ink:#20242a; --muted:#68707c; --line:#d9dde4; --ok:#13795b; --warn:#9a6700; --bad:#c52727; --blue:#1f5fbf; }
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--ink); }
    header { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; background:#222831; color:white; }
    h1 { margin:0; font-size:18px; font-weight:700; }
    main { display:grid; grid-template-columns: 310px 1fr; gap:14px; padding:14px; }
    section, aside { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; min-width:0; }
    h2 { margin:0 0 10px; font-size:15px; }
    button { border:1px solid var(--line); background:white; color:var(--ink); border-radius:6px; padding:7px 9px; cursor:pointer; }
    button:hover { border-color:var(--blue); color:var(--blue); }
    .grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:10px; }
    .stat { border:1px solid var(--line); border-radius:8px; padding:10px; background:#fbfcfd; }
    .stat strong { display:block; font-size:22px; }
    .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:7px 6px; vertical-align:top; }
    th { color:var(--muted); font-weight:600; }
    .stack { display:grid; gap:14px; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; }
    .muted { color:var(--muted); }
    pre { max-height:260px; overflow:auto; background:#111827; color:#e5e7eb; padding:10px; border-radius:8px; }
    @media (max-width: 900px) { main { grid-template-columns:1fr; } .grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header><h1>Migration Guard</h1><button id="refresh">Refresh</button></header>
  <main>
    <aside class="stack">
      <section><h2>Status</h2><div id="stats" class="grid"></div></section>
      <section><h2>Guarded Actions</h2><div class="actions">
        <button data-action="readiness">Readiness</button>
        <button data-action="verify">Verify</button>
        <button data-action="issue-control-dry-run">Issue Dry-run</button>
      </div><p class="muted">Buttons only call read-only or dry-run endpoints.</p></section>
      <section><h2>Unattended Audit</h2><pre id="audit">[]</pre></section>
    </aside>
    <div class="stack">
      <section><h2>Blockers</h2><div id="blockers"></div></section>
      <section><h2>Runs</h2><div id="runs"></div></section>
      <section><h2>Ready Tasks</h2><div id="tasks"></div></section>
      <section><h2>Stuck Proposals</h2><div id="proposals"></div></section>
      <section><h2>Evidence / Diff</h2><div id="diffs"></div></section>
      <section><h2>Monitor</h2><pre id="monitor">{}</pre></section>
    </div>
  </main>
  <script>
    async function json(path, options) {
      const res = await fetch(path, options);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      return body;
    }
    function table(rows, columns) {
      if (!rows.length) return '<p class="muted">none</p>';
      return '<table><thead><tr>' + columns.map(c => '<th>' + c.label + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(row => '<tr>' + columns.map(c => '<td>' + escapeHtml(String(c.value(row) ?? '')) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>';
    }
    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    async function load() {
      const [dashboard, blockers, runs, diffs, audit] = await Promise.all([
        json('/api/dashboard'), json('/api/blockers'), json('/api/runs'), json('/api/diffs'), json('/api/audit')
      ]);
      document.getElementById('stats').innerHTML = [
        ['Readiness', dashboard.readiness?.status || 'unknown'],
        ['Blockers', dashboard.summary.blockerCount],
        ['Warnings', dashboard.summary.warningCount],
        ['Ready tasks', dashboard.summary.readyTaskCount],
        ['Stuck proposals', dashboard.summary.stuckProposalCount],
        ['Runs', runs.runCount]
      ].map(([k,v]) => '<div class="stat"><span class="muted">' + k + '</span><strong>' + v + '</strong></div>').join('');
      document.getElementById('blockers').innerHTML = table(blockers.blockers, [
        {label:'Severity', value:r=>r.severity}, {label:'Scope', value:r=>r.scope}, {label:'Title', value:r=>r.title}, {label:'Next', value:r=>r.nextAction || 'none'}
      ]);
      document.getElementById('runs').innerHTML = table(runs.runs, [
        {label:'Run', value:r=>r.runId}, {label:'Status', value:r=>r.status}, {label:'Readiness', value:r=>r.readinessStatus || 'unknown'}, {label:'Blocked', value:r=>r.blockedCount}
      ]);
      document.getElementById('tasks').innerHTML = table(dashboard.readyTasks, [
        {label:'Task', value:r=>r.taskId}, {label:'Risk', value:r=>r.risk}, {label:'Owner', value:r=>r.owner}, {label:'Title', value:r=>r.title}
      ]);
      document.getElementById('proposals').innerHTML = table(dashboard.stuckProposals, [
        {label:'Proposal', value:r=>r.proposalId}, {label:'State', value:r=>r.state}, {label:'Risk', value:r=>r.risk}, {label:'Title', value:r=>r.title}
      ]);
      document.getElementById('diffs').innerHTML = table(diffs, [
        {label:'Report', value:r=>r.path}, {label:'Passed', value:r=>r.passed}, {label:'Diffs', value:r=>r.differenceCount}
      ]);
      document.getElementById('audit').textContent = JSON.stringify(audit.slice(-8), null, 2);
      document.getElementById('monitor').textContent = JSON.stringify({ progress: dashboard.progress, safety: dashboard.progress?.safetyEnvelope, generatedAt: dashboard.createdAt }, null, 2);
    }
    async function act(name) {
      const path = name === 'readiness' ? '/api/actions/readiness' : name === 'verify' ? '/api/actions/verify' : '/api/actions/issue-control-dry-run';
      await json(path, { method:'POST' });
      await load();
    }
    document.getElementById('refresh').addEventListener('click', load);
    document.querySelectorAll('button[data-action]').forEach(btn => btn.addEventListener('click', () => act(btn.dataset.action).catch(err => alert(err.message))));
    load().catch(err => { document.body.insertAdjacentHTML('beforeend', '<pre>' + escapeHtml(err.stack || err.message) + '</pre>'); });
  </script>
</body>
</html>`;
}
