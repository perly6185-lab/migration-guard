import path from "node:path";
import { createJavaEndpointAnalyzer } from "../../dist/core/javaEndpointAnalysis.js";
import { writeJsonFile } from "../../dist/core/files.js";
import { sha256 } from "../../dist/core/hash.js";
import { stableStringify } from "../../dist/core/normalize.js";

const [javaRootValue, outputValue] = process.argv.slice(2);
if (!javaRootValue) {
  throw new Error("Usage: node scripts/analysis/list-tran-obj-projection-sites.mjs <java-root> [output.json]");
}

const javaRoot = path.resolve(javaRootValue);
const output = path.resolve(outputValue
  ?? path.join(process.cwd(), ".migration-guard", "reports", "tran-obj-projection-sites.json"));
const analyzer = await createJavaEndpointAnalyzer(javaRoot);
const sites = [];
for (const method of analyzer.serviceMethods) {
  const summary = analyzer.summarizeMethod(method);
  for (const call of summary.calls.filter((candidate) => candidate.method === "tranObjList")) {
    const targets = call.targets.filter((target) =>
      target.qualifiedClassName.endsWith(".EngineTranObjectValueServiceImpl"));
    if (targets.length === 0) continue;
    const aliases = literalProjectionAliases(call.expression);
    sites.push({
      callId: call.id,
      callerMethodId: summary.methodId,
      file: summary.file,
      line: call.line,
      expression: call.expression,
      targetMethodIds: targets.map((target) => target.methodId).sort(),
      selectedAliases: aliases,
      status: aliases.length > 0 ? "literal-projection" : "unknown",
      reason: aliases.length > 0 ? undefined : "projection-built-from-runtime-select-lists"
    });
  }
}
sites.sort((a, b) =>
  a.file.localeCompare(b.file) || a.line - b.line || a.callId.localeCompare(b.callId));
const core = {
  version: 1,
  javaRoot,
  source: analyzer.sourceIdentity,
  sites,
  counts: {
    total: sites.length,
    literalProjection: sites.filter((site) => site.status === "literal-projection").length,
    unknown: sites.filter((site) => site.status === "unknown").length
  }
};
const report = { ...core, reportHash: sha256(stableStringify(core)) };
await writeJsonFile(output, report);
process.stdout.write(`${JSON.stringify({ output, ...report.counts, reportHash: report.reportHash })}\n`);

function literalProjectionAliases(expression) {
  const aliases = [];
  for (const match of expression.matchAll(/setFieldAlias\s*\(\s*"([^"]+)"\s*\)/g)) aliases.push(match[1]);
  return [...new Set(aliases)].sort();
}
