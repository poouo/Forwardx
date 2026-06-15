import { sql, type SQL } from "drizzle-orm";
import { getDatabaseKind, quoteDbIdentifier } from "./dbRuntime";

export type RawSqlFragment = {
  sql: string;
  params: any[];
};

export function quoteIdentifier(id: string) {
  return quoteDbIdentifier(id);
}

export function quoteIdentifiers(ids: string[]) {
  return ids.map((id) => quoteIdentifier(id));
}

export function placeholders(count: number) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  return Array.from({ length: total }, () => "?").join(", ");
}

export function inList(values: unknown[]): RawSqlFragment {
  if (values.length === 0) return { sql: "(NULL)", params: [] };
  return { sql: `(${placeholders(values.length)})`, params: [...values] };
}

export function countAll(alias = "count") {
  return `COUNT(*) AS ${quoteIdentifier(alias)}`;
}

export function countDistinct(columnSql: string, alias = "count") {
  return `COUNT(DISTINCT ${columnSql}) AS ${quoteIdentifier(alias)}`;
}

export function sqlCountAll<T = number>() {
  return sql<T>`COUNT(*)`;
}

export function sqlCountDistinct<T = number>(column: SQL | any) {
  return sql<T>`COUNT(DISTINCT ${column})`;
}

export function boolValue(value: boolean) {
  return getDatabaseKind() === "postgresql" ? value : value ? 1 : 0;
}

export function boolLiteral(value: boolean) {
  return getDatabaseKind() === "postgresql"
    ? value ? "TRUE" : "FALSE"
    : value ? "1" : "0";
}

export function sqlBool(value: boolean) {
  return sql.raw(boolLiteral(value));
}

export function epochSeconds(value: Date) {
  return Math.floor(value.getTime() / 1000);
}

export function timeParam(value: Date | number) {
  return value instanceof Date ? epochSeconds(value) : value;
}

export function compareTime(columnSql: string, op: ">=" | ">" | "<=" | "<" | "=", value: Date | number): RawSqlFragment {
  return { sql: `${columnSql} ${op} ?`, params: [timeParam(value)] };
}

export function limitOffset(limit?: number, offset?: number): RawSqlFragment {
  const params: any[] = [];
  let text = "";
  if (Number.isFinite(limit)) {
    text += " LIMIT ?";
    params.push(Math.max(0, Math.floor(Number(limit))));
  }
  if (Number.isFinite(offset)) {
    text += " OFFSET ?";
    params.push(Math.max(0, Math.floor(Number(offset))));
  }
  return { sql: text, params };
}

export function castInteger(expr: string) {
  return getDatabaseKind() === "mysql" ? `CAST(${expr} AS SIGNED)` : `CAST(${expr} AS INTEGER)`;
}

export function bucketExpression(alias: string, column: string, bucketSeconds: number) {
  const q = quoteIdentifier;
  const divided = getDatabaseKind() === "sqlite"
    ? `(${alias}.${q(column)} / ${bucketSeconds})`
    : `FLOOR(${alias}.${q(column)} / ${bucketSeconds})`;
  return `${castInteger(divided)} * ${bucketSeconds}`;
}
