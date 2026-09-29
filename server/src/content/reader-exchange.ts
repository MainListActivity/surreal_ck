import {
  CONTENT_READER_CONTRACT_ID,
  contentReaderExchangeRequestSchema,
  contentReaderLeaseEnd,
  contentReaderPermissions,
  formatEntitlementRevision,
  type ContentReaderError,
  type ContentReaderExchangeSuccess,
  type ContentReaderFailure,
  type IdpContentReaderError,
} from "@surreal-ck/shared";

export type ContentReaderEntitlement = {
  revision: number;
  digest: string;
  resolverVersion: string;
  effectiveUntilSeconds: number | null;
  collections: readonly string[];
  contentActions: readonly string[];
  aiActions: readonly string[];
};

export type ContentReaderTarget = {
  versionId: string;
  itemId: string;
  licenseId: string;
  sourceActive: boolean;
  publicationStatus: string;
  collectionKeys: readonly string[];
  licenseFromSeconds: number | null;
  licenseUntilSeconds: number | null;
  licenseActions: readonly string[];
};

export type ContentReaderProjectionWrite = {
  workspaceId: string;
  revision: string;
  revisionNumber: number;
  digest: string;
  resolverVersion: string;
  collections: readonly string[];
  contentActions: readonly string[];
  aiActions: readonly string[];
  allowedSubjects: readonly string[];
  confirmedUntilSeconds: number;
  versionId: string;
  itemId: string;
  licenseId: string;
  sourceStatus: "active" | "inactive";
  publicationStatus: string;
  licenseFromSeconds: number;
  licenseUntilSeconds: number | null;
  licenseActions: readonly string[];
  gateActions: readonly string[];
  gateAiActions: readonly string[];
};

export type PlannedContentReaderExchange = {
  leaseEndSeconds: number;
  idp: {
    workspaceId: string;
    entitlementRevision: string;
    leaseEndSeconds: number;
    database: string;
  };
  write: ContentReaderProjectionWrite;
  success: Omit<ContentReaderExchangeSuccess, "accessToken" | "expiresInSeconds">;
};

function fail(error: ContentReaderError): { ok: false; error: ContentReaderError } {
  return { ok: false, error };
}

