import path from "node:path";
import { readFile } from "node:fs/promises";
import { createJavaEndpointAnalyzer } from "../../dist/core/javaEndpointAnalysis.js";
import { writeJsonFile, writeTextFile } from "../../dist/core/files.js";
import { sha256 } from "../../dist/core/hash.js";
import { stableStringify } from "../../dist/core/normalize.js";
import {
  canReuseControllerShadowCheckpoint,
  controllerShadowSource
} from "./controller-symbolic-shadow-state.mjs";

const [rootValue, outputDirValue, modeValue] = process.argv.slice(2);
if (!rootValue) {
  throw new Error("Usage: node scripts/analysis/run-controller-symbolic-shadow.mjs <java-root> [output-dir]");
}

const root = path.resolve(rootValue);
const outputDir = path.resolve(outputDirValue ?? path.join(process.cwd(), ".migration-guard", "reports"));
const jsonPath = path.join(outputDir, "controller-symbolic-shadow.json");
const markdownPath = path.join(outputDir, "controller-symbolic-shadow.md");
const checkpointPath = path.join(outputDir, "controller-symbolic-shadow.checkpoint.json");
const analyzer = await createJavaEndpointAnalyzer(root);
const routesByKey = new Map();
for (const route of analyzer.routes.filter((candidate) => /Controller$/.test(candidate.className))) {
  const key = `${route.method} ${route.path}`;
  if (!routesByKey.has(key)) routesByKey.set(key, route);
}
const routes = [...routesByKey.values()].sort((a, b) =>
  a.method.localeCompare(b.method) || a.path.localeCompare(b.path) || a.className.localeCompare(b.className)
);
const source = controllerShadowSource(root, routes.length, analyzer.sourceIdentity);
let results = [];
try {
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  if (canReuseControllerShadowCheckpoint(checkpoint, source, routes.length)) {
    results = checkpoint.results.map((item) => {
      const differences = {
        ...item.differences,
        methodsMissingFromSymbolic: item.differences.methodsMissingFromSymbolic
          .filter((value) => !value.startsWith("external:")),
        edgesMissingFromSymbolic: item.differences.edgesMissingFromSymbolic
          .filter((value) => !value.includes("->external:"))
      };
      const missingCount = differences.methodsMissingFromSymbolic.length
        + differences.edgesMissingFromSymbolic.length
        + differences.boundariesMissingFromSymbolic.length;
      const hasDifferences = Object.values(differences).some((values) => values.length > 0);
      return {
        maxSymbolicStates: 5000,
        ...item,
        differences,
        missingCount,
        verdict: item.verdict === "inconclusive" ? "inconclusive" : hasDifferences ? "different" : "aligned"
      };
    });
  }
} catch {
  // A missing or invalid checkpoint starts a fresh batch.
}
const startedAt = Date.now();
if (modeValue === "--recheck-priority"
  || modeValue === "--recheck-symbolic-incomplete"
  || modeValue === "--recheck-legacy-truncated"
  || modeValue === "--recheck-empty-frontier") {
  for (const [resultIndex, previous] of results.entries()) {
    const selected = modeValue === "--recheck-priority"
      ? previous.missingCount > 0 && previous.verdict !== "inconclusive"
      : modeValue === "--recheck-symbolic-incomplete"
        ? previous.symbolicComplete === false && !previous.error
        : modeValue === "--recheck-empty-frontier"
          ? previous.legacyTruncated && !previous.error && (previous.legacyFrontierMethodIds?.length ?? 0) === 0
          : previous.legacyTruncated && !previous.error;
    if (!selected) continue;
    const route = routes.find((candidate) => `${candidate.method} ${candidate.path}` === previous.route);
    if (!route) continue;
    if (modeValue === "--recheck-legacy-truncated" || modeValue === "--recheck-empty-frontier") {
      const legacy = analyzer.analyzeRouteLegacyTruncation({
        endpoint: route.path,
        method: route.method,
        maxDepth: 16,
        maxEdges: 5000
      });
      results[resultIndex] = {
        ...previous,
        legacyTruncated: legacy.truncated,
        legacyTruncationReasons: legacy.reasons,
        legacyFrontierMethodIds: legacy.frontierMethodIds,
        legacyFrontierUpstreamEdges: legacy.frontierUpstreamEdges,
        legacyMethods: legacy.nodeCount
      };
      process.stdout.write(`${JSON.stringify({
        rechecked: resultIndex + 1,
        route: previous.route,
        frontiers: legacy.frontierMethodIds.length,
        upstreamEdges: legacy.frontierUpstreamEdges.length
      })}\n`);
      await writeJsonFile(checkpointPath, {
        version: 2,
        source,
        completed: results.length,
        total: routes.length,
        results
      });
      continue;
    }
    const report = analyzer.analyzeRouteSymbolicShadow({
      endpoint: route.path,
      method: route.method,
      maxDepth: 16,
      maxEdges: 5000,
      maxSymbolicStates: 5000
    });
    const missingCount = report.differences.methodsMissingFromSymbolic.length
      + report.differences.edgesMissingFromSymbolic.length
      + report.differences.boundariesMissingFromSymbolic.length;
    results[resultIndex] = {
      ...previous,
      verdict: report.verdict,
      legacyTruncated: report.legacy.truncated,
      legacyTruncationReasons: report.legacy.truncationReasons,
      legacyFrontierMethodIds: report.legacy.frontierMethodIds,
      legacyFrontierUpstreamEdges: report.legacy.frontierUpstreamEdges,
      legacyMethods: report.legacy.methodIds.length,
      symbolicMethods: report.symbolic.methodIds.length,
      symbolicComplete: report.symbolic.complete,
      maxSymbolicStates: 5000,
      unknownEdges: report.symbolic.unknownEdges,
      missingCount,
      differences: report.differences,
      diagnostics: report.symbolic.diagnostics,
      reportHash: report.reportHash,
      elapsedMs: Date.now() - startedAt
    };
  }
  await writeJsonFile(checkpointPath, {
    version: 2,
    source,
    completed: results.length,
    total: routes.length,
    results
  });
}
for (let index = results.length; index < routes.length; index += 1) {
  const route = routes[index];
  const routeStartedAt = Date.now();
  const longTailRoute = route.path.includes("/typed-update/");
  try {
    const report = analyzer.analyzeRouteSymbolicShadow({
      endpoint: route.path,
      method: route.method,
      maxDepth: 16,
      maxEdges: 5000,
      maxSymbolicStates: 1000
    });
    const missingCount = report.differences.methodsMissingFromSymbolic.length
      + report.differences.edgesMissingFromSymbolic.length
      + report.differences.boundariesMissingFromSymbolic.length;
    results.push({
      route: `${route.method} ${route.path}`,
      handler: `${route.className}.${route.methodName}`,
      file: route.file,
      line: route.line,
      verdict: report.verdict,
      legacyTruncated: report.legacy.truncated,
      legacyTruncationReasons: report.legacy.truncationReasons,
      legacyFrontierMethodIds: report.legacy.frontierMethodIds,
      legacyFrontierUpstreamEdges: report.legacy.frontierUpstreamEdges,
      legacyMethods: report.legacy.methodIds.length,
      symbolicMethods: report.symbolic.methodIds.length,
      symbolicComplete: report.symbolic.complete,
      maxSymbolicStates: 1000,
      analysisProfile: longTailRoute ? "bounded-long-tail" : "standard",
      unknownEdges: report.symbolic.unknownEdges,
      missingCount,
      differences: report.differences,
      diagnostics: report.symbolic.diagnostics,
      reportHash: report.reportHash,
      elapsedMs: Date.now() - routeStartedAt
    });
  } catch (error) {
    results.push({
      route: `${route.method} ${route.path}`,
      handler: `${route.className}.${route.methodName}`,
      file: route.file,
      line: route.line,
      verdict: "inconclusive",
      legacyTruncated: false,
      legacyTruncationReasons: [],
      legacyFrontierMethodIds: [],
      legacyFrontierUpstreamEdges: [],
      legacyMethods: 0,
      symbolicMethods: 0,
      symbolicComplete: false,
      maxSymbolicStates: 1000,
      analysisProfile: longTailRoute ? "bounded-long-tail" : "standard",
      unknownEdges: 0,
      missingCount: 0,
      differences: {
        methodsMissingFromSymbolic: [],
        methodsOnlyInSymbolic: [],
        edgesMissingFromSymbolic: [],
        edgesOnlyInSymbolic: [],
        boundariesMissingFromSymbolic: [],
        boundariesOnlyInSymbolic: []
      },
      diagnostics: [],
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - routeStartedAt
    });
  }
  if (longTailRoute || (index + 1) % 25 === 0 || index + 1 === routes.length) {
    const counts = Object.fromEntries(["aligned", "different", "inconclusive"].map((verdict) => [
      verdict,
      results.filter((item) => item.verdict === verdict).length
    ]));
    process.stdout.write(`${JSON.stringify({
      completed: index + 1,
      total: routes.length,
      elapsedMs: Date.now() - startedAt,
      counts
    })}\n`);
    await writeJsonFile(checkpointPath, {
      version: 2,
      source,
      completed: index + 1,
      total: routes.length,
      results
    });
  }
}

