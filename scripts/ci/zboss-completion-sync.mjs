import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = process.cwd();
const packageJson = await readJson(path.join(repositoryRoot, "package.json"));
const producer = {
  tool: "migration-guard-zboss-completion-sync",
  version: packageJson.version,
  command: "npm run zboss-rust:completion-sync",
  identity: "migration-guard:zboss-evidence-bridge",
};

const projects = [
  {
    id: "zboss-page",
    expected: "L0",
  },
  {
    id: "zboss-query",
    expected: "L0",
  },
  {
    id: "zboss-horizontal-list",
    expected: "L0",
  },
  {
    id: "zboss-batch-update-with-progress",
    expected: "L4-A",
    reports: {
      l3: "artifacts/batch-update-rust/l3-gate.json",
      dependency: "artifacts/batch-update-rust/container-adapter-gate.json",
    },
  },
  {
    id: "zboss-batch-delete",
    expected: "L4-B",
    reports: {
      l3: "artifacts/batch-delete-rust/l3-gate.json",
      dependency: "artifacts/batch-delete-rust/container-adapter-gate.json",
      production: "artifacts/batch-delete-rust/l4b-gate.json",
    },
  },
];

const summaries = [];
for (const project of projects) {
  const caseDir = path.join(repositoryRoot, "cases", project.id);
  runCli(
    ["migrate", "offline-gate", "--case-dir", caseDir],
    project.expected === "L0" ? [0, 1] : [0],
  );
  runCli(
    ["migrate", "completion-prepare", "--case-dir", caseDir, "--force"],
    [0],
  );

  const template = await readJson(
    path.join(caseDir, "completion-evidence.template.json"),
  );
  const contract = await readJson(path.join(caseDir, "completion-contract.json"));
  const offline = await readAndValidateReport(
    path.join(caseDir, "evidence", "gates", "offline-gate.json"),
    ["passed"],
  );
  // Specialized reports are ineligible when the generic offline prerequisite
  // is blocked. Do not let a stale or weaker side gate interrupt the honest L0
  // result, and never use it to manufacture downstream completion controls.
  const l3 = offline
    ? await optionalReport(project.reports?.l3, ["pass"])
    : undefined;
  const dependency = offline
    ? await optionalReport(project.reports?.dependency, ["pass"])
    : undefined;
  const production = offline
    ? await optionalReport(project.reports?.production, ["pass"])
    : undefined;
  const now = new Date().toISOString();
  const completionDir = path.join(caseDir, "evidence", "completion");
  await mkdir(completionDir, { recursive: true });

  const controls = {};
  for (const control of contract.controls) {
    const upstream = qualifyingReport(
      control.id,
      offline,
      l3,
      dependency,
      production,
      project.id,
    );
    if (!upstream) {
      controls[control.id] = {
        status: "blocked",
        observedAt: now,
        artifacts: [],
        note: "No fresh qualifying upstream gate proves this control.",
      };
      continue;
    }
    const proof = {
      schemaVersion: 1,
      protocol: "migration-guard.completion-control-evidence/v1",
      projectId: project.id,
      projectHash: template.projectHash,
      controlId: control.id,
      evidenceKind: control.evidenceKind,
      status: "passed",
      observedAt: now,
      synthetic: false,
      realEligible: true,
      producer,
      claims: {
        [requiredClaim(control.id)]: true,
        upstreamPath: relativeToRepository(upstream.path),
        upstreamDecision: String(upstream.report.decision ?? ""),
        upstreamReportHash: String(upstream.report.reportHash),
      },
    };
    const proofPath = path.join(completionDir, `${control.id}.json`);
    const content = `${JSON.stringify(proof, null, 2)}\n`;
    await writeFile(proofPath, content, "utf8");
    controls[control.id] = {
      status: "passed",
      observedAt: now,
      artifacts: [
        {
          path: path.relative(caseDir, proofPath).replaceAll("\\", "/"),
          sha256: sha256(Buffer.from(content).toString("base64")),
          controlId: control.id,
          evidenceKind: control.evidenceKind,
        },
      ],
      note: `Imported from ${relativeToRepository(upstream.path)} after status and report-hash validation.`,
    };
  }

  await writeJson(path.join(caseDir, "completion-evidence.json"), {
    schemaVersion: 1,
    projectId: project.id,
    projectHash: template.projectHash,
    generatedAt: now,
    controls,
  });
  runCli(
    ["migrate", "completion-gate", "--case-dir", caseDir],
    project.expected === "L4" ? [0] : [1],
  );
  const gate = await readJson(
    path.join(caseDir, "evidence", "gates", "completion-gate.json"),
  );
  if (gate.capability?.achieved !== project.expected) {
    throw new Error(
      `${project.id} completion level mismatch: expected ${project.expected}, got ${gate.capability?.achieved}`,
    );
  }
  summaries.push({
    projectId: project.id,
    status: gate.status,
    achieved: gate.capability.achieved,
    next: gate.capability.next,
    passedControls: gate.controlSummary.passed,
    totalControls: gate.controlSummary.total,
  });
}

