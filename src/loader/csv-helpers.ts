import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

/**
 * demo-data/README.md's conventions: "*_minor columns are integer paisa. Never
 * parse as float." / "Empty vs zero: an empty string means 'not applicable';
 * 0 means zero rupees." / "Multi-value columns: pipe-delimited." / "JSON columns"
 * are already valid JSON text inside the CSV cell.
 */

export function readDemoCsv(demoDataDir: string, filename: string): Record<string, string>[] {
  const text = readFileSync(join(demoDataDir, filename), "utf8");
  return parse(text, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
}

export function str(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

export function requiredStr(value: string | undefined, field: string): string {
  if (value === undefined || value === "") throw new Error(`missing required field "${field}"`);
  return value;
}

export function minor(value: string | undefined, field: string): bigint {
  const s = requiredStr(value, field);
  if (!/^-?\d+$/.test(s)) throw new TypeError(`"${field}"="${s}" is not an integer minor-unit amount`);
  return BigInt(s);
}

export function minorOrNull(value: string | undefined): bigint | null {
  if (value === undefined || value === "") return null;
  if (!/^-?\d+$/.test(value)) throw new TypeError(`"${value}" is not an integer minor-unit amount`);
  return BigInt(value);
}

export function yn(value: string | undefined): boolean {
  return value === "Y";
}

/**
 * node-postgres serialises a plain JS array as a Postgres ARRAY literal (`{...}`),
 * not JSON — only plain objects get JSON.stringify'd automatically. Any value
 * headed for a JSONB column must be pre-stringified explicitly, or a JSON array
 * value (like `["NTN"]`) round-trips as `{"NTN"}` and Postgres rejects it as
 * invalid JSON. Use this for every JSONB insert/update value, regardless of shape.
 */
export function toJsonb(value: unknown): string {
  return JSON.stringify(value);
}

export function jsonOrNull(value: string | undefined): unknown {
  if (value === undefined || value === "") return null;
  return JSON.parse(value);
}

export function jsonOr(value: string | undefined, fallback: unknown): unknown {
  if (value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

export function pipeList(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  return value.split("|");
}

export function dateOrNull(value: string | undefined): string | null {
  return str(value);
}

export function tsOrNull(value: string | undefined): Date | null {
  const s = str(value);
  return s === null ? null : new Date(s);
}