const counts = Object.fromEntries(["aligned", "different", "inconclusive"].map((verdict) => [
  verdict,
  results.filter((item) => item.verdict === verdict).length
]));
const priorityMissing = results
  .filter((item) => item.verdict === "different" && !item.legacyTruncated && item.missingCount > 0)
  .sort((a, b) => b.missingCount - a.missingCount || a.route.localeCompare(b.route));
const slowest = [...results].sort((a, b) => b.elapsedMs - a.elapsedMs || a.route.localeCompare(b.route)).slice(0, 25);
const clusterBy = (valuesOf) => {
  const routesByValue = new Map();
  for (const result of results.filter((item) => item.legacyTruncated)) {
    for (const value of valuesOf(result)) {
      const routesForValue = routesByValue.get(value) ?? new Set();
      routesForValue.add(result.route);
      routesByValue.set(value, routesForValue);
    }
  }
  return [...routesByValue]
    .map(([value, routeSet]) => ({ value, routes: [...routeSet].sort(), routeCount: routeSet.size }))
    .sort((a, b) => b.routeCount - a.routeCount || a.value.localeCompare(b.value));
};
const legacyFrontierClusters = clusterBy((result) => result.legacyFrontierMethodIds ?? []);
const legacyUpstreamChainClusters = clusterBy((result) => result.legacyFrontierUpstreamEdges ?? []);
const stablePayload = {
  version: 2,
  source,
  options: {
    maxDepth: 16,
    maxEdges: 5000,
    symbolicStateBudgets: Object.entries(Object.fromEntries(
      [...new Set(results.map((item) => item.maxSymbolicStates))].sort((a, b) => a - b)
        .map((budget) => [String(budget), results.filter((item) => item.maxSymbolicStates === budget).length])
    )).map(([maxStates, routesAtBudget]) => ({ maxStates: Number(maxStates), routes: routesAtBudget })),
    routeScope: "unique-controller-method-path"
  },
  counts,
  legacyFrontierClusters,
  legacyUpstreamChainClusters,
  priorityMissing,
  slowest,
  routes: results
};
const withoutTiming = ({ elapsedMs, ...value }) => value;
const hashPayload = {
  version: stablePayload.version,
  source: stablePayload.source,
  options: stablePayload.options,
  counts: stablePayload.counts,
  legacyFrontierClusters,
  legacyUpstreamChainClusters,
  priorityMissing: priorityMissing.map(withoutTiming),
  routes: results.map(withoutTiming)
};
const reportHash = sha256(stableStringify(hashPayload));
const report = {
  ...stablePayload,
  generatedAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAt,
  reportHash
};
await writeJsonFile(jsonPath, report);
await writeTextFile(markdownPath, [
  "# Controller Symbolic Shadow",
  "",
  `- Routes: ${routes.length}`,
  `- Aligned: ${counts.aligned}`,
  `- Different: ${counts.different}`,
  `- Inconclusive: ${counts.inconclusive}`,
  `- Complete legacy routes with symbolic omissions: ${priorityMissing.length}`,
  `- Legacy frontier clusters: ${legacyFrontierClusters.length}`,
  `- Stable report hash: ${reportHash}`,
  "",
  "## Priority Missing",
  "",
  ...(priorityMissing.length > 0
    ? priorityMissing.map((item) =>
      `- ${item.route} -> ${item.handler}: missing=${item.missingCount}, methods=${item.differences.methodsMissingFromSymbolic.length}, edges=${item.differences.edgesMissingFromSymbolic.length}, boundaries=${item.differences.boundariesMissingFromSymbolic.length}`
    )
    : ["- none"]),
  "",
  "## Legacy Truncation Frontier Clusters",
  "",
  ...(legacyFrontierClusters.length > 0
    ? legacyFrontierClusters.slice(0, 25).map((item) =>
      `- routes=${item.routeCount}: ${item.value}`
    )
    : ["- none"]),
  "",
  "## Legacy Upstream Chain Clusters",
  "",
  ...(legacyUpstreamChainClusters.length > 0
    ? legacyUpstreamChainClusters.slice(0, 25).map((item) =>
      `- routes=${item.routeCount}: ${item.value}`
    )
    : ["- none"])
].join("\n"));
process.stdout.write(`${JSON.stringify({ complete: true, jsonPath, markdownPath, counts, priorityMissing: priorityMissing.length, reportHash })}\n`);
