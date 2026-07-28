import assert from "node:assert/strict";
import test from "node:test";
import { compileQualityPlan, evaluateQualityFilters, evaluateQualityHorizontal } from "./vmpQuality.js";

const fields = [
  { key: "name", column: "name_col" },
  { key: "amount", column: "amount_col", aggregate: "sum" as const },
  { key: "score", column: "score_col", aggregate: "avg" as const }
];

test("quality plan sends ordinary fields to WHERE and aggregate fields to HAVING", () => {
  const plan = compileQualityPlan(fields, [
    { field: "name", operator: "isNotNull" },
    { field: "amount", operator: "gt", value: 100 },
    { field: "score", operator: "isNull" }
  ]);
  assert.deepEqual(plan.where.map((clause) => clause.expression), ["name_col IS NOT NULL"]);
  assert.deepEqual(plan.having.map((clause) => clause.expression), ["SUM(amount_col) > :q1", "AVG(score_col) IS NULL"]);
  assert.deepEqual(plan.having[0].parameters, { q1: 100 });
});

test("quality IN filters remain parameterized", () => {
  const plan = compileQualityPlan(fields, [{ field: "name", operator: "in", value: ["A", "B"] }]);
  assert.equal(plan.where[0].expression, "name_col IN (:q0_0, :q0_1)");
  assert.deepEqual(plan.where[0].parameters, { q0_0: "A", q0_1: "B" });
});

test("quality plan rejects unknown fields and raw operator injection", () => {
  assert.throws(() => compileQualityPlan(fields, [{ field: "name_col OR 1=1", operator: "eq", value: "x" }]), /Unknown quality field/);
  assert.throws(() => compileQualityPlan(fields, [{ field: "name", operator: "eq; DROP TABLE" as never, value: "x" }]), /Unsupported quality operator/);
  assert.throws(() => compileQualityPlan(fields, [{ field: "name", operator: "in", value: [] }]), /non-empty array/);
  assert.throws(() => compileQualityPlan([{ key: "name", column: "name_col; DROP TABLE t" }], []), /Unsafe quality column/);
  assert.throws(() => compileQualityPlan(fields, [{ field: "name", operator: "eq" }]), /non-null value/);
  assert.throws(() => compileQualityPlan(fields, [{ field: "name", operator: "in", value: ["A", null] }]), /must not contain null/);
});

test("null operators do not bind marker values", () => {
  const plan = compileQualityPlan(fields, [{ field: "name", operator: "isNull" }]);
  assert.deepEqual(plan.where[0].parameters, {});
});

test("quality evaluation applies WHERE before aggregate HAVING and changes surviving total", () => {
  const cells = [
    { region: "East", status: "active", amount: 60 },
    { region: "East", status: "inactive", amount: 60 },
    { region: "West", status: "active", amount: 40 }
  ];
  const result = evaluateQualityFilters(
    cells,
    [{ key: "status", column: "status" }, { key: "amount", column: "amount", aggregate: "sum" }],
    [
      { field: "status", operator: "eq", value: "active" },
      { field: "amount", operator: "gt", value: 50 }
    ],
    ["region"]
  );
  assert.equal(result.whereCells.length, 2);
  assert.deepEqual(result.havingCells, [{ region: "East", status: "active", amount: 60 }]);
  assert.deepEqual(result.survivingBusinessKeys, [{ region: "East" }]);
  assert.equal(result.distinctTotal, 1);
});

test("HAVING null semantics evaluate aggregate absence without inventing a value", () => {
  const result = evaluateQualityFilters(
    [{ region: "East", amount: null }],
    [{ key: "amount", column: "amount", aggregate: "sum" }],
    [{ field: "amount", operator: "isNull" }],
    ["region"]
  );
  assert.deepEqual(result.survivingBusinessKeys, [{ region: "East" }]);
});

test("ordinary evaluator fields use metadata columns instead of public keys", () => {
  const result = evaluateQualityFilters(
    [{ region: "East", status_col: "active" }, { region: "West", status_col: "inactive" }],
    [{ key: "status", column: "status_col" }],
    [{ field: "status", operator: "eq", value: "active" }],
    ["region"]
  );
  assert.deepEqual(result.survivingBusinessKeys, [{ region: "East" }]);
});

test("COUNT follows SQL COUNT(column) for non-null non-numeric values", () => {
  const result = evaluateQualityFilters(
    [{ region: "East", tag: "x" }, { region: "East", tag: null }],
    [{ key: "tagCount", column: "tag", aggregate: "count" }],
    [{ field: "tagCount", operator: "eq", value: 1 }],
    ["region"]
  );
  assert.equal(result.distinctTotal, 1);
});

test("empty filters preserve the distinct business-key total", () => {
  const result = evaluateQualityFilters(
    [{ region: "East" }, { region: "East" }, { region: "West" }],
    [],
    [],
    ["region"]
  );
  assert.equal(result.distinctTotal, 2);
});

test("evaluator rejects unknown fields instead of silently treating them as WHERE", () => {
  assert.throws(
    () => evaluateQualityFilters([{ region: "East" }], [], [{ field: "missing", operator: "eq", value: 1 }], ["region"]),
    /Unknown quality field/
  );
});

test("HAVING survivors feed horizontal pagination with the same distinct total", () => {
  const result = evaluateQualityHorizontal(
    [
      { region: "East", month: "Jan", amount: 60 },
      { region: "East", month: "Feb", amount: 50 },
      { region: "West", month: "Jan", amount: 40 }
    ],
    [{ key: "amount", column: "amount", aggregate: "sum" }],
    [{ field: "amount", operator: "gt", value: 100 }],
    {
      businessKeyFields: ["region"],
      dimensionField: "month",
      pageNo: 1,
      pageSize: 10,
      measures: [{ name: "amount", field: "amount", aggregate: "sum" }]
    }
  );
  assert.equal(result.quality.distinctTotal, 1);
  assert.equal(result.horizontal.total, 1);
  assert.deepEqual(result.horizontal.pageBusinessKeys, [{ region: "East" }]);
});
