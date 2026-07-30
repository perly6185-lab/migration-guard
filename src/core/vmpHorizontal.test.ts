import assert from "node:assert/strict";
import test from "node:test";
import { buildHorizontalExpectation } from "./vmpHorizontal.js";

const cells = [
  { region: "East", product: "A", month: "Jan", amount: 10 },
  { region: "East", product: "A", month: "Feb", amount: 20 },
  { region: "West", product: "B", month: "Jan", amount: 30 },
  { region: "North", product: "C", month: "Jan", amount: 40 }
];

test("horizontal pagination counts distinct business keys and keeps all page cells", () => {
  const expectation = buildHorizontalExpectation({
    cells,
    businessKeyFields: ["region", "product"],
    dimensionField: "month",
    pageNo: 1,
    pageSize: 1,
    measures: [{ name: "amount", field: "amount", aggregate: "sum" }]
  });
  assert.equal(expectation.total, 3);
  assert.deepEqual(expectation.pageBusinessKeys, [{ region: "East", product: "A" }]);
  assert.equal(expectation.pageCells.length, 2);
  assert.deepEqual(expectation.values.map((row) => row.amount), [10, 20]);
});

test("horizontal page two does not lose or duplicate a business key", () => {
  const expectation = buildHorizontalExpectation({
    cells,
    businessKeyFields: ["region", "product"],
    dimensionField: "month",
    pageNo: 2,
    pageSize: 1,
    measures: [{ name: "amount", field: "amount", aggregate: "sum" }]
  });
  assert.equal(expectation.total, 3);
  assert.deepEqual(expectation.pageBusinessKeys, [{ region: "West", product: "B" }]);
  assert.deepEqual(expectation.pageCells, [cells[2]]);
});

test("AVG uses complete cell sum/count and exposes weighted grand total", () => {
  const expectation = buildHorizontalExpectation({
    cells: [
      { region: "East", product: "A", month: "Jan", amount: 10 },
      { region: "East", product: "A", month: "Feb", amount: 20 },
      { region: "West", product: "B", month: "Jan", amount: 100 }
    ],
    businessKeyFields: ["region", "product"],
    dimensionField: "month",
    pageNo: 1,
    pageSize: 2,
    measures: [{ name: "average", field: "amount", aggregate: "avg" }]
  });
  assert.deepEqual(expectation.grandTotal, { average: (10 + 20 + 100) / 3 });
  assert.deepEqual(expectation.values.map((row) => row.average), [10, 20, 100]);
});

test("composite business keys are type-safe and null-safe", () => {
  const expectation = buildHorizontalExpectation({
    cells: [
      { region: null, product: "null", month: "Jan", amount: 1 },
      { region: "null", product: null, month: "Jan", amount: 2 }
    ],
    businessKeyFields: ["region", "product"],
    dimensionField: "month",
    pageNo: 1,
    pageSize: 10,
    measures: [{ name: "amount", field: "amount", aggregate: "sum" }]
  });
  assert.equal(expectation.total, 2);
});