export function planContentReaderExchange(input: {
  body: unknown;
  subject: string;
  workspaceDb: string;
  workspaceActive: boolean;
  membership: "active" | "removed" | "absent";
  activeSubjects: readonly string[];
  subjectExpiresAtSeconds: number;
  nowSeconds: number;
  subjectIsContentReader: boolean;
  database: string;
  namespace: string;
  entitlement: ContentReaderEntitlement | null;
  content: ContentReaderTarget | null;
}): { ok: true; plan: PlannedContentReaderExchange } | { ok: false; error: ContentReaderError } {
  if (input.subjectIsContentReader) return fail("idp_rejected");
  const parsed = contentReaderExchangeRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    if (input.body && typeof input.body === "object") {
      const keys = Object.keys(input.body);
      if (keys.some((key) => key !== "contentPublicId")) return fail("client_authority_rejected");
    }
    return fail("action_denied");
  }
  if (!input.workspaceActive) return fail("workspace_inactive");
  if (input.membership === "absent") return fail("not_member");
  if (input.membership === "removed") return fail("member_removed");
  if (!input.activeSubjects.includes(input.subject)) return fail("member_removed");
  const entitlement = input.entitlement;
  if (!entitlement || !entitlement.digest.startsWith("sha256:") || entitlement.resolverVersion.length === 0) {
    return fail("entitlement_absent");
  }
  const revision = formatEntitlementRevision(entitlement.revision);
  if (!revision.ok) return fail(revision.error);
  const permissions = contentReaderPermissions({
    contentActions: entitlement.contentActions,
    aiActions: entitlement.aiActions,
  });
  if (!permissions.ok) return fail(permissions.error);
  if (entitlement.effectiveUntilSeconds !== null && entitlement.effectiveUntilSeconds <= input.nowSeconds) {
    return fail("entitlement_expired");
  }
  const content = input.content;
  if (!content) return fail("content_not_published");
  if (content.publicationStatus === "withdrawn") return fail("content_withdrawn");
  if (content.publicationStatus !== "published") return fail("content_not_published");
  if (!content.sourceActive) return fail("content_not_published");
  if (content.licenseFromSeconds === null || content.licenseActions.length === 0) return fail("license_unknown");
  if (content.licenseUntilSeconds !== null && content.licenseUntilSeconds <= input.nowSeconds) return fail("license_expired");
  const entitled = new Set(entitlement.collections);
  if (!content.collectionKeys.some((key) => entitled.has(key))) return fail("collection_denied");
  const licenseActions = new Set(content.licenseActions);
  const allowedContentActions = entitlement.contentActions.filter((action) => licenseActions.has(action));
  const allowedAiActions = entitlement.aiActions.filter((action) => licenseActions.has(action));
  const allowed = contentReaderPermissions({ contentActions: allowedContentActions, aiActions: allowedAiActions });
  if (!allowed.ok) return fail(allowed.error);
  if (!allowed.permissions.metadata && !allowed.permissions.read && !allowed.permissions.cite
    && !allowed.permissions.export && !allowed.permissions.aiUse) return fail("action_denied");
  const lease = contentReaderLeaseEnd({
    nowSeconds: input.nowSeconds,
    subjectExpiresAtSeconds: input.subjectExpiresAtSeconds,
    entitlementEffectiveUntilSeconds: entitlement.effectiveUntilSeconds,
    licenseEffectiveUntilSeconds: content.licenseUntilSeconds,
  });
  if (!lease.ok) return fail(lease.error);
  return {
    ok: true,
    plan: {
      leaseEndSeconds: lease.leaseEndSeconds,
      idp: {
        workspaceId: input.workspaceDb,
        entitlementRevision: revision.entitlementRevision,
        leaseEndSeconds: lease.leaseEndSeconds,
        database: input.database,
      },
      write: {
        workspaceId: input.workspaceDb,
        revision: revision.entitlementRevision,
        revisionNumber: entitlement.revision,
        digest: entitlement.digest,
        resolverVersion: entitlement.resolverVersion,
        collections: entitlement.collections,
        contentActions: entitlement.contentActions,
        aiActions: entitlement.aiActions,
        allowedSubjects: input.activeSubjects,
        confirmedUntilSeconds: lease.leaseEndSeconds,
        versionId: content.versionId,
        itemId: content.itemId,
        licenseId: content.licenseId,
        sourceStatus: "active",
        publicationStatus: content.publicationStatus,
        licenseFromSeconds: content.licenseFromSeconds,
        licenseUntilSeconds: content.licenseUntilSeconds,
        licenseActions: content.licenseActions,
        gateActions: allowedContentActions,
        gateAiActions: allowedAiActions,
      },
      success: {
        contractId: CONTENT_READER_CONTRACT_ID,
        tokenType: "Bearer",
        namespace: input.namespace,
        database: input.database,
        workspaceId: input.workspaceDb,
        entitlementRevision: revision.entitlementRevision,
        digest: entitlement.digest,
        leaseEndSeconds: lease.leaseEndSeconds,
        contentPublicId: parsed.data.contentPublicId,
      },
    },
  };
}

export async function exchangeContentReader(input: {
  body: unknown;
  subject: string;
  workspaceDb: string;
  workspaceActive: boolean;
  membership: "active" | "removed" | "absent";
  activeSubjects: readonly string[];
  subjectExpiresAtSeconds: number;
  nowSeconds: number;
  subjectIsContentReader: boolean;
  database: string;
  namespace: string;
  entitlement: ContentReaderEntitlement | null;
  content: ContentReaderTarget | null;
  exchangeIdp: (request: PlannedContentReaderExchange["idp"] & { subjectToken: string }) => Promise<
    { accessToken: string; expiresInSeconds: number } | { error: IdpContentReaderError }
  >;
  writeProjection: (write: ContentReaderProjectionWrite) => Promise<void>;
  subjectToken: string;
}): Promise<ContentReaderExchangeSuccess | ContentReaderFailure> {
  const planned = planContentReaderExchange(input);
  if (!planned.ok) return planned;
  const issued = await input.exchangeIdp({ ...planned.plan.idp, subjectToken: input.subjectToken });
  if ("error" in issued) return { ok: false, error: "idp_rejected", idpError: issued.error };
  if (issued.expiresInSeconds <= 0 || issued.expiresInSeconds > planned.plan.leaseEndSeconds - input.nowSeconds) {
    return { ok: false, error: "invalid_lifetime" };
  }
  await input.writeProjection(planned.plan.write);
  return { ...planned.plan.success, accessToken: issued.accessToken, expiresInSeconds: issued.expiresInSeconds };
}
