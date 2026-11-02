import { StringRecordId } from "surrealdb";
import type { PlatformOperatorCapability } from "@surreal-ck/shared/native-quota";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import { toStringRecordId } from "../db/surreal-values";
import { HttpError } from "../http-error";
import { platformOperatorSubjectHash } from "./platform-operators";

/** 探针临时授权只覆盖这一项能力；不引入通用能力管理。 */
export const ENDPOINT_PROBE_TEMPORARY_CAPABILITY = "internal-ai.endpoint-probe" as const satisfies PlatformOperatorCapability;

/** 固定上限：授予后最多 30 分钟；不能只靠 sweep，权限检查即时看 not_after。 */
export const ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS = 30 * 60 * 1000;

export type EndpointProbeTemporaryGrantStatus = "active" | "revoked" | "expired" | "absent";

export type EndpointProbeTemporaryGrantView = Readonly<{
  capability: typeof ENDPOINT_PROBE_TEMPORARY_CAPABILITY;
  subjectHash: string;
  status: EndpointProbeTemporaryGrantStatus;
  grantedAt: string | null;
  notAfter: string | null;
  revokedAt: string | null;
  version: number | null;
  /** 永久表里是否已有同能力；临时撤回不会动它。 */
  permanentActive: boolean;
}>;

type Queryable = { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
type RootSessionFactory = (database: string, namespace?: string) => Promise<Queryable>;

type Row = Record<string, unknown>;

function statementRows(value: unknown, index = 0): Row[] {
  if (!Array.isArray(value)) return [];
  const statement = value[index];
  if (!Array.isArray(statement)) return [];
  return statement.filter((item): item is Row => typeof item === "object" && item !== null && !Array.isArray(item));
}

function firstRow(value: unknown): Row | null {
  return statementRows(value, 0)[0] ?? null;
}

function asIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  // Surreal SDK DateTime：不是 Date 实例，但 toJSON()/toString() 给出 ISO 字符串。
  if (value && typeof value === "object") {
    const json = typeof (value as { toJSON?: () => unknown }).toJSON === "function"
      ? (value as { toJSON: () => unknown }).toJSON()
      : null;
    if (typeof json === "string" && Number.isFinite(Date.parse(json))) return new Date(json).toISOString();
    const text = String(value);
    if (text && Number.isFinite(Date.parse(text))) return new Date(text).toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return Number(value);
  return null;
}

function configuredSubject(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** 部署控制的引导授权主体：只有它能授予/撤回临时探针能力。 */
export function configuredTemporaryGrantorSubject(): string | null {
  return configuredSubject(env.ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT);
}

/** 部署控制的被授权主体：临时探针能力只能授给它（优先 LCA04_OPS）。 */
export function configuredTemporaryGranteeSubject(): string | null {
  return configuredSubject(env.ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT);
}

export function assertTemporaryGrantConfigured(): { grantor: string; grantee: string } {
  const grantor = configuredTemporaryGrantorSubject();
  const grantee = configuredTemporaryGranteeSubject();
  if (!grantor || !grantee) {
    throw new HttpError(503, "endpoint-probe-temporary-grant-not-configured", "探针临时授权引导主体未配置");
  }
  if (grantor === grantee) {
    throw new HttpError(503, "endpoint-probe-temporary-grant-misconfigured", "授予主体与被授权主体不能相同");
  }
  return { grantor, grantee };
}

function projectView(input: Readonly<{
  subject: string;
  row: Row | null;
  permanentActive: boolean;
  now: number;
}>): EndpointProbeTemporaryGrantView {
  const base = {
    capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
    subjectHash: platformOperatorSubjectHash(input.subject),
    permanentActive: input.permanentActive,
  } as const;
  if (!input.row) {
    return { ...base, status: "absent", grantedAt: null, notAfter: null, revokedAt: null, version: null };
  }
  const grantedAt = asIso(input.row.granted_at);
  const notAfter = asIso(input.row.not_after);
  const revokedAt = asIso(input.row.revoked_at);
  const version = asInt(input.row.version);
  const statusRaw = input.row.status === "revoked" ? "revoked" : "active";
  const expired = statusRaw === "active" && notAfter !== null && Date.parse(notAfter) <= input.now;
  return {
    ...base,
    status: statusRaw === "revoked" ? "revoked" : expired ? "expired" : "active",
    grantedAt,
    notAfter,
    revokedAt,
    version,
  };
}

/**
 * 探针临时授权控制面。
 *
 * - 不读写永久 `platform_operator_capability` 行（除只读报告 permanentActive）。
 * - 到期在读路径即时失效；重启/seed 不续期、不把临时权限补进永久表。
 * - 授予/撤回校验部署配置的 grantor/grantee，禁止自授与任意主体。
 */
export class EndpointProbeTemporaryGrantService {
  constructor(
    private readonly getSession: RootSessionFactory = getRootDatabaseSession,
    private readonly namespace: string = env.SURREAL_NS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async db(): Promise<Queryable> {
    return this.getSession("_system", this.namespace);
  }

  /** 权限检查用：当前时刻对该主体仍然有效的临时探针能力（0 或 1 项）。 */
  async activeCapabilitiesFor(subject: string, at = this.now()): Promise<readonly PlatformOperatorCapability[]> {
    const db = await this.db();
    const result = await db.query(
      `
        SELECT capability, status, not_after
        FROM platform_operator_temporary_grant
        WHERE subject = $subject
          AND capability = $capability
        LIMIT 1;
      `,
      { subject, capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY },
    );
    const row = firstRow(result);
    if (!row || row.status !== "active") return [];
    const notAfter = asIso(row.not_after);
    if (!notAfter || Date.parse(notAfter) <= at) return [];
    return [ENDPOINT_PROBE_TEMPORARY_CAPABILITY];
  }

  async getStatusFor(subject: string): Promise<EndpointProbeTemporaryGrantView> {
    const db = await this.db();
    const result = await db.query(
      `
        SELECT *
        FROM platform_operator_temporary_grant
        WHERE subject = $subject AND capability = $capability
        LIMIT 1;
        SELECT VALUE count()
        FROM platform_operator_capability
        WHERE status = "active"
          AND capability = $capability
          AND operator IN (
            SELECT VALUE id FROM platform_operator
            WHERE subject = $subject AND status = "active"
          );
      `,
      { subject, capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY },
    );
    const row = firstRow(result);
    const permanentCount = (() => {
      if (!Array.isArray(result) || !Array.isArray(result[1])) return 0;
      const value = result[1][0];
      return typeof value === "number" ? value : Number(value ?? 0);
    })();
    return projectView({
      subject,
      row,
      permanentActive: permanentCount > 0,
      now: this.now(),
    });
  }

  async grant(input: Readonly<{
    actorSubject: string;
    reason?: string;
    expectedVersion?: number;
    idempotencyKey?: string;
  }>): Promise<EndpointProbeTemporaryGrantView> {
    const { grantor, grantee } = assertTemporaryGrantConfigured();
    if (input.actorSubject !== grantor) {
      throw new HttpError(403, "endpoint-probe-temporary-grant-forbidden", "当前主体不能授予探针临时能力");
    }
    if (input.actorSubject === grantee) {
      throw new HttpError(403, "endpoint-probe-temporary-grant-self", "禁止自授探针临时能力");
    }

    const now = this.now();
    const grantedAt = new Date(now);
    const notAfter = new Date(now + ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS);
    const db = await this.db();
    const existing = firstRow(await db.query(
      `
        SELECT *
        FROM platform_operator_temporary_grant
        WHERE subject = $subject AND capability = $capability
        LIMIT 1;
      `,
      { subject: grantee, capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY },
    ));

    if (existing) {
      const current = projectView({ subject: grantee, row: existing, permanentActive: false, now });
      if (current.status === "active") {
        // 幂等：同一有效授权重放不续期、不改 not_after。
        if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
          throw new HttpError(409, "endpoint-probe-temporary-grant-version-conflict", "探针临时授权版本冲突");
        }
        return this.getStatusFor(grantee);
      }
      if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
        throw new HttpError(409, "endpoint-probe-temporary-grant-version-conflict", "探针临时授权版本冲突");
      }
      const nextVersion = (current.version ?? 0) + 1;
      const id = toStringRecordId(existing.id) ?? new StringRecordId(String(existing.id));
      await db.query(
        input.reason
          ? `
          UPDATE $id SET
            status = "active",
            granted_by_subject = $grantor,
            granted_at = $grantedAt,
            not_after = $notAfter,
            revoked_at = NONE,
            revoked_by_subject = NONE,
            grant_reason = $reason,
            revoke_reason = NONE,
            version = $version;
        `
          : `
          UPDATE $id SET
            status = "active",
            granted_by_subject = $grantor,
            granted_at = $grantedAt,
            not_after = $notAfter,
            revoked_at = NONE,
            revoked_by_subject = NONE,
            grant_reason = NONE,
            revoke_reason = NONE,
            version = $version;
        `,
        {
          id,
          grantor,
          grantedAt,
          notAfter,
          ...(input.reason ? { reason: input.reason } : {}),
          version: nextVersion,
        },
      );
      return this.getStatusFor(grantee);
    }

    if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
      throw new HttpError(409, "endpoint-probe-temporary-grant-version-conflict", "探针临时授权版本冲突");
    }
    await db.query(
      input.reason
        ? `
        INSERT INTO platform_operator_temporary_grant {
          subject: $subject,
          capability: $capability,
          status: "active",
          granted_by_subject: $grantor,
          granted_at: $grantedAt,
          not_after: $notAfter,
          grant_reason: $reason,
          version: 1
        };
      `
        : `
        INSERT INTO platform_operator_temporary_grant {
          subject: $subject,
          capability: $capability,
          status: "active",
          granted_by_subject: $grantor,
          granted_at: $grantedAt,
          not_after: $notAfter,
          version: 1
        };
      `,
      {
        subject: grantee,
        capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
        grantor,
        grantedAt,
        notAfter,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    );
    return this.getStatusFor(grantee);
  }

  async revoke(input: Readonly<{
    actorSubject: string;
    reason?: string;
    expectedVersion?: number;
  }>): Promise<EndpointProbeTemporaryGrantView> {
    const { grantor, grantee } = assertTemporaryGrantConfigured();
    if (input.actorSubject !== grantor) {
      throw new HttpError(403, "endpoint-probe-temporary-grant-forbidden", "当前主体不能撤回探针临时能力");
    }
    const now = this.now();
    const db = await this.db();
    const existing = firstRow(await db.query(
      `
        SELECT *
        FROM platform_operator_temporary_grant
        WHERE subject = $subject AND capability = $capability
        LIMIT 1;
      `,
      { subject: grantee, capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY },
    ));
    if (!existing) {
      return projectView({ subject: grantee, row: null, permanentActive: false, now });
    }
    const current = projectView({ subject: grantee, row: existing, permanentActive: false, now });
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new HttpError(409, "endpoint-probe-temporary-grant-version-conflict", "探针临时授权版本冲突");
    }
    if (current.status === "revoked") {
      return this.getStatusFor(grantee);
    }
    // active 或 expired 都允许标 revoked，避免过期行被误当成可续期。
    const id = toStringRecordId(existing.id) ?? new StringRecordId(String(existing.id));
    await db.query(
      input.reason
        ? `
        UPDATE $id SET
          status = "revoked",
          revoked_at = $revokedAt,
          revoked_by_subject = $actor,
          revoke_reason = $reason,
          version = $version;
      `
        : `
        UPDATE $id SET
          status = "revoked",
          revoked_at = $revokedAt,
          revoked_by_subject = $actor,
          revoke_reason = NONE,
          version = $version;
      `,
      {
        id,
        revokedAt: new Date(now),
        actor: input.actorSubject,
        ...(input.reason ? { reason: input.reason } : {}),
        version: (current.version ?? 0) + 1,
      },
    );
    return this.getStatusFor(grantee);
  }
}

/** 把临时有效能力并入永久能力读面；不修改永久表。 */
export function mergeTemporaryCapabilities(
  permanent: readonly PlatformOperatorCapability[],
  temporary: readonly PlatformOperatorCapability[],
): PlatformOperatorCapability[] {
  const merged = new Set<PlatformOperatorCapability>(permanent);
  for (const capability of temporary) merged.add(capability);
  return [...merged].sort();
}
