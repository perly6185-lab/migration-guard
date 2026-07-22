import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAssessmentGitStatus } from "./assessmentSourceIdentity.js";

test("assessment source identity excludes generated artifacts and normalizes status ordering", () => {
  const before = " M pom.xml\r\n?? docs/note.md\r\n";
  const after = "?? zboss-module-data/.migration-guard/mg-205/report.json\n?? docs/note.md\n M pom.xml\n";
  assert.equal(normalizeAssessmentGitStatus(after), normalizeAssessmentGitStatus(before));
});
