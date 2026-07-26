import test from "node:test";
import assert from "node:assert/strict";
import {
  assertZbossJavaRuntime,
  convertZbossFieldConfigExport,
  javaRuntimeMajor,
  renderZbossFieldConfigExportSql,
  requiredJavaReleaseFromMavenPom
} from "./javaFieldConfigExport.js";

const source = {
  revision: "a".repeat(40),
  dirty: false,
  dirtyFingerprint: "0".repeat(64),
  identity: "a".repeat(40)
};

test("zboss field exports preserve authoritative formatter classifications", () => {
  const result = convertZbossFieldConfigExport({
    version: 1,
    tenantId: 7,
    panelIds: [10],
    fields: [
      {
        id: 1,
        panelId: 10,
        field: "amount",
        fieldTagInnerKey: "selectRef",
        fieldFormatTag: "numberPercentage",
        unionFieldTag: "number",
        relationFieldIds: [8, 9],
        isPercentageData: true,
        isDateData: false,
        isMonthData: false,
        isDateTimeData: false
      },
      {
        id: 2,
        panelId: 10,
        field: "legacy",
        fieldTagInnerKey: "text"
      }
    ]
  }, source);
  assert.equal(result.classifiedFields, 1);
  assert.deepEqual(result.snapshot.fields[0].formatterKinds, ["percentage"]);
  assert.equal(result.snapshot.fields[1].formatterKinds, undefined);
  assert.deepEqual(result.unclassifiedFields, [{
    fieldId: "2",
    panelId: "10",
    alias: "legacy",
    reason: "zboss-formatter-classification-incomplete"
  }]);
});

test("zboss export conversion rejects out-of-scope fields and documents source tables", () => {
  assert.throws(() => convertZbossFieldConfigExport({
    version: 1,
    tenantId: "7",
    panelIds: ["10"],
    fields: [{ id: "1", panelId: "20", field: "name" }]
  }, source), /out-of-scope/);
  const sql = renderZbossFieldConfigExportSql();
  assert.match(sql, /boss_view_dynamic_field_data/);
  assert.match(sql, /boss_view_dynamic_field_union_data/);
  assert.match(sql, /tenant_id = :tenantId/);
});

test("zboss export runtime preflight follows the Maven JDK release", () => {
  const pom = [
    "<properties>",
    "  <java.version>25</java.version>",
    "  <maven.compiler.release>${java.version}</maven.compiler.release>",
    "</properties>"
  ].join("\n");
  assert.equal(requiredJavaReleaseFromMavenPom(pom), 25);
  assert.equal(javaRuntimeMajor('openjdk version "25.0.1" 2025-10-21'), 25);
  assert.equal(assertZbossJavaRuntime(pom, 'java 25.0.1 2025-10-21 LTS'), 25);
  assert.throws(() => assertZbossJavaRuntime(pom, 'openjdk version "17.0.12"'), /requires JDK 25/);
});
