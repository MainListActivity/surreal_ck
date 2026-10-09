import { RecordId } from "surrealdb";
import { z } from "zod";
import type { Queryable } from "./store";
import { HttpError } from "../http-error";

export const identitySchema = z.object({
  subject: z.string().min(1).max(200), spaceId: z.string().min(1).max(200),
  database: z.string().regex(/^[a-z0-9_]{1,128}$/),
  workspaceRole: z.enum(["admin", "participant"]), billingRole: z.enum(["owner", "member"]),
  billingAccountRef: z.string().min(1).max(200),
}).strict();
export type InternalIdentity = z.infer<typeof identitySchema>;
const record = z.instanceof(RecordId);
const workspaceSchema = z.object({ id: record, db_name: identitySchema.shape.database, status: z.literal("active") });
const itemSchema = z.object({ subscription: z.object({
  status: z.enum(["active", "trialing"]),
  billing_account: z.object({ id: record, status: z.literal("active"), account_key: identitySchema.shape.billingAccountRef }),
}) });
export function queryRows(result: unknown): unknown[] {
  const first: unknown = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(first) ? first : first && typeof first === "object" ? [first] : [];
}
const unavailable = () => new HttpError(404, "internal-ai-identity-unavailable", "内部身份不可用");

/** 经理 v9 固定投影：member 不是账单权限；admin 不能压成 member。仅查询调用者自身。 */
export async function readInternalIdentity(db: Queryable, subject: string, slug: string): Promise<InternalIdentity> {
  const workspaces = queryRows(await db.query("SELECT id, db_name, status FROM workspace WHERE slug = $slug AND status = 'active' LIMIT 2", { slug }));
  const ws = workspaceSchema.safeParse(workspaces[0]);
  if (workspaces.length !== 1 || !ws.success) throw unavailable();
  const memberships = queryRows(await db.query("SELECT role FROM user_workspace_index WHERE workspace = $workspace AND subject = $subject AND disabled_at = NONE LIMIT 2", { workspace: ws.data.id, subject }));
  const member = z.object({ role: identitySchema.shape.workspaceRole }).safeParse(memberships[0]);
  if (memberships.length !== 1 || !member.success) throw unavailable();
  const items = queryRows(await db.query("SELECT subscription FROM quota_subscription_item WHERE active_workspace = $workspace AND status = 'active' LIMIT 2 FETCH subscription, subscription.billing_account", { workspace: ws.data.id }));
  const item = itemSchema.safeParse(items[0]);
  if (items.length !== 1 || !item.success) throw unavailable();
  const account = item.data.subscription.billing_account;
  const roles = queryRows(await db.query("SELECT role FROM billing_account_member WHERE billing_account = $account AND subject = $subject AND status = 'active' LIMIT 2", { account: account.id, subject }));
  if (roles.length > 1) throw unavailable();
  const role = roles.length ? z.object({ role: z.enum(["owner", "admin", "viewer"]) }).safeParse(roles[0]) : undefined;
  if (role && (!role.success || role.data.role === "admin")) throw unavailable();
  return { subject, spaceId: String(ws.data.id), database: ws.data.db_name, workspaceRole: member.data.role,
    billingRole: role?.success && role.data.role === "owner" ? "owner" : "member", billingAccountRef: account.account_key };
}
