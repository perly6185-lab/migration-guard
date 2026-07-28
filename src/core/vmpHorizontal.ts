export type HorizontalAggregate = "sum" | "count" | "min" | "max" | "avg";

export interface HorizontalMeasure {
  name: string;
  field: string;
  aggregate: HorizontalAggregate;
}

export interface HorizontalValidationInput {
  cells: Array<Record<string, unknown>>;
  businessKeyFields: string[];
  dimensionField: string;
  pageNo: number;
  pageSize: number;
  measures: HorizontalMeasure[];
}

export interface HorizontalExpectation {
  total: number;
  pageNo: number;
  pageSize: number;
  businessKeys: Array<Record<string, unknown>>;
  pageBusinessKeys: Array<Record<string, unknown>>;
  pageCells: Array<Record<string, unknown>>;
  values: Array<Record<string, unknown>>;
  grandTotal: Record<string, unknown>;
}

/**
 * Derive the observable horizontal-table contract from a filtered cell relation.
 *
 * The input must already include WHERE/HAVING filtering. Pagination is applied to
 * distinct business keys, never to individual dimension cells. AVG is calculated
 * from sum/count over the complete key relation, not by averaging page/cell averages.
 */
export function buildHorizontalExpectation(input: HorizontalValidationInput): HorizontalExpectation {
  if (!Number.isInteger(input.pageNo) || input.pageNo < 1) throw new Error("pageNo must be a positive integer");
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1) throw new Error("pageSize must be a positive integer");
  if (input.businessKeyFields.length === 0) throw new Error("businessKeyFields must not be empty");

  const groups = new Map<string, { key: Record<string, unknown>; cells: Array<Record<string, unknown>> }>();
  for (const cell of input.cells) {
    const key = input.businessKeyFields.map((field) => stableValue(cell[field])).join("\u001f");
    const group = groups.get(key);
    if (group) group.cells.push(cell);
    else groups.set(key, { key: pick(cell, input.businessKeyFields), cells: [cell] });
  }

  const businessKeys = [...groups.values()].map((group) => group.key);
  const start = (input.pageNo - 1) * input.pageSize;
  const pageBusinessKeys = businessKeys.slice(start, start + input.pageSize);
  const pageKeySet = new Set(pageBusinessKeys.map((key) => input.businessKeyFields.map((field) => stableValue(key[field])).join("\u001f")));
  const pageCells = input.cells.filter((cell) => pageKeySet.has(input.businessKeyFields.map((field) => stableValue(cell[field])).join("\u001f")));

  const values: Array<Record<string, unknown>> = [];
  for (const key of pageBusinessKeys) {
    const group = groups.get(input.businessKeyFields.map((field) => stableValue(key[field])).join("\u001f"));
    if (!group) continue;
    for (const dimension of uniqueDimensions(group.cells, input.dimensionField)) {
      const dimensionCells = group.cells.filter((cell) => stableValue(cell[input.dimensionField]) === stableValue(dimension));
      values.push({ ...key, [input.dimensionField]: dimension, ...measureValues(dimensionCells, input.measures) });
    }
  }

  return {
    total: businessKeys.length,
    pageNo: input.pageNo,
    pageSize: input.pageSize,
    businessKeys,
    pageBusinessKeys,
    pageCells,
    values,
    grandTotal: measureValues(input.cells, input.measures)
  };
}

function measureValues(cells: Array<Record<string, unknown>>, measures: HorizontalMeasure[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const measure of measures) {
    const numbers = cells.map((cell) => Number(cell[measure.field])).filter((value) => Number.isFinite(value));
    if (measure.aggregate === "count") result[measure.name] = numbers.length;
    else if (measure.aggregate === "sum") result[measure.name] = numbers.reduce((sum, value) => sum + value, 0);
    else if (measure.aggregate === "min") result[measure.name] = numbers.length ? Math.min(...numbers) : null;
    else if (measure.aggregate === "max") result[measure.name] = numbers.length ? Math.max(...numbers) : null;
    else result[measure.name] = numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
  }
  return result;
}

function uniqueDimensions(cells: Array<Record<string, unknown>>, field: string): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const cell of cells) {
    const value = cell[field];
    const key = stableValue(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function pick(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, source[field]]));
}

function stableValue(value: unknown): string {
  return value === null ? "null" : `${typeof value}:${JSON.stringify(value)}`;
}
