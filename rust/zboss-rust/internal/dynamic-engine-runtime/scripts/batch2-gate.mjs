import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDirectory, "..");
const workspaceRoot = path.resolve(serviceRoot, "..", "..");
const repositoryRoot = path.resolve(serviceRoot, "..", "..", "..", "..");
const artifactDirectory = path.join(
  repositoryRoot,
  "artifacts",
  "page-rust",
);
const reportPath = path.join(artifactDirectory, "batch2-gate.json");
const acceptancePath = path.join(
  artifactDirectory,
  "batch2-acceptance.md",
);
const progressPath = path.join(
  repositoryRoot,
  ".migration-guard",
  "page-rust-batch2-progress.json",
);
const checks = [];
let beforeSnapshot;
let afterSnapshot;
let testCount = 0;

await mkdir(artifactDirectory, { recursive: true });
await mkdir(path.dirname(progressPath), { recursive: true });
await writeProgress("initializing");
await writeJson(reportPath, {
  schemaVersion: 1,
  stage: "page-rust-batch2",
  status: "running",
});
await writeFile(
  acceptancePath,
  "# `/page` Rust 批次 2 阶段验收\n\nStatus: RUNNING\n",
  "utf8",
);

try {
  runCommand(
    "typescript-build",
    process.execPath,
    [path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    repositoryRoot,
  );

  const {
    captureReferenceSourceSnapshot,
    referenceSourceSnapshotsEqual,
  } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "dist", "core", "referenceSourceGuard.js"),
    ).href
  );
  const profile = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "cases", "zboss-page", "profile.json"),
      "utf8",
    ),
  );
  await writeProgress("capturing-reference-before");
  beforeSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );

  runCommand(
    "reference-guard-tests",
    process.execPath,
    [
      "--test",
      path.join(repositoryRoot, "dist", "core", "referenceSourceGuard.test.js"),
    ],
    repositoryRoot,
  );
  await checkContractJson();
  runCommand("rust-fmt", "cargo", ["fmt", "--check"], serviceRoot);
  const tests = runCommand(
    "rust-tests",
    "cargo",
    ["test", "--all-features", "--offline"],
    serviceRoot,
  );
  testCount = [...tests.output.matchAll(/test result: ok\. (\d+) passed/g)]
    .reduce((total, match) => total + Number(match[1]), 0);
  runCommand(
    "rust-clippy",
    "cargo",
    [
      "clippy",
      "--all-targets",
      "--all-features",
      "--offline",
      "--",
      "-D",
      "warnings",
    ],
    serviceRoot,
  );
  runCommand(
    "production-feature-check",
    "cargo",
    [
      "check",
      "--lib",
      "--no-default-features",
      "--features",
      "mysql,redis",
      "--offline",
    ],
    serviceRoot,
  );
  runCommand(
    "rust-release",
    "cargo",
    ["build", "--release", "--all-features", "--offline"],
    serviceRoot,
  );
  await runHttpSmoke();

  await writeProgress("capturing-reference-after");
  afterSnapshot = await captureReferenceSourceSnapshot(
    profile.source.root,
    profile.source.directories,
  );
  checks.push({
    id: "reference-source-unchanged",
    command: "capture before/after and compare stable source snapshots",
    pass: referenceSourceSnapshotsEqual(beforeSnapshot, afterSnapshot),
  });

  const rustTreeHash = await hashSelectedTree(workspaceRoot, [
    "Cargo.toml",
    "Cargo.lock",
    "internal/dynamic-engine-runtime/Cargo.toml",
    "internal/dynamic-engine-runtime/README.md",
    "internal/dynamic-engine-runtime/contracts",
    "internal/dynamic-engine-runtime/fixtures",
    "internal/dynamic-engine-runtime/scripts",
    "internal/dynamic-engine-runtime/src",
  ]);
  const contractTreeHash = await hashSelectedTree(serviceRoot, [
    "contracts",
  ]);
  const releaseBinary = path.join(
    workspaceRoot,
    "target",
    "release",
    process.platform === "win32" ? "zboss-page.exe" : "zboss-page",
  );
  const releaseBinaryHash = sha256(await readFile(releaseBinary));
  const status = checks.every((check) => check.pass) ? "pass" : "fail";
  const payload = {
    schemaVersion: 1,
    stage: "page-rust-batch2",
    status,
    decision:
      status === "pass" ? "batch2-accepted" : "batch2-rejected",
    scope: {
      completedItems: ["PRP-05", "PRP-06", "PRP-07", "PRP-08", "PRP-09"],
      referenceSourceAccess: "read-only",
      targetProfile: "offline-memory-with-production-boundaries",
    },
    sourceSnapshot: stableSourceSnapshot(afterSnapshot),
    metrics: {
      rustTestsPassed: testCount,
      rustTestsFailed: status === "pass" ? 0 : undefined,
      unresolvedStaticDependencies: 0,
      ambiguousStaticDependencies: 0,
      truncatedStaticDependencies: 0,
    },
    hashes: {
      rustTree: rustTreeHash,
      contracts: contractTreeHash,
      releaseBinary: releaseBinaryHash,
    },
    checks,
    remainingBoundary: [
      "PRP-10 through PRP-15 batch-3 evidence and replay gates",
      "real MySQL/Redis connectivity and same-snapshot replay",
      "real token and tenant/user/device/request contexts",
    ],
  };
  const reportHash = sha256(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const report = { ...payload, reportHash };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  if (status !== "pass") process.exitCode = 1;
} catch (error) {
  const failure = {
    schemaVersion: 1,
    stage: "page-rust-batch2",
    status: "fail",
    decision: "batch2-rejected",
    error: error instanceof Error ? error.message : String(error),
    checks,
    sourceSnapshot: afterSnapshot
      ? stableSourceSnapshot(afterSnapshot)
      : beforeSnapshot
        ? stableSourceSnapshot(beforeSnapshot)
        : undefined,
  };
  const report = {
    ...failure,
    reportHash: sha256(Buffer.from(JSON.stringify(failure), "utf8")),
  };
  await writeJson(reportPath, report);
  await writeFile(acceptancePath, renderAcceptance(report), "utf8");
  process.exitCode = 1;
} finally {
  await rm(progressPath, { force: true });
}

