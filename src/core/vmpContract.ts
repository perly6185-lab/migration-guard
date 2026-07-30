import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";

const REQUIRED_EXPORTS: Record<string, string[]> = {
  "vmpBehavior.ts": ["compareVmpResponses", "VmpCompareReport"],
  "vmpHorizontal.ts": ["buildHorizontalExpectation", "HorizontalExpectation"],
  "vmpQuality.ts": ["compileQualityPlan", "evaluateQualityFilters", "evaluateQualityHorizontal"],
  "vmpRefresh.ts": ["validateRefreshTrace", "executeRefresh", "LeaseLockStore"],
  "vmpReplay.ts": ["checkVmpReadiness", "replayVmpCases", "buildVmpEvidenceBundle"],
  "vmpArtifacts.ts": ["loadVmpFixtureCases", "writeVmpEvidenceEnvelope", "readVmpEvidenceEnvelope"],
  "vmpBatch.ts": ["planBatchUpdate", "BatchChunkLedger", "BatchProgressStateMachine", "BatchRefreshLeaseCoordinator", "gateBatchEvidence"]
};

export interface VmpCodeContractReport {
  passed: boolean;
  files: Array<{ file: string; exports: string[]; missing: string[] }>;
}

/** Statically verify the public VMP contract without executing any target system. */
export async function inspectVmpCodeContract(root: string): Promise<VmpCodeContractReport> {
  const files: VmpCodeContractReport["files"] = [];
  for (const [file, required] of Object.entries(REQUIRED_EXPORTS)) {
    const filePath = path.join(root, "src", "core", file);
    let source: string;
    try {
      source = await fs.readFile(filePath, "utf8");
    } catch {
      files.push({ file, exports: [], missing: required });
      continue;
    }
    const parsed = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const exports = parsed.statements.flatMap((statement) => {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        return statement.name ? [statement.name.text] : [];
      }
      if (ts.isVariableStatement(statement)) return statement.declarationList.declarations
        .flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
      return [];
    }).sort();
    files.push({ file, exports, missing: required.filter((name) => !exports.includes(name)) });
  }
  return { passed: files.every((file) => file.missing.length === 0), files };
}
