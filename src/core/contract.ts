import path from "node:path";
import { sha256 } from "./hash.js";
import { stableStringify } from "./normalize.js";
import { createId } from "./migrationRun.js";
import { readJsonFile, writeJsonFile } from "./files.js";
import type {
  ContractCorpus,
  ContractExchange,
  ContractRequest,
  DualRunDifference,
  DualRunReport,
  LoadedConfig
} from "../types.js";

export interface ContractCaptureOptions {
  source: string;
  name?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export async function captureContract(loaded: LoadedConfig, options: ContractCaptureOptions): Promise<string> {
  const request: ContractRequest = {
    name: options.name ?? "default",
    method: options.method ?? "GET",
    url: options.source,
    headers: options.headers,
    body: options.body
  };
  const exchange = await executeContractRequest(request);
  const corpus: ContractCorpus = {
    version: 1,
    id: createId("contract"),
    createdAt: new Date().toISOString(),
    source: options.source,
    exchanges: [exchange]
  };
  const outputPath = path.join(loaded.artifactsDir, "contracts", `${corpus.id}.json`);
  await writeJsonFile(outputPath, corpus);
  await writeJsonFile(path.join(loaded.artifactsDir, "contracts", "latest.json"), {
    corpusId: corpus.id,
    path: outputPath,
    updatedAt: corpus.createdAt
  });
  return outputPath;
}

export async function runDualRun(
  loaded: LoadedConfig,
  source: string,
  target: string,
  name = "default"
): Promise<string> {
  const sourceRequest: ContractRequest = {
    name,
    method: "GET",
    url: source
  };
  const targetRequest: ContractRequest = {
    name,
    method: "GET",
    url: target
  };
  const sourceExchange = await executeContractRequest(sourceRequest);
  const targetExchange = await executeContractRequest(targetRequest);
  const report = createDualRunReport(source, target, [sourceExchange], [targetExchange]);
  const outputPath = path.join(loaded.artifactsDir, "dual-run", `${report.id}.json`);
  await writeJsonFile(outputPath, report);
  await writeJsonFile(path.join(loaded.artifactsDir, "dual-run", "latest.json"), {
    reportId: report.id,
    path: outputPath,
    updatedAt: report.createdAt
  });
  return outputPath;
}

export async function testContract(
  loaded: LoadedConfig,
  contractPath: string,
  target: string
): Promise<string> {
  const corpus = await readJsonFile<ContractCorpus>(contractPath);
  const targetExchanges: ContractExchange[] = [];

  for (const exchange of corpus.exchanges) {
    const sourceUrl = new URL(exchange.request.url);
    const targetUrl = new URL(target);
    targetUrl.pathname = sourceUrl.pathname;
    targetUrl.search = sourceUrl.search;
    targetExchanges.push(await executeContractRequest({
      ...exchange.request,
      url: targetUrl.toString()
    }));
  }

  const report = createDualRunReport(corpus.source, target, corpus.exchanges, targetExchanges);
  const outputPath = path.join(loaded.artifactsDir, "contract-tests", `${report.id}.json`);
  await writeJsonFile(outputPath, report);
  return outputPath;
}

export async function executeContractRequest(request: ContractRequest): Promise<ContractExchange> {
  const startedAt = Date.now();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    const body = await response.text();
    const normalizedBody = normalizeBody(body);
    return {
      request,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      normalizedBody,
      bodyHash: sha256(normalizedBody),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      request,
      status: null,
      headers: {},
      body: "",
      normalizedBody: "",
      bodyHash: sha256(""),
      durationMs: Date.now() - startedAt,
      error: message
    };
  }
}

function createDualRunReport(
  source: string,
  target: string,
  sourceExchanges: ContractExchange[],
  targetExchanges: ContractExchange[]
): DualRunReport {
  const differences: DualRunDifference[] = [];

  for (let index = 0; index < sourceExchanges.length; index += 1) {
    const before = sourceExchanges[index];
    const after = targetExchanges[index];
    const name = before.request.name;
    if (!after) {
      differences.push({
        name,
        severity: "error",
        message: "Target exchange is missing."
      });
      continue;
    }
    if (before.status !== after.status) {
      differences.push({
        name,
        severity: "error",
        message: "HTTP status changed.",
        source: before.status,
        target: after.status
      });
    }
    if (before.bodyHash !== after.bodyHash) {
      differences.push({
        name,
        severity: "error",
        message: "Response body changed.",
        source: before.normalizedBody,
        target: after.normalizedBody
      });
    }
    if (before.error || after.error) {
      differences.push({
        name,
        severity: "error",
        message: "Request error occurred.",
        source: before.error,
        target: after.error
      });
    }
  }

  return {
    version: 1,
    id: createId("dual-run"),
    createdAt: new Date().toISOString(),
    source,
    target,
    passed: differences.every((difference) => difference.severity !== "error"),
    sourceExchanges,
    targetExchanges,
    differences
  };
}

function normalizeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    return stableStringify(JSON.parse(trimmed));
  } catch {
    return trimmed.replace(/\r\n/g, "\n");
  }
}