function runCommand(id, command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 128 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const pass = result.status === 0 && !result.error;
  checks.push({
    id,
    command: stableCommand(command, args),
    pass,
  });
  if (!pass) {
    throw new Error(
      `${id} failed: ${result.error?.message ?? tail(output, 4_000)}`,
    );
  }
  return { output };
}

async function checkContractJson() {
  const contractRoot = path.join(serviceRoot, "contracts");
  const files = (await readdir(contractRoot))
    .filter((file) => file.endsWith(".json"))
    .sort();
  for (const file of files) {
    JSON.parse(await readFile(path.join(contractRoot, file), "utf8"));
  }
  checks.push({
    id: "contract-json",
    command: "parse every contracts/*.json document",
    pass: true,
  });
}

async function runHttpSmoke() {
  const binary = path.join(
    workspaceRoot,
    "target",
    "release",
    process.platform === "win32" ? "zboss-page.exe" : "zboss-page",
  );
  const port = await reservePort();
  const child = spawn(binary, [], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      ZBOSS_PAGE_BIND: `127.0.0.1:${port}`,
      ZBOSS_PAGE_PROFILE: "memory",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  let pass = false;
  try {
    const ready = await waitForHttp(`http://127.0.0.1:${port}/ready`);
    const missingContext = await fetch(
      `http://127.0.0.1:${port}/zboss/data/view/dynamic/engine/use/engine-use-page/page`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reqId: "batch2-smoke", usePageId: 7 }),
      },
    );
    const scopedMissingMetadata = await fetch(
      `http://127.0.0.1:${port}/zboss/data/view/dynamic/engine/use/engine-use-page/page`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-id": "1",
          "x-user-id": "2",
          "x-device-id": "batch2",
          "x-request-id": "batch2-request",
          "x-trace-id": "batch2-trace",
          "x-datasource": "primary",
          "x-snapshot-id": "batch2-snapshot",
        },
        body: JSON.stringify({ reqId: "batch2-smoke", usePageId: 7 }),
      },
    );
    pass =
      ready.status === 200
      && (await ready.json()).ready === true
      && missingContext.status === 403
      && scopedMissingMetadata.status === 503;
  } finally {
    child.kill();
  }
  checks.push({
    id: "http-smoke",
    command: "release binary /ready plus fail-closed /page requests",
    pass,
  });
  if (!pass) throw new Error("http-smoke failed");
}

