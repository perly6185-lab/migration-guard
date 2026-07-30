export type QualityOperator = "isNull" | "isNotNull" | "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "in";

export interface QualityField {
  key: string;
  column: string;
  aggregate?: "sum" | "count" | "avg" | "min" | "max";
}

export interface QualityFilter {
  field: string;
  operator: QualityOperator;
  value?: unknown;
}

export interface QualityClause {
  field: string;
  operator: QualityOperator;
  expression: string;
  parameters: Record<string, unknown>;
}

export interface QualityPlan {
  where: QualityClause[];
  having: QualityClause[];
}

/** Result of applying the compiled semantics to a cell relation for replay tests. */
export interface QualityEvaluation {
  whereCells: Array<Record<string, unknown>>;
  havingCells: Array<Record<string, unknown>>;
  survivingBusinessKeys: Array<Record<string, unknown>>;
  distinctTotal: number;
}

export interface QualityHorizontalEvaluation {
  quality: QualityEvaluation;
  horizontal: HorizontalExpectation;
}

const OPERATORS = new Set<QualityOperator>(["isNull", "isNotNull", "eq", "ne", "gt", "ge", "lt", "le", "in"]);
const SQL_OPERATOR: Record<QualityOperator, string> = {
  isNull: "IS NULL",
  isNotNull: "IS NOT NULL",
  eq: "=",
  ne: "<>",
  gt: ">",
  ge: ">=",
  lt: "<",
  le: "<=",
  in: "IN"
};
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Compile quality filters into safe WHERE/HAVING clauses using only field metadata. */
export function compileQualityPlan(fields: QualityField[], filters: QualityFilter[]): QualityPlan {
  const fieldMap = qualityFieldMap(fields);
  const where: QualityClause[] = [];
  const having: QualityClause[] = [];
  filters.forEach((filter, index) => {
    const field = fieldMap.get(filter.field);
    if (!field) throw new Error(`Unknown quality field: ${filter.field}`);
    if (!OPERATORS.has(filter.operator)) throw new Error(`Unsupported quality operator: ${filter.operator}`);
    const aggregateExpression = field.aggregate ? `${field.aggregate.toUpperCase()}(${field.column})` : field.column;
    const parameters: Record<string, unknown> = {};
    let expression = `${aggregateExpression} ${SQL_OPERATOR[filter.operator]}`;
    if (filter.operator === "isNull" || filter.operator === "isNotNull") {
      if (filter.value !== undefined) throw new Error(`${filter.operator} must not receive a value`);
    } else if (filter.operator === "in") {
      if (!Array.isArray(filter.value) || filter.value.length === 0) throw new Error("IN quality filter requires a non-empty array");
      if (filter.value.some((value) => value === null || value === undefined)) {
        throw new Error("IN quality filter must not contain null; use isNull explicitly");
      }
      const placeholders = filter.value.map((value, valueIndex) => {
        const name = `q${index}_${valueIndex}`;
        parameters[name] = value;
        return `:${name}`;
      });
      expression += ` (${placeholders.join(", ")})`;
    } else {
      if (filter.value === null || filter.value === undefined) {
        throw new Error(`${filter.operator} quality filter requires a non-null value`);
      }
      const name = `q${index}`;
      parameters[name] = filter.value;
      expression += ` :${name}`;
    }
    const clause: QualityClause = { field: filter.field, operator: filter.operator, expression, parameters };
    (field.aggregate ? having : where).push(clause);
  });
  return { where, having };
}

/**
 * Evaluate the same two-stage semantics used by a database query for deterministic
 * replay fixtures: ordinary predicates run per cell, aggregate predicates run per
 * business-key group. This is intentionally independent of SQL execution.
 */