console.log(JSON.stringify({ status: "synchronized", projects: summaries }, null, 2));

function qualifyingReport(
  controlId,
  offline,
  l3,
  dependency,
  production,
  projectId,
) {
  if (
    controlId === "source.read-only-snapshot"
    || controlId === "analysis.complete"
    || controlId === "offline.contract"
  ) {
    return offline;
  }
  if (
    controlId === "implementation.checks"
    || controlId === "scenario.contract"
  ) {
    return offline && l3;
  }
  if (controlId === "dependency.protocol") {
    return offline && l3 && dependency;
  }
  if (controlId.startsWith("schema-transition.")) {
    return projectId === "zboss-batch-update-with-progress"
      && offline
      && l3
      && dependency
      ? dependency
      : undefined;
  }
  if (
    controlId.startsWith("production.adapter.")
    || controlId === "production.concrete-adapters"
    || controlId === "production.http-service"
    || controlId === "production.configuration"
    || controlId === "production.health-readiness"
  ) {
    return projectId === "zboss-batch-delete"
      && offline
      && l3
      && dependency
      && production
      ? production
      : undefined;
  }
  return undefined;
}

function requiredClaim(controlId) {
  const claims = {
    "source.read-only-snapshot": "sourceSnapshotUnchanged",
    "analysis.complete": "analysisComplete",
    "offline.contract": "offlineContractPassed",
    "implementation.checks": "implementationChecksPassed",
    "scenario.contract": "scenarioContractPassed",
    "dependency.protocol": "integrationPassed",
    "production.concrete-adapters": "productionEligible",
    "production.http-service": "productionEligible",
    "production.configuration": "integrationPassed",
    "production.health-readiness": "integrationPassed",
    "schema-transition.client-boundary": "integrationPassed",
    "schema-transition.lease": "integrationPassed",
    "schema-transition.idempotency": "integrationPassed",
    "schema-transition.resume": "integrationPassed",
    "schema-transition.ddl-fault": "integrationPassed",
  };
  if (controlId.startsWith("production.adapter.")) {
    return "productionEligible";
  }
  const claim = claims[controlId];
  if (!claim) {
    throw new Error(`unsupported passing completion control: ${controlId}`);
  }
  return claim;
}

async function optionalReport(relativePath, statuses) {
  return relativePath
    ? readAndValidateReport(path.join(repositoryRoot, relativePath), statuses)
    : undefined;
}

async function readAndValidateReport(file, statuses) {
  const report = await readJson(file);
  if (!statuses.includes(report.status)) {
    return undefined;
  }
  if (!report.reportHash) {
    throw new Error(`upstream report has no reportHash: ${file}`);
  }
  const { reportHash, ...payload } = report;
  if (reportHash !== sha256(stableStringify(payload))) {
    throw new Error(`upstream report hash is invalid: ${file}`);
  }
  return { path: file, report };
}

function runCli(args, allowedStatuses) {
  const result = spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(
      `migration-guard ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function relativeToRepository(file) {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
