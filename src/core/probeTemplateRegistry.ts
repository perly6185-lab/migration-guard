import type {
  MigrationAction,
  MigrationActionPatchTemplate,
  MigrationActionTemplateSelection,
  ProposalCheckKind
} from "../types.js";

export interface ProbeTemplateSelectionInput {
  id: string;
  domain?: string;
  affectedFiles: string[];
  requiredProbes?: string[];
  explicitTemplate?: MigrationActionPatchTemplate;
}

export interface ProbeTemplateDefinition {
  template: MigrationActionPatchTemplate;
  description: string;
  needsPreview: boolean;
  defaultCheckKind: ProposalCheckKind;
  failureHint: string;
  scriptBuilder: "structural" | "ui-smoke";
  checks: Array<{ name: string; pattern: string }>;
  match(input: ProbeTemplateSelectionInput): string | undefined;
}

const PROBE_TEMPLATE_REGISTRY: ProbeTemplateDefinition[] = [
  {
    template: "ts-structural-probe",
    description: "Inspect TypeScript module and structure signals without requiring a browser preview.",
    needsPreview: false,
    defaultCheckKind: "other",
    failureHint: "Expected import/export plus TypeScript structure signals in the affected TS files.",
    scriptBuilder: "structural",
    checks: [
      { name: "has-typescript-module-signal", pattern: "/\\b(import|export)\\b/" },
      { name: "has-typescript-structure-signal", pattern: "/\\b(interface|type|enum|class|function|const)\\b/" }
    ],
    match: (input) => {
      if (input.domain === "packages/shared" || allFilesStartWith(input.affectedFiles, "packages/shared/")) {
        return "packages/shared actions use TS structural probes instead of UI smoke probes.";
      }
      if (input.id.includes("shared")) {
        return "action id references shared TypeScript contracts.";
      }
      return undefined;
    }
  },
  {
    template: "ui-smoke-probe",
    description: "Run a preview-backed UI smoke probe for web-facing changes.",
    needsPreview: true,
    defaultCheckKind: "ui-probe",
    failureHint: "Expected a reachable preview plus Vue SFC signals for Vue files or TS module signals for UI support files.",
    scriptBuilder: "ui-smoke",
    checks: [
      { name: "has-vue-template-or-ts-module", pattern: "/<template[\\s>]|\\b(import|export)\\b/i" },
      { name: "has-vue-script-or-ts-structure", pattern: "/<script[\\s>]|\\b(interface|type|enum|class|function|const)\\b/i" }
    ],
    match: (input) => {
      if (input.requiredProbes?.includes("md-web-static-contract")) {
        return "task requires md-web-static-contract.";
      }
      if (input.affectedFiles.some((file) => file.replace(/\\/g, "/").startsWith("apps/web/") || file.endsWith(".vue"))) {
        return "affected files include web UI surface.";
      }
      return undefined;
    }
  },
  {
    template: "api-contract-probe",
    description: "Inspect API contract and schema/type export signals.",
    needsPreview: false,
    defaultCheckKind: "contract-probe",
    failureHint: "Expected exported API contract, type, enum, interface, or schema signals.",
    scriptBuilder: "structural",
    checks: [
      { name: "has-export-signal", pattern: "/export\\s+/" },
      { name: "has-type-signal", pattern: "/interface|type|enum|schema/i" }
    ],
    match: (input) => {
      if (input.requiredProbes?.includes("md-api-contract")) {
        return "task requires md-api-contract.";
      }
      if (input.id.includes("api")) {
        return "action id references an API boundary.";
      }
      return undefined;
    }
  },
  {
    template: "renderer-probe",
    description: "Inspect renderer-oriented markdown/render/export signals.",
    needsPreview: false,
    defaultCheckKind: "other",
    failureHint: "Expected renderer, markdown, or exported render implementation signals.",
    scriptBuilder: "structural",
    checks: [
      { name: "has-renderer-signal", pattern: "/render|renderer|markdown|Marked|marked/i" },
      { name: "has-export-signal", pattern: "/export\\s+/" }
    ],
    match: (input) => {
      if (input.requiredProbes?.includes("md-renderer-behavior")) {
        return "task requires md-renderer-behavior.";
      }
      if (input.id.includes("renderer") || input.id.includes("render")) {
        return "action id references renderer behavior.";
      }
      return undefined;
    }
  },
  {
    template: "cross-language-contract-probe",
    description: "Inspect cross-language HTTP route, handler, schema, and response signals.",
    needsPreview: false,
    defaultCheckKind: "contract-probe",
    failureHint: "Expected HTTP route declarations plus handler, schema, or response signals in target files.",
    scriptBuilder: "structural",
    checks: [
      { name: "has-http-route-signal", pattern: "/(@(Get|Post|Put|Patch|Delete|RequestMapping)|\\.(get|post|put|patch|delete|options|head)\\(|http\\.HandleFunc|\\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\\()/i" },
      { name: "has-handler-contract-signal", pattern: "/\\b(return|response|json|schema|interface|class|def|func|handler|controller|express|fastapi|flask|spring|gin|router)\\b/i" }
    ],
    match: (input) => {
      if (input.id.includes("cl") || input.id.includes("cross-language")) {
        return "action id references cross-language migration work.";
      }
      if (input.affectedFiles.some((file) => /\.(py|java|go)$/.test(file))) {
        return "affected files include Python, Java, or Go source.";
      }
      return undefined;
    }
  },
  {
    template: "adapter-fixture-probe",
    description: "Inspect package/workspace fixture signals for adapter-generated migration work.",
    needsPreview: false,
    defaultCheckKind: "other",
    failureHint: "Expected package, workspace, script, or dependency fixture signals.",
    scriptBuilder: "structural",
    checks: [
      { name: "has-package-json", pattern: "/\"scripts\"|\"dependencies\"|\"devDependencies\"/" },
      { name: "has-workspace-or-package-signal", pattern: "/packages:|\"workspaces\"|\"packageManager\"/" }
    ],
    match: (input) => {
      if (input.id.includes("fixture") || input.id.includes("adapter")) {
        return "action id references adapter fixture coverage.";
      }
      return undefined;
    }
  },
  {
    template: "normalization-probe",
    description: "Inspect script/check output normalization fixture signals.",
    needsPreview: false,
    defaultCheckKind: "other",
    failureHint: "Expected script entries for test, build, type-check, or typecheck normalization.",
    scriptBuilder: "structural",
    checks: [
      { name: "has-script-signal", pattern: "/\"scripts\"/" },
      { name: "has-test-or-build-script", pattern: "/\"(test|build|type-check|typecheck)\"/" }
    ],
    match: (input) => {
      if (input.id.includes("normalize")) {
        return "action id references check output normalization.";
      }
      return undefined;
    }
  }
];

