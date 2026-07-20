import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { LoadHook, ResolveHook } from "node:module";
import ts from "typescript";

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const fallback = context.parentURL ? await resolveTypeScriptFallback(specifier, context.parentURL) : undefined;
    if (fallback) return { url: fallback, shortCircuit: true };
    throw error;
  }
};

export const load: LoadHook = async (url, context, nextLoad) => {
  const extension = fileExtension(url);
  if (!extension || ![".ts", ".tsx", ".mts", ".cts"].includes(extension)) {
    return await nextLoad(url, context);
  }
  const source = await readFile(fileURLToPath(url), "utf8");
  const commonJs = extension === ".cts";
  const transpiled = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: commonJs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      experimentalDecorators: true,
      inlineSourceMap: true,
      inlineSources: true
    }
  });
  return {
    format: commonJs ? "commonjs" : "module",
    source: transpiled.outputText,
    shortCircuit: true
  };
};

async function resolveTypeScriptFallback(specifier: string, parentURL: string): Promise<string | undefined> {
  if (!specifier.startsWith(".") || !/\.(?:mjs|cjs|js)$/.test(specifier)) return undefined;
  const replacements = specifier.endsWith(".mjs")
    ? [specifier.replace(/\.mjs$/, ".mts")]
    : specifier.endsWith(".cjs")
      ? [specifier.replace(/\.cjs$/, ".cts")]
      : [specifier.replace(/\.js$/, ".ts"), specifier.replace(/\.js$/, ".tsx")];
  for (const replacement of replacements) {
    const candidate = new URL(replacement, parentURL);
    if (candidate.protocol !== "file:") continue;
    if (await access(fileURLToPath(candidate)).then(() => true, () => false)) return candidate.href;
  }
  return undefined;
}

function fileExtension(url: string): string | undefined {
  const match = new URL(url).pathname.match(/\.(?:cts|mts|tsx?)$/);
  return match?.[0];
}
