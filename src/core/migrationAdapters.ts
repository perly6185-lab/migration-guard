import { analyzeJavaEndpoint, type JavaEndpointAnalysisReport } from "./javaEndpointAnalysis.js";
import {
  resolveMigrationProjectPath,
  type MigrationProjectPackage,
  type MigrationProjectProfile
} from "./migrationProject.js";

export interface MigrationAnalysisOptions {
  maxDepth?: number;
  maxEdges?: number;
  includeTests?: boolean;
}

export interface MigrationSourceAdapter {
  id: string;
  supports(profile: MigrationProjectProfile): boolean;
  analyze(
    pkg: MigrationProjectPackage,
    entrypoint: MigrationProjectProfile["entrypoints"][number],
    options?: MigrationAnalysisOptions
  ): Promise<JavaEndpointAnalysisReport>;
}

const javaSpringAdapter: MigrationSourceAdapter = {
  id: "java-spring",
  supports(profile) {
    return profile.source.language.toLowerCase() === "java"
      && profile.source.framework.toLowerCase() === "spring";
  },
  async analyze(pkg, entrypoint, options) {
    if (entrypoint.kind !== "http-route" || !entrypoint.path || !entrypoint.method) {
      throw new Error(`java-spring currently requires an http-route entrypoint: ${entrypoint.id}.`);
    }
    return analyzeJavaEndpoint({
      root: resolveMigrationProjectPath(pkg, pkg.profile.source.root),
      endpoint: entrypoint.path,
      method: entrypoint.method,
      maxDepth: options?.maxDepth,
      maxEdges: options?.maxEdges,
      includeTests: options?.includeTests
    });
  }
};

const sourceAdapters = new Map<string, MigrationSourceAdapter>([
  [javaSpringAdapter.id, javaSpringAdapter]
]);

export function registerMigrationSourceAdapter(adapter: MigrationSourceAdapter): void {
  if (!adapter.id.trim()) throw new Error("Migration source adapter id is required.");
  if (sourceAdapters.has(adapter.id)) throw new Error(`Migration source adapter already registered: ${adapter.id}.`);
  sourceAdapters.set(adapter.id, adapter);
}

export function getMigrationSourceAdapter(profile: MigrationProjectProfile): MigrationSourceAdapter {
  const adapter = sourceAdapters.get(profile.source.adapter);
  if (!adapter) throw new Error(`Unsupported migration source adapter: ${profile.source.adapter}.`);
  if (!adapter.supports(profile)) {
    throw new Error(`Migration source adapter ${adapter.id} does not support ${profile.source.language}/${profile.source.framework}.`);
  }
  return adapter;
}

export function listMigrationSourceAdapters(): string[] {
  return [...sourceAdapters.keys()].sort();
}
