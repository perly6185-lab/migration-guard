import assert from "node:assert/strict";
import test from "node:test";
import { scanArtifactText, scanJsonValue } from "./artifactSecurity.js";

test("artifact scan rejects bearer values even under innocuous keys", () => {
  const findings = scanArtifactText(JSON.stringify({
    header: "Bearer abcdefghijklmnopqrstuvwxyz123456"
  }), "evidence.json");
  assert.ok(findings.some((item) => item.rule === "bearer-token"));
});

test("artifact scan permits explicit redaction placeholders", () => {
  assert.deepEqual(scanJsonValue({
    authorization: "<redacted>",
    authorizationTemplate: "Bearer <token>",
    authorizationEnvironment: "Bearer ${MG_JAVA_TOKEN}",
    token: "",
    cookie: null,
    secrets: {
      policy: "environment-only",
      persistedValuesAllowed: false
    },
    authorizationHeaderBound: true,
    analyzeTokenExternalBinding: true,
    tokenPersisted: false
  }), []);
});

test("artifact scan does not treat an actual bearer token as a placeholder", () => {
  const findings = scanJsonValue({
    authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456"
  });
  assert.ok(findings.some((item) => item.rule === "sensitive-key-value"));
});

test("artifact scan rejects populated sensitive keys and credential URLs", () => {
  const findings = scanArtifactText(JSON.stringify({
    password: "persisted-value",
    endpoint: "mysql://user:password@example.test/db"
  }), "evidence.json");
  assert.ok(findings.some((item) => item.rule === "sensitive-key-value"));
  assert.ok(findings.some((item) => item.rule === "url-credentials"));
});

test("artifact scan rejects secrets in env and configuration assignments", () => {
  assert.ok(scanArtifactText("SERVICE_TOKEN=actual-secret-value", ".env").some((item) =>
    item.rule === "sensitive-config-value"
  ));
  assert.ok(scanArtifactText("password: actual-password", "application.yaml").some((item) =>
    item.rule === "sensitive-config-value"
  ));
  assert.deepEqual(scanArtifactText("SERVICE_TOKEN=${SERVICE_TOKEN}", ".env.example"), []);
});

test("artifact scan does not consume the next env line after an empty secret", () => {
  assert.deepEqual(scanArtifactText([
    "SERVICE_TOKEN=",
    "SERVICE_USER_ID=<runtime>",
    ""
  ].join("\n"), ".env.example"), []);
});
