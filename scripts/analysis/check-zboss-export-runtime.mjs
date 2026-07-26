import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertZbossJavaRuntime,
  requiredJavaReleaseFromMavenPom
} from "../../dist/core/javaFieldConfigExport.js";

const execFileAsync = promisify(execFile);
const [javaRootValue] = process.argv.slice(2);
if (!javaRootValue) {
  throw new Error("Usage: node scripts/analysis/check-zboss-export-runtime.mjs <java-root>");
}
const javaRoot = path.resolve(javaRootValue);
const pom = await readFile(path.join(javaRoot, "pom.xml"), "utf8");
const requiredJdk = requiredJavaReleaseFromMavenPom(pom);
let versionOutput;
try {
  const result = await execFileAsync("java", ["-version"], { maxBuffer: 1024 * 1024 });
  versionOutput = `${result.stdout}\n${result.stderr}`;
} catch (error) {
  const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  if (!output.trim()) {
    throw new Error(`zboss requires JDK ${requiredJdk}, but no active Java runtime was found. Set JAVA_HOME to a JDK ${requiredJdk} installation.`);
  }
  versionOutput = output;
}
try {
  assertZbossJavaRuntime(pom, versionOutput);
} catch (error) {
  if (/Unable to determine the installed Java runtime version/.test(String(error))) {
    throw new Error(`zboss requires JDK ${requiredJdk}, but no active Java runtime was found. Set JAVA_HOME to a JDK ${requiredJdk} installation.`);
  }
  throw error;
}
process.stdout.write(`${JSON.stringify({ javaRoot, requiredJdk, runtimeCompatible: true })}\n`);
