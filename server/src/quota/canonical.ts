import { createHash } from "node:crypto";

function encodeCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") {
    return `{"$bigint":${JSON.stringify(value.toString())}}`;
  }
  if (
    typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encodeCanonical).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`unsupported canonical value: ${typeof value}`);
}

export function canonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(encodeCanonical(value)).digest("hex")}`;
}

export function stableSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
