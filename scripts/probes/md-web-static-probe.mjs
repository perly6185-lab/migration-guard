import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const targetRoot = process.env.MD_TARGET_ROOT || process.cwd();

function read(relativePath) {
  return readFileSync(path.join(targetRoot, relativePath), "utf8");
}

function listFiles(relativeDir) {
  const dir = path.join(targetRoot, relativeDir);
  if (!existsSync(dir)) {
    return [];
  }
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(dir, absolute).replace(/\\/g, "/"));
      }
    }
  }
  return files.sort();
}

function normalizeAssetName(file) {
  return file.replace(/^(.+)-([a-zA-Z0-9_-]{8,})(\.[^.]+)$/u, "$1-<hash>$3");
}

const main = read("apps/web/src/main.ts");
const bootstrap = read("apps/web/src/bootstrap.ts");
const appVue = read("apps/web/src/App.vue");
const viteConfig = read("apps/web/vite.config.ts");
const distIndexPath = path.join(targetRoot, "apps/web/dist/index.html");
const distIndex = existsSync(distIndexPath) ? readFileSync(distIndexPath, "utf8") : "";
const distFiles = listFiles("apps/web/dist");
const normalizedAssets = [...new Set(distFiles
  .filter(file => /\.(?:js|css|html)$/.test(file))
  .map(normalizeAssetName))];

const sourceExpectations = {
  mainBootstrapsApp: /bootstrap\(\)\.catch\(console\.error\)/.test(main),
  bootstrapMountsApp: /app\.mount\(`?#app`?\)/.test(bootstrap),
  appIncludesEditor: appVue.includes("CodemirrorEditor"),
  appIncludesCommandPalette: appVue.includes("CommandPalette"),
  appIncludesConfirmDialog: appVue.includes("ConfirmDialog"),
  appIncludesToaster: appVue.includes("Toaster"),
  viteBaseProtectsMdPath: /const base = .*`\/md\/`/.test(viteConfig)
};

const distExpectations = {
  distExists: distIndex.length > 0,
  hasAppMount: distIndex.includes("id=\"app\""),
  hasModuleScript: /<script[^>]+type="module"/.test(distIndex),
  hasStylesheet: /<link[^>]+stylesheet/.test(distIndex),
  usesMdBase: /(?:src|href)="\/md\//.test(distIndex),
  hasJavaScriptAsset: distFiles.some(file => file.endsWith(".js")),
  hasCssAsset: distFiles.some(file => file.endsWith(".css"))
};

const result = {
  web: {
    sourceExpectations,
    distExpectations,
    distAssetCount: distFiles.length,
    normalizedAssetCount: normalizedAssets.length,
    normalizedAssets
  }
};

console.log(JSON.stringify(result));

const allExpectations = {
  ...sourceExpectations,
  ...distExpectations
};

if (Object.values(allExpectations).some(value => value !== true)) {
  process.exitCode = 1;
}
