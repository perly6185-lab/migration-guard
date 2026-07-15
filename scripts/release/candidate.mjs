import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  readJson,
  releaseRunDir,
  sha256File,
  writeJsonAtomic,
  writeTextAtomic
} from "./evidence.mjs";

const workspace = process.cwd();
const releaseRunId = process.env.MG_RELEASE_RUN_ID;
assert.ok(releaseRunId, "MG_RELEASE_RUN_ID is required; run this through release:gate");
const pkg = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8"));
assert.match(pkg.version, /^(?:0\.2\.0|0\.3\.0-beta\.1)$/, "candidate must use a supported release version");

const packed = JSON.parse(await run("npm", ["pack", "--json", "--ignore-scripts"]))[0];
assert.ok(packed?.filename, "npm pack returned no tarball");
const tarballPath = path.join(workspace, packed.filename);
try {
  const runDir = releaseRunDir(workspace, releaseRunId);
  const manifestPath = path.join(runDir, "ga-candidate.json");
  const handoffPath = path.join(runDir, "PUBLISH_HANDOFF.md");
  const evidence = await readJson(path.join(runDir, "release-evidence.json"));
  const candidate = {
    version: 1,
    releaseRunId,
    packageVersion: pkg.version,
    gitCommit: evidence.context?.git?.commit,
    gitDirty: evidence.context?.git?.dirty,
    createdAt: new Date().toISOString(),
    tarball: {
      filename: packed.filename,
      sha256: await sha256File(tarballPath),
      size: packed.size,
      unpackedSize: packed.unpackedSize,
      entryCount: packed.entryCount,
      files: packed.files.map((file) => ({ path: file.path, size: file.size }))
    }
  };
  assert.equal(candidate.gitDirty, false, "release candidate evidence must be bound to a clean commit");
  await writeJsonAtomic(manifestPath, candidate);
  await writeTextAtomic(handoffPath, renderHandoff(candidate));
  console.log(`Release candidate recorded: ${path.relative(workspace, manifestPath)}`);
  console.log(`tarball sha256: ${candidate.tarball.sha256}`);
} finally {
  await rm(tarballPath, { force: true });
}

function renderHandoff(candidate) {
  const tag = `v${candidate.packageVersion}`;
  return [
    `# Migration Guard ${candidate.packageVersion} Publish Handoff`,
    "",
    `Release run: \`${candidate.releaseRunId}\``,
    `Commit: \`${candidate.gitCommit}\``,
    `Tarball: \`${candidate.tarball.filename}\``,
    `SHA-256: \`${candidate.tarball.sha256}\``,
    "",
    "## Reviewed Commands",
    "",
    "Recreate the tarball from the bound clean commit and verify its SHA-256 before continuing.",
    "",
    "```sh",
    "npm pack --ignore-scripts",
    `npm publish ${candidate.tarball.filename}`,
    `git tag -a ${tag} -m \"migration-guard ${candidate.packageVersion}\"`,
    `git push origin ${tag}`,
    "```",
    "",
    "Create the GitHub Release manually from the pushed tag and attach the release evidence summary.",
    "",
    "## Rollback",
    "",
    `Do not overwrite an npm version. For a broken fresh release, deprecate migration-guard@${candidate.packageVersion}, document impact, and publish a new version. Delete an unpushed local tag with \`git tag -d ${tag}\`; coordinate before changing any pushed tag or GitHub Release.`,
    ""
  ].join("\n");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace, shell: process.platform === "win32", windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} failed with ${code}\n${stderr}`)));
  });
}
