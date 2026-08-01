import { randomBytes } from "node:crypto";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  stableHash,
  validateReplayPlan,
} from "./l4c-replay-core.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(
  scriptDirectory,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
);
const caseRoot = path.join(
  repositoryRoot,
  "cases",
  "zboss-batch-update-with-progress",
);
const l4cRoot = path.join(caseRoot, "evidence", "runtime", "l4c");
const templatePath = path.join(l4cRoot, "replay-plan.template.json");
const outputPath = path.join(l4cRoot, "replay-plan.json");
const environmentPath = path.join(
  repositoryRoot,
  "zboss-l4c.runtime.env.local",
);
const contractPath = path.join(
  caseRoot,
  "evidence",
  "runtime",
  "java",
  "runtime-contract.json",
);
const fixturePath = path.join(
  caseRoot,
  "fixtures",
  "java-runtime",
  "post-zboss-data-view-dynamic-engine-use-engine-use-batch-page-batchUpdateWithProgress",
  "primary-success.json",
);

const options = parseArguments(process.argv.slice(2));
await requireAbsent(outputPath, "approved replay plan");
await requireAbsent(environmentPath, "local runtime environment");

const [template, contract, fixture] = await Promise.all([
  readJson(templatePath),
  readJson(contractPath),
  readJson(fixturePath),
]);
validateSourceApproval(fixture, options.ticket);

const nonce = randomBytes(32).toString("hex");
const plan = structuredClone(template);
Object.assign(plan, {
  status: "approved",
  projectHash: contract.projectHash,
  runtimeContractHash: contract.contractHash,
  approval: {
    mode: "disposable-test-write",
    approvedBy: fixture.authoring.reviewedBy,
    ticket: options.ticket,
    approvedAt: fixture.authoring.reviewedAt,
    expiresAt: fixture.writeSafety.expiresAt,
    executionNonceSha256: stableHash(nonce),
  },
  scope: {
    environment: "test",
    allowedHosts: ["127.0.0.1"],
    database: "zz_boss_test",
    tenantId: fixture.writeSafety.allowedTenantIds[0],
    panelId: fixture.writeSafety.allowedPanelIds[0],
    table: "cust_table7272",
    markerPrefix: "mg-l4c-",
    maxRowsPerScenario: fixture.writeSafety.maxAffectedRows,
    schemaChangesAllowed: false,
  },
  scenarios: ["primary-success"],
});
plan.targets.source.baseUrl = "http://127.0.0.1:22882";
plan.targets.target.baseUrl = "http://127.0.0.1:18089";

const validation = validateReplayPlan(plan, contract, {
  repositoryRoot,
  scenarioFilter: ["primary-success"],
  allowPartialScenarios: true,
});
if (validation.findings.length > 0) {
  throw new Error(validation.findings.join(", "));
}

const environment = [
  "# Local-only L4-C execution values. This file is ignored by Git.",
  `MG_L4C_APPROVAL_NONCE=${nonce}`,
  "MG_L4C_REAL_WRITE_APPROVED=zboss-batch-update-with-progress:disposable-write",
  "MG_L4C_BINDING_FILE=cases/zboss-batch-update-with-progress/evidence/runtime/l4c/bindings.primary-success.approved.json",
  "MG_L4C_JAVA_STATE_PROFILE=cases/zboss-batch-update-with-progress/evidence/runtime/l4c/java-state-profile.primary-success.approved.json",
  "MG_L4C_DATASOURCE=zz_boss_test",
  "",
  "# Add these values locally before connected preflight:",
  "# MG_JAVA_TOKEN=",
  "# MG_JAVA_USER_ID=",
  "# MG_JAVA_DATABASE_URL=",
  "# ZBOSS_BATCH_UPDATE_MYSQL_URL=",
  "# ZBOSS_BATCH_UPDATE_REDIS_URL=",
  "",
].join("\n");

await writeFile(environmentPath, environment, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
try {
  await chmod(environmentPath, 0o600);
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
} catch (error) {
  throw new Error(`write approved replay assets: ${safeMessage(error)}`);
}

console.log(JSON.stringify({
  status: "approved",
  ticket: options.ticket,
  approvedBy: plan.approval.approvedBy,
  expiresAt: plan.approval.expiresAt,
  scenario: "primary-success",
  planPath: relative(outputPath),
  environmentPath: relative(environmentPath),
  noncePersistedLocally: true,
  noncePrinted: false,
  remainingEnvironment: [
    "MG_JAVA_TOKEN",
    "MG_JAVA_USER_ID",
    "MG_JAVA_DATABASE_URL",
    "ZBOSS_BATCH_UPDATE_MYSQL_URL",
    "ZBOSS_BATCH_UPDATE_REDIS_URL",
  ],
}, null, 2));

function validateSourceApproval(fixture, ticket) {
  if (
    fixture?.scenarioId !== "primary-success"
    || fixture?.realEvidenceEligible !== true
    || fixture?.writeSafety?.writeApproved !== true
    || fixture?.writeSafety?.disposable !== true
    || fixture?.authoring?.reviewed !== true
    || typeof fixture.authoring.reviewedBy !== "string"
    || !fixture.authoring.reviewedBy
    || !Number.isFinite(Date.parse(fixture.authoring.reviewedAt ?? ""))
    || Date.parse(fixture.writeSafety.expiresAt ?? "") <= Date.now()
    || !/^[A-Za-z0-9._:-]{6,128}$/.test(ticket)
  ) {
    throw new Error("primary-success write approval is invalid or expired");
  }
}

function parseArguments(arguments_) {
  let ticket;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--ticket") {
      ticket = arguments_[index += 1];
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!ticket || ticket.startsWith("--")) {
    throw new Error("--ticket is required");
  }
  return { ticket };
}

async function requireAbsent(file, label) {
  try {
    await access(file);
    throw new Error(`${label} already exists: ${relative(file)}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function relative(file) {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
