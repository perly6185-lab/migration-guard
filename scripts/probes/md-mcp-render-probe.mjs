import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const targetRoot = process.env.MD_TARGET_ROOT
  ? path.resolve(process.env.MD_TARGET_ROOT)
  : findTargetRoot(process.cwd());
const mcpPackageRoot = path.join(targetRoot, "packages", "mcp-server");

if (process.env.MD_MCP_RENDER_PROBE_CHILD !== "1") {
  const exitCode = await runInMcpPackage();
  process.exit(exitCode);
}

function targetModule(relativePath) {
  return pathToFileURL(path.join(targetRoot, relativePath)).href;
}

function findTargetRoot(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    if (
      fs.existsSync(path.join(current, "pnpm-workspace.yaml"))
      && fs.existsSync(path.join(current, "packages", "mcp-server", "src", "render-article.ts"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not locate md target root from ${startDir}`);
    }
    current = parent;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function runInMcpPackage() {
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      [
        "--silent",
        "--filter",
        "@md/mcp-server",
        "exec",
        "tsx",
        fileURLToPath(import.meta.url)
      ],
      {
        cwd: targetRoot,
        env: {
          ...process.env,
          MD_MCP_RENDER_PROBE_CHILD: "1",
          MD_TARGET_ROOT: targetRoot
        },
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    child.on("error", (error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`MCP render probe child exited with signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

let remoteFetchCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  remoteFetchCount += 1;
  return originalFetch(...args);
};

process.chdir(mcpPackageRoot);

const { buildRenderedOutput, clearHljsCssCache } = await import(targetModule("packages/mcp-server/src/render-article.ts"));

clearHljsCssCache();

const markdown = [
  "---",
  "title: MCP Probe",
  "---",
  "",
  "# MCP Render",
  "",
  "> [!TIP]",
  "> Render contract",
  "",
  "```ts",
  "const value = 1",
  "```",
  "",
  "$$E=mc^2$$"
].join("\n");

const output = await buildRenderedOutput({
  markdown,
  theme: "default",
  primaryColor: "#0F4C81",
  fontSize: "16px",
  legend: "alt",
  countStatus: true,
  isMacCodeBlock: true,
  isShowLineNumber: true,
  citeStatus: false,
  codeBlockTheme: "",
  customCSS: ".migration-guard-mcp-probe{display:block;}"
});

globalThis.fetch = originalFetch;

const expectations = {
  hasStyle: output.html.includes("<style>"),
  hasHeading: output.html.includes("<h1"),
  hasAlert: output.html.includes("markdown-alert"),
  hasKatexBlock: output.html.includes("katex-block"),
  hasCodeBlock: output.html.includes("code__pre"),
  hasMacSign: output.html.includes("mac-sign"),
  hasLineNumberData: output.html.includes("data-show-line-number=\"true\"") || output.html.includes("line-numbers"),
  hasCustomCss: output.html.includes(".migration-guard-mcp-probe"),
  frontMatterTitle: output.frontMatter?.title === "MCP Probe",
  readingWordsPositive: output.readingTime.words > 0,
  avoidedRemoteCssFetch: remoteFetchCount === 0
};

const result = {
  mcp: {
    expectations,
    remoteFetchCount,
    htmlHash: sha256(output.html),
    htmlLength: output.html.length,
    readingWords: output.readingTime.words,
    readingMinutes: output.readingTime.minutes
  }
};

console.log(JSON.stringify(result));

if (Object.values(expectations).some(value => value !== true)) {
  process.exitCode = 1;
}