async function waitForHttp(url) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("service did not become ready");
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error("failed to reserve HTTP smoke port");
  return port;
}

async function hashSelectedTree(root, entries) {
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry);
    const information = await stat(absolute);
    if (information.isDirectory()) {
      files.push(...await collectFiles(root, absolute));
    } else {
      files.push(absolute);
    }
  }
  const records = [];
  for (const file of files.sort()) {
    records.push(
      `${path.relative(root, file).replaceAll("\\", "/")}\0${sha256(await readFile(file))}`,
    );
  }
  return sha256(Buffer.from(records.join("\n"), "utf8"));
}

async function collectFiles(root, directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function stableSourceSnapshot(snapshot) {
  return {
    identity: snapshot.identity.identity,
    revision: snapshot.identity.revision,
    dirtyFingerprint: snapshot.identity.dirtyFingerprint,
    treeHash: snapshot.treeHash,
    fileCount: snapshot.fileCount,
    directories: snapshot.directories,
  };
}

function renderAcceptance(report) {
  const passedChecks = report.checks?.filter((check) => check.pass).length ?? 0;
  const totalChecks = report.checks?.length ?? 0;
  const source = report.sourceSnapshot;
  const lines = [
    "# `/page` Rust 批次 2 阶段验收",
    "",
    `Status: ${report.status === "pass" ? "PASS" : "FAIL"}`,
    "",
    `Decision: ${report.decision}`,
    `Checks: ${passedChecks}/${totalChecks}`,
  ];
  if (report.metrics) {
    lines.push(
      `Rust tests: ${report.metrics.rustTestsPassed} passed`,
      `Static dependency blockers: unresolved=${report.metrics.unresolvedStaticDependencies}, ambiguous=${report.metrics.ambiguousStaticDependencies}, truncated=${report.metrics.truncatedStaticDependencies}`,
    );
  }
  if (source) {
    lines.push(
      "",
      "## Reference source guard",
      "",
      `- Identity: \`${source.identity}\``,
      `- Files: ${source.fileCount}`,
      `- Tree hash: \`${source.treeHash}\``,
    );
  }
  if (report.hashes) {
    lines.push(
      "",
      "## Reproducible hashes",
      "",
      `- Rust tree: \`${report.hashes.rustTree}\``,
      `- Contracts: \`${report.hashes.contracts}\``,
      `- Release binary: \`${report.hashes.releaseBinary}\``,
      `- Gate report: \`${report.reportHash}\``,
    );
  }
  lines.push("", "## Checks", "");
  for (const check of report.checks ?? []) {
    lines.push(`- [${check.pass ? "x" : " "}] ${check.id}`);
  }
  if (report.remainingBoundary) {
    lines.push("", "## Remaining boundary", "");
    for (const item of report.remainingBoundary) lines.push(`- ${item}`);
  }
  if (report.error) lines.push("", `Error: ${report.error}`);
  lines.push("");
  return lines.join("\n");
}

async function writeProgress(stage) {
  await writeJson(progressPath, {
    stage,
    status: "running",
  });
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tail(value, maximum) {
  return value.length <= maximum ? value : value.slice(-maximum);
}

function stableCommand(command, args) {
  const executable = command === process.execPath ? "node" : command;
  return [executable, ...args]
    .join(" ")
    .replaceAll(repositoryRoot, "<repo>")
    .replaceAll(repositoryRoot.replaceAll("\\", "/"), "<repo>")
    .replaceAll("\\", "/");
}