export function evaluateQualityFilters(
  cells: Array<Record<string, unknown>>,
  fields: QualityField[],
  filters: QualityFilter[],
  businessKeyFields: string[]
): QualityEvaluation {
  if (businessKeyFields.length === 0) throw new Error("businessKeyFields must not be empty");
  const fieldMap = qualityFieldMap(fields);
  // Compile first so the evaluator enforces exactly the same field/operator/value contract.
  compileQualityPlan(fields, filters);
  const whereFilters = filters.filter((filter) => !fieldMap.get(filter.field)!.aggregate);
  const havingFilters = filters.filter((filter) => Boolean(fieldMap.get(filter.field)!.aggregate));
  const whereCells = cells.filter((cell) => whereFilters.every((filter) => {
    const field = fieldMap.get(filter.field)!;
    return matches(cell[field.column], filter);
  }));
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const cell of whereCells) {
    const key = businessKeyFields.map((field) => `${typeof cell[field]}:${JSON.stringify(cell[field])}`).join("\u001f");
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  const survivingGroups = [...groups.values()].filter((group) => havingFilters.every((filter) => {
    const field = fieldMap.get(filter.field);
    if (!field?.aggregate) return true;
    const values = group
      .map((cell) => cell[field.column])
      .filter((value) => value !== null && value !== undefined);
    const numbers = values
      .filter((value) => Number.isFinite(Number(value)))
      .map(Number);
    if (field.aggregate !== "count" && numbers.length !== values.length) {
      throw new Error(`Aggregate field ${field.key} contains a non-numeric value`);
    }
    const aggregate = field.aggregate === "count" ? values.length
      : field.aggregate === "sum" ? (numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null)
        : field.aggregate === "avg" ? (numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null)
          : field.aggregate === "min" ? (numbers.length ? Math.min(...numbers) : null)
            : (numbers.length ? Math.max(...numbers) : null);
    return matches(aggregate, filter);
  }));
  return {
    whereCells,
    havingCells: survivingGroups.flat(),
    survivingBusinessKeys: survivingGroups.map((group) => pick(group[0], businessKeyFields)),
    distinctTotal: survivingGroups.length
  };
}

/** Apply WHERE/HAVING first, then derive pagination from the surviving relation. */
export function evaluateQualityHorizontal(
  cells: Array<Record<string, unknown>>,
  fields: QualityField[],
  filters: QualityFilter[],
  horizontal: Omit<HorizontalValidationInput, "cells">
): QualityHorizontalEvaluation {
  const quality = evaluateQualityFilters(cells, fields, filters, horizontal.businessKeyFields);
  const expectation = buildHorizontalExpectation({ ...horizontal, cells: quality.havingCells });
  if (expectation.total !== quality.distinctTotal) throw new Error("Quality and horizontal distinct totals diverged");
  return { quality, horizontal: expectation };
}

function qualityFieldMap(fields: QualityField[]): Map<string, QualityField> {
  const fieldMap = new Map<string, QualityField>();
  for (const field of fields) {
    if (!field.key) throw new Error("Quality field key must not be empty");
    if (!SAFE_SQL_IDENTIFIER.test(field.column)) throw new Error(`Unsafe quality column: ${field.column}`);
    if (fieldMap.has(field.key)) throw new Error(`Duplicate quality field: ${field.key}`);
    fieldMap.set(field.key, field);
  }
  return fieldMap;
}

function matches(actual: unknown, filter: QualityFilter): boolean {
  if (filter.operator === "isNull") return actual === null || actual === undefined;
  if (filter.operator === "isNotNull") return actual !== null && actual !== undefined;
  if (filter.operator === "in") return Array.isArray(filter.value) && filter.value.some((value) => Object.is(value, actual));
  if (filter.operator === "eq") return Object.is(actual, filter.value);
  if (filter.operator === "ne") return !Object.is(actual, filter.value);
  if (filter.operator === "gt") return (actual as number) > (filter.value as number);
  if (filter.operator === "ge") return (actual as number) >= (filter.value as number);
  if (filter.operator === "lt") return (actual as number) < (filter.value as number);
  return (actual as number) <= (filter.value as number);
}

function pick(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, source[field]]));
}
import { buildHorizontalExpectation, type HorizontalExpectation, type HorizontalValidationInput } from "./vmpHorizontal.js";
