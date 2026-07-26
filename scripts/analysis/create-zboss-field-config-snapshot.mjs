import path from "node:path";
import { readFile } from "node:fs/promises";
import { captureAssessmentSourceIdentity } from "../../dist/core/assessmentSourceIdentity.js";
import { convertZbossFieldConfigExport } from "../../dist/core/javaFieldConfigExport.js";
import { writeJsonFile } from "../../dist/core/files.js";

const [javaRootValue, inputValue, outputValue] = process.argv.slice(2);
if (!javaRootValue || !inputValue) {
  throw new Error("Usage: node scripts/analysis/create-zboss-field-config-snapshot.mjs <java-root> <zboss-export.json> [output.json]");
}

const javaRoot = path.resolve(javaRootValue);
const input = path.resolve(inputValue);
const output = path.resolve(outputValue
  ?? path.join(process.cwd(), ".migration-guard", "reports", "zboss-field-config-snapshot.json"));
const [source, raw] = await Promise.all([
  captureAssessmentSourceIdentity(javaRoot),
  readFile(input, "utf8").then(JSON.parse)
]);
const conversion = convertZbossFieldConfigExport(raw, source);
await writeJsonFile(output, {
  snapshot: conversion.snapshot,
  classifiedFields: conversion.classifiedFields,
  unclassifiedFields: conversion.unclassifiedFields
});
process.stdout.write(`${JSON.stringify({
  output,
  source: source.identity,
  snapshotHash: conversion.snapshot.snapshotHash,
  fields: conversion.snapshot.fields.length,
  classifiedFields: conversion.classifiedFields,
  unclassifiedFields: conversion.unclassifiedFields.length
})}\n`);
