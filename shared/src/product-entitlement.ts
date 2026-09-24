import { z } from "zod";

export const CONTENT_ACTIONS = ["browse", "search", "read", "cite", "export"] as const;
export const AI_TEMPLATE_ACTIONS = ["research", "generate"] as const;
export const PRODUCT_ENTITLEMENT_RESOLVER_VERSION = "product-entitlement-v1";

const collectionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,64}$/u),
  label: z.string().trim().min(1).max(80),
}).strict();

const featureSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,64}$/u),
  enabled: z.boolean(),
  limit: z.number().int().nonnegative().nullable(),
}).strict();

export const publishProductRevisionSchema = z.object({
  planKey: z.string().regex(/^[a-z][a-z0-9_]{2,64}$/u),
  displayName: z.string().trim().min(1).max(80),
  revision: z.number().int().positive(),
  resourceTemplateId: z.string().startsWith("quota_plan_revision:"),
  collections: z.array(collectionSchema).max(32),
  actions: z.array(z.enum(CONTENT_ACTIONS)).max(CONTENT_ACTIONS.length),
  aiActions: z.array(z.enum(AI_TEMPLATE_ACTIONS)).max(AI_TEMPLATE_ACTIONS.length),
  features: z.array(featureSchema).max(32),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export const assignProductEntitlementSchema = z.object({
  workspaceSlug: z.string().trim().min(1).max(128),
  billingAccountKey: z.string().trim().min(1).max(128),
  productPlanRevisionId: z.string().startsWith("product_plan_revision:"),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export const grantContentCollectionSchema = z.object({
  workspaceSlug: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(80),
  collections: z.array(collectionSchema).min(1).max(32),
  actions: z.array(z.enum(CONTENT_ACTIONS)).min(1),
  effectiveFrom: z.string().datetime(),
  effectiveUntil: z.string().datetime().nullable(),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export type PublishProductRevision = z.infer<typeof publishProductRevisionSchema>;
export type AssignProductEntitlement = z.infer<typeof assignProductEntitlementSchema>;
export type GrantContentCollection = z.infer<typeof grantContentCollectionSchema>;

export type ProductEntitlementView = {
  workspaceSlug: string;
  revision: number;
  summary: string;
  resolverVersion: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  baseSource: {
    kind: "subscription" | "trial" | "none";
    sourceId: string | null;
    planKey: string | null;
    planName: string | null;
    planRevision: number | null;
  };
  content: {
    projectionStatus: "pending_delivery" | "none";
    projectionLabel: string;
    consumesAiAllowance: false;
    collections: { key: string; label: string }[];
    actions: string[];
    sources: {
      kind: "base" | "grant";
      sourceId: string;
      label: string;
      effectiveFrom: string;
      effectiveUntil: string | null;
    }[];
  };
  ai: {
    actions: string[];
    consumableAllowance: null;
    ledger: "unavailable";
    ledgerLabel: string;
  };
  features: { key: string; enabled: boolean; limit: number | null }[];
  resource: {
    appliedPlanKey: string | null;
    appliedPlanName: string | null;
    appliedRevision: number | null;
    desiredPlanKey: string | null;
    syncState: string | null;
    status: "applied" | "pending" | "unknown";
    statusLabel: string;
  };
};