export function listProbeTemplates(): readonly ProbeTemplateDefinition[] {
  return PROBE_TEMPLATE_REGISTRY;
}

export function getProbeTemplateDefinition(template: MigrationActionPatchTemplate): ProbeTemplateDefinition {
  const definition = PROBE_TEMPLATE_REGISTRY.find((candidate) => candidate.template === template);
  if (!definition) {
    throw new Error(`Unknown probe template: ${template}`);
  }
  return definition;
}

export function selectProbeTemplate(input: ProbeTemplateSelectionInput): MigrationActionTemplateSelection {
  if (input.explicitTemplate) {
    getProbeTemplateDefinition(input.explicitTemplate);
    return {
      template: input.explicitTemplate,
      reason: `explicit action patchTemplate: ${input.explicitTemplate}`
    };
  }

  for (const definition of PROBE_TEMPLATE_REGISTRY) {
    const reason = definition.match(input);
    if (reason) {
      return {
        template: definition.template,
        reason
      };
    }
  }

  return {
    template: "ui-smoke-probe",
    reason: "fallback template for unclassified action; review before applying to non-UI files"
  };
}

export function selectProbeTemplateForAction(action: MigrationAction): MigrationActionTemplateSelection {
  if (action.templateSelection) {
    getProbeTemplateDefinition(action.templateSelection.template);
    return action.templateSelection;
  }
  return selectProbeTemplate({
    id: action.id,
    affectedFiles: action.affectedFiles,
    explicitTemplate: action.patchTemplate
  });
}

function allFilesStartWith(files: string[], prefix: string): boolean {
  return files.length > 0 && files.every((file) => file.replace(/\\/g, "/").startsWith(prefix));
}
