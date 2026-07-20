import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { startUiServer, type UiServerHandle } from "../core/uiServer.js";
import { loadDesktopHostConfig } from "./config.js";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, Menu, shell } = require("electron") as typeof import("electron");

let serverHandle: UiServerHandle | undefined;
let serverClosePromise: Promise<void> | undefined;

export async function runDesktopApp(): Promise<void> {
  configureDesktopPaths();
  app.setName("Migration Guard");
  app.setAppUserModelId("com.migrationguard.desktop");
  registerShutdownHandlers();

  await app.whenReady();
  if (process.env.MG_DESKTOP_SMOKE === "1") {
    await runDesktopSmokeMode();
    return;
  }

  Menu.setApplicationMenu(null);
  const handle = await startDesktopBackend();
  await createDesktopWindow(handle);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
      void createDesktopWindow(serverHandle);
    }
  });
}

export async function startDesktopBackend(): Promise<UiServerHandle> {
  if (serverHandle) {
    return serverHandle;
  }
  const loaded = await loadDesktopHostConfig({
    currentWorkingDirectory: process.cwd(),
    userDataDir: app.getPath("userData"),
    configPath: process.env.MG_DESKTOP_CONFIG
  });
  serverHandle = await startUiServer(loaded, { host: "127.0.0.1", port: 0 });
  return serverHandle;
}

export function isLocalUiUrl(candidate: string, serverUrl: string): boolean {
  try {
    const target = new URL(candidate);
    const server = new URL(serverUrl);
    return target.origin === server.origin;
  } catch {
    return false;
  }
}

async function createDesktopWindow(handle: UiServerHandle): Promise<ElectronBrowserWindow> {
  const win = new BrowserWindow({
    title: "Migration Guard",
    width: 1365,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: "#f5f7fa",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.once("ready-to-show", () => {
    win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUiUrl(url, handle.url)) {
      return { action: "allow" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isLocalUiUrl(url, handle.url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  await win.loadURL(handle.url);
  return win;
}

async function runDesktopSmokeMode(): Promise<void> {
  const handle = await startDesktopBackend();
  const response = await fetch(`${handle.url}/api/session`);
  if (!response.ok) {
    throw new Error(`Desktop UI smoke request failed: ${response.status} ${await response.text()}`);
  }
  console.log(`Migration Guard Desktop UI: ${handle.url}`);
  await closeDesktopBackend();
  app.exit(0);
}

function configureDesktopPaths(): void {
  const userDataDir = process.env.MG_DESKTOP_USER_DATA_DIR;
  if (userDataDir) {
    app.setPath("userData", path.resolve(userDataDir));
  }
}

function registerShutdownHandlers(): void {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("will-quit", (event) => {
    if (serverHandle && !serverClosePromise) {
      event.preventDefault();
      serverClosePromise = closeDesktopBackend().finally(() => {
        app.quit();
      });
    }
  });
}

async function closeDesktopBackend(): Promise<void> {
  const handle = serverHandle;
  serverHandle = undefined;
  if (handle) {
    await handle.close();
  }
}

async function showFatalWindow(error: unknown): Promise<void> {
  console.error(error);
  await app.whenReady();
  const win = new BrowserWindow({
    title: "Migration Guard",
    width: 820,
    height: 480,
    backgroundColor: "#f5f7fa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderFatalHtml(error))}`);
}

function renderFatalHtml(error: unknown): string {
  const message = escapeHtml(error instanceof Error ? error.message : String(error));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Migration Guard</title>
  <style>
    body { margin:0; font:14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background:#f5f7fa; color:#1f252e; }
    main { max-width:720px; margin:64px auto; padding:24px; background:#fff; border:1px solid #d8dee7; border-radius:8px; }
    h1 { margin:0 0 12px; font-size:20px; }
    pre { white-space:pre-wrap; background:#111827; color:#e5e7eb; padding:12px; border-radius:8px; }
  </style>
</head>
<body>
  <main>
    <h1>Migration Guard failed to start</h1>
    <pre>${message}</pre>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

if (process.versions.electron) {
  void runDesktopApp().catch(async (error) => {
    if (process.env.MG_DESKTOP_SMOKE === "1") {
      console.error(error);
      app.exit(1);
      return;
    }
    await showFatalWindow(error);
  });
}
