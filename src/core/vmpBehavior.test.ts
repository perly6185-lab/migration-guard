import assert from "node:assert/strict";
import test from "node:test";
import { compareVmpResponses } from "./vmpBehavior.js";

test("VMP comparator ignores configured volatile fields but preserves pagination semantics", () => {
  const baseline = { status: 200, headers: { "Content-Type": "application/json" }, body: {
    pageNo: 1, pageSize: 2, total: 3, requestId: "old", data: [{ id: 1 }, { id: 2 }]
  }};
  const current = { status: 200, headers: { "content-type": "application/json" }, body: {
    pageNo: 1, pageSize: 2, total: 3, requestId: "new", data: [{ id: 1 }, { id: 2 }]
  }};
  const report = compareVmpResponses("standard-page", baseline, current);
  assert.equal(report.passed, true);
  assert.equal(report.baselineFingerprint, report.currentFingerprint);
});

test("VMP comparator reports total and row drift separately", () => {
  const baseline = { status: 200, body: { pageNo: 1, pageSize: 2, total: 4, data: [{ id: 1 }, { id: 2 }] } };
  const current = { status: 200, body: { pageNo: 1, pageSize: 2, total: 5, data: [{ id: 1 }, { id: 9 }] } };
  const report = compareVmpResponses("horizontal-table", baseline, current);
  assert.equal(report.passed, false);
  assert.deepEqual(report.differences.map((item) => item.kind), ["pagination", "row"]);
});

test("VMP comparator can compare unordered rows while still checking status", () => {
  const baseline = { status: 200, body: { data: [{ id: 1 }, { id: 2 }] } };
  const current = { status: 200, body: { data: [{ id: 2 }, { id: 1 }] } };
  const unordered = compareVmpResponses("quality-filter", baseline, current, { preserveRowOrder: false });
  assert.equal(unordered.passed, true);
  assert.equal(unordered.baselineFingerprint, unordered.currentFingerprint);
  assert.equal(compareVmpResponses("quality-filter", baseline, { ...current, status: 500 }, { preserveRowOrder: false }).passed, false);
});

test("VMP comparator records expected-status failures as concrete differences", () => {
  const report = compareVmpResponses(
    "tenant-permission",
    { status: 200, body: {} },
    { status: 200, body: {} },
    { expectedStatus: 403 }
  );
  assert.equal(report.passed, false);
  assert.deepEqual(report.differences.map((difference) => difference.path), ["$.baseline.status", "$.current.status"]);
});
