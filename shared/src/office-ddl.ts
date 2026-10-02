import { z } from "zod";

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const table = name.refine((value) => /^ent_[a-z0-9_]+$/.test(value), "仅允许 ent_ 业务表");
const field = name.refine((value) => !["id", "created_by", "created_at", "updated_at"].includes(value));
export const OfficeDdlChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("define_table"), table }).strict(),
  z.object({ op: z.literal("define_field"), table, field,
    type: z.enum(["string", "bool", "int", "float", "decimal", "datetime"]) }).strict(),
  z.object({ op: z.literal("define_index"), table, index: name,
    fields: z.array(field).min(1).max(8) }).strict(),
]);
export type OfficeDdlChange = z.infer<typeof OfficeDdlChangeSchema>;
export const OfficeDdlStatusSchema = z.enum([
  "requested", "approved", "executing", "succeeded", "rejected", "failed", "ambiguous", "reconciled",
]);
export type OfficeDdlStatus = z.infer<typeof OfficeDdlStatusSchema>;
export const DDL_TERMINAL: ReadonlySet<string> = new Set(["succeeded", "rejected", "failed", "reconciled"]);

/** 严格解析并固定键顺序；不接受 SQL、表达式、批量语句或覆盖已有定义。 */
export function normalizeOfficeDdl(value: unknown): OfficeDdlChange {
  const change = OfficeDdlChangeSchema.parse(value);
  if (change.op === "define_table") return { op: change.op, table: change.table };
  if (change.op === "define_field") return { op: change.op, table: change.table, field: change.field, type: change.type };
  return { op: change.op, table: change.table, index: change.index, fields: [...new Set(change.fields)].sort() };
}

export function compileOfficeDdl(value: unknown): string {
  const change = normalizeOfficeDdl(value);
  if (change.op === "define_table") {
    return `DEFINE TABLE ${change.table} SCHEMAFULL PERMISSIONS FOR select, create, update, delete WHERE fn::current_user() != NONE;`;
  }
  if (change.op === "define_field") {
    return `DEFINE FIELD ${change.field} ON TABLE ${change.table} TYPE option<${change.type}>;`;
  }
  return `DEFINE INDEX ${change.index} ON TABLE ${change.table} FIELDS ${change.fields.join(", ")};`;
}

export async function officeDdlFingerprint(task: string, author: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ task, author, change: normalizeOfficeDdl(value) }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
