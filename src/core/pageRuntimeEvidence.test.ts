import assert from "node:assert/strict";
import test from "node:test";
import { gatePageEvidence, type PageEvidenceInput, type PageGateRequirements } from "./pageRuntimeEvidence.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function baseEvidence(): PageEvidenceInput {
  return {
    response: {
      status: 200,
      pageNumber: 1,
      pageSize: 2,
      total: 2,
      returnedRows: 2,
      rowKeys: ["row-1", "row-2"],
      rowsHash: HASH_A,
      orderHash: HASH_B
    }
  };
}

test("page evidence validates pagination without persisting raw rows", () => {
  assert.deepEqual(gatePageEvidence(baseEvidence()), { passed: true, blockers: [] });
  const invalid = baseEvidence();
  invalid.response.returnedRows = 3;
  invalid.response.rowKeys = ["row-1", "row-1"];
  const report = gatePageEvidence(invalid);
  assert.equal(report.passed, false);
  assert.ok(report.blockers.includes("pagination-page-size-exceeded"));
  assert.ok(report.blockers.includes("pagination-returned-rows-exceed-total"));
  assert.ok(report.blockers.includes("pagination-row-key-count-mismatch"));
  assert.ok(report.blockers.includes("pagination-row-keys-duplicate"));
});

test("page evidence fails closed when the response block is malformed", () => {
  const report = gatePageEvidence({} as PageEvidenceInput);
  assert.deepEqual(report, { passed: false, blockers: ["response-missing"] });
});

test("page evidence gates total filter parity and aggregate WHERE/HAVING routing", () => {
  const input = baseEvidence();
  input.query = {
    whereFields: ["status"],
    havingFields: ["sum_amount"],
    aggregateFields: ["sum_amount"],
    dataFilterHash: HASH_A,
    totalFilterHash: HASH_A
  };
  const requirements: PageGateRequirements = {
    requirePagination: true,
    requireTotalFilterParity: true,
    aggregateRouting: { fields: ["sum_amount"], destination: "having" }
  };
  assert.equal(gatePageEvidence(input, requirements).passed, true);
  input.query.whereFields.push("sum_amount");
  input.query.havingFields = [];
  input.query.totalFilterHash = HASH_B;
  const report = gatePageEvidence(input, requirements);
  assert.ok(report.blockers.includes("query-total-filter-mismatch"));
  assert.ok(report.blockers.includes("query-aggregate-route-missing:sum_amount:having"));
  assert.ok(report.blockers.includes("query-aggregate-route-conflict:sum_amount"));
});

test("page evidence gates horizontal keys, refresh ordering and owner identity", () => {
  const input = baseEvidence();
  input.horizontal = {
    pageKeys: ["row-1", "row-2"],
    cellRowKeys: ["row-1", "row-2", "row-2"],
    distinctTotal: 2,
    pivotKeys: ["north", "south"]
  };
  input.refresh = {
    mode: "manual",
    syncSucceeded: true,
    querySucceeded: true,
    effects: ["sync", "timestamp", "undo-clear", "query", "terminal-event", "unlock"],
    terminalEvent: "completed",
    lock: {
      resource: "panel:1",
      ownerFingerprint: HASH_A,
      releaseOwnerFingerprint: HASH_A,
      acquired: true,
      released: true
    }
  };
  const requirements: PageGateRequirements = {
    requirePagination: true,
    requireHorizontalConsistency: true,
    requireRefreshTrace: true,
    requireRefreshTerminal: true,
    requireRefreshLock: true
  };
  assert.equal(gatePageEvidence(input, requirements).passed, true);
  input.horizontal.cellRowKeys.push("row-3");
  input.refresh.lock!.releaseOwnerFingerprint = HASH_B;
  input.refresh.effects = ["sync", "unlock", "query", "terminal-event"];
  const report = gatePageEvidence(input, requirements);
  assert.ok(report.blockers.includes("horizontal-cell-outside-page"));
  assert.ok(report.blockers.includes("refresh-effect-order-invalid"));
  assert.ok(report.blockers.includes("refresh-lock-owner-mismatch"));
  assert.ok(report.blockers.includes("refresh-unlock-not-last"));
});
