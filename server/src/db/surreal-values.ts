import { jsonify, RecordId, StringRecordId } from "surrealdb";

export function toStringRecordId(value: unknown): StringRecordId | null {
  if (value instanceof StringRecordId) {
    return value;
  }
  if (value instanceof RecordId) {
    return new StringRecordId(value);
  }
  if (typeof value === "string") {
    return new StringRecordId(value);
  }
  return null;
}

export function toIsoDateTimeString(value: unknown): string | null {
  const dateValue = value instanceof Date ? value.toISOString() : typeof value === "string" ? value : jsonify(value);
  if (typeof dateValue !== "string") return null;
  const parsed = Date.parse(dateValue);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function dateTimeTimestamp(value: unknown): number {
  const parsed = toIsoDateTimeString(value);
  return parsed === null ? 0 : Date.parse(parsed);
}
