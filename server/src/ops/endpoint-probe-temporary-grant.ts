import type { PlatformOperatorCapability } from "@surreal-ck/shared/native-quota";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
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

function versionConflict(): HttpError {
  return new HttpError(409, "endpoint-probe-temporary-grant-version-conflict", "探针临时授权版本冲突");
}

function expectedVersionRequired(): HttpError {
  return new HttpError(
    409,
    "endpoint-probe-temporary-grant-expected-version-required",
    "已存在临时授权行；重新授予须携带当前 expectedVersion",
  );
}

function idempotencyRequired(): HttpError {
  return new HttpError(
    400,
    "endpoint-probe-temporary-grant-idempotency-required",
    "授予必须携带 idempotencyKey",
  );
}

function idempotencyConflict(): HttpError {
  return new HttpError(
    409,
    "endpoint-probe-temporary-grant-idempotency-conflict",
    "idempotencyKey 已被不同操作使用",
  );
}

/** 写入冲突：版本不匹配、唯一索引冲突或事务内 THROW；调用方需要重读后决定重放/冲突。 */
export class TemporaryGrantWriteConflictError extends Error {
  constructor(readonly detail?: unknown) {
    super("endpoint-probe-temporary-grant-write-conflict");
    this.name = "TemporaryGrantWriteConflictError";
  }
}

export type TemporaryGrantActivateInput = Readonly<{
  subject: string;
  capability: string;
  grantor: string;
  grantedAt: Date;
  notAfter: Date;
  expectedVersion: number;
  nextVersion: number;
  reason?: string;
  idempotencyKey: string;
}>;

export type TemporaryGrantRevokeInput = Readonly<{
  subject: string;
  capability: string;
  actor: string;
  revokedAt: Date;
  expectedVersion?: number;
  nextVersion: number;
  reason?: string;
  idempotencyKey?: string;
}>;

export type TemporaryGrantRecordRequestInput = Readonly<{
  subject: string;
  capability: string;
  idempotencyKey: string;
  operation: "grant" | "revoke";
  resultVersion?: number;
  resultNotAfter?: Date;
}>;

/**
 * 临时授权持久层。写入方法必须是数据库原子操作：
 * - activate 在事务内做版本 CAS + 幂等记录插入；
 * - revoke 在事务内做条件更新 + 幂等记录插入；
 * - 任一条件不满足抛 TemporaryGrantWriteConflictError。
 */
export type TemporaryGrantStore = {
  isActiveOperator(subject: string): Promise<boolean>;
  getGrant(subject: string, capability: string): Promise<Row | null>;
  getRequest(subject: string, capability: string, idempotencyKey: string): Promise<Row | null>;
  countPermanent(subject: string, capability: string): Promise<number>;
  activate(input: TemporaryGrantActivateInput): Promise<void>;
  revoke(input: TemporaryGrantRevokeInput): Promise<void>;
  recordRequest(input: TemporaryGrantRecordRequestInput): Promise<void>;
};

function insertReasonField(field: "grant_reason" | "revoke_reason", input: { reason?: string }): string {
  return input.reason ? `${field}: $reason,` : `${field}: NONE,`;
}

function updateReasonField(field: "grant_reason" | "revoke_reason", input: { reason?: string }): string {
  return input.reason ? `${field} = $reason,` : `${field} = NONE,`;
}

function requestInsertSql(
  operation: "grant" | "revoke",
  result: Readonly<{ version: string; notAfter: string }>,
): string {
  return `
    INSERT INTO platform_operator_temporary_grant_request {
      subject: $subject,
      capability: $capability,
      idempotency_key: $key,
      operation: "${operation}",
      result_version: ${result.version},
      result_not_after: ${result.notAfter}
    };`;
}

export class SurrealTemporaryGrantStore implements TemporaryGrantStore {
  constructor(
    private readonly getSession: RootSessionFactory = getRootDatabaseSession,
    private readonly namespace: string = env.SURREAL_NS,
  ) {}

  private async db(): Promise<Queryable> {
    return this.getSession("_system", this.namespace);
  }

  async isActiveOperator(subject: string): Promise<boolean> {
    const db = await this.db();
    const rows = statementRows(await db.query(
      `
        SELECT id
        FROM platform_operator
        WHERE subject = $subject AND status = "active"
        LIMIT 1;
      `,
      { subject },
    ));
    return rows.length > 0;
  }

  async getGrant(subject: string, capability: string): Promise<Row | null> {
    const db = await this.db();
    return firstRow(await db.query(
      `
        SELECT *
        FROM platform_operator_temporary_grant
        WHERE subject = $subject AND capability = $capability
        LIMIT 1;
      `,
      { subject, capability },
    ));
  }

  async getRequest(subject: string, capability: string, idempotencyKey: string): Promise<Row | null> {
    const db = await this.db();
    return firstRow(await db.query(
      `
        SELECT *
        FROM platform_operator_temporary_grant_request
        WHERE subject = $subject
          AND capability = $capability
          AND idempotency_key = $key
        LIMIT 1;
      `,
      { subject, capability, key: idempotencyKey },
    ));
  }

  async countPermanent(subject: string, capability: string): Promise<number> {
    const db = await this.db();
    const result = await db.query(
      `
        SELECT VALUE count()
        FROM platform_operator_capability
        WHERE status = "active"
          AND capability = $capability
          AND operator IN (
            SELECT VALUE id FROM platform_operator
            WHERE subject = $subject AND status = "active"
          );
      `,
      { subject, capability },
    );
    if (!Array.isArray(result) || !Array.isArray(result[0])) return 0;
    const value = result[0][0];
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  async activate(input: TemporaryGrantActivateInput): Promise<void> {
    const db = await this.db();
    const params: Record<string, unknown> = {
      subject: input.subject,
      capability: input.capability,
      grantor: input.grantor,
      grantedAt: input.grantedAt,
      notAfter: input.notAfter,
      expectedVersion: input.expectedVersion,
      nextVersion: input.nextVersion,
      key: input.idempotencyKey,
    };
    if (input.reason) params.reason = input.reason;
    const requestInsert = requestInsertSql("grant", { version: "$nextVersion", notAfter: "$notAfter" });

    const sql = input.expectedVersion === 0
      ? `
        BEGIN TRANSACTION;
        LET $inserted = (
          INSERT INTO platform_operator_temporary_grant {
            subject: $subject,
            capability: $capability,
            status: "active",
            granted_by_subject: $grantor,
            granted_at: $grantedAt,
            not_after: $notAfter,
            ${insertReasonField("grant_reason", input)}
            version: $nextVersion
          } RETURN AFTER
        );
        IF array::len($inserted) = 1 {
          ${requestInsert}
        } ELSE {
          THROW "endpoint-probe-temporary-grant-write-conflict";
        };
        COMMIT TRANSACTION;
      `
      : `
        BEGIN TRANSACTION;
        LET $updated = (
          UPDATE platform_operator_temporary_grant SET
            status = "active",
            granted_by_subject = $grantor,
            granted_at = $grantedAt,
            not_after = $notAfter,
            revoked_at = NONE,
            revoked_by_subject = NONE,
            ${updateReasonField("grant_reason", input)}
            revoke_reason = NONE,
            version = $nextVersion
          WHERE subject = $subject
            AND capability = $capability
            AND version = $expectedVersion
          RETURN AFTER
        );
        IF array::len($updated) = 1 {
          ${requestInsert}
        } ELSE {
          THROW "endpoint-probe-temporary-grant-write-conflict";
        };
        COMMIT TRANSACTION;
      `;

    try {
      await db.query(sql, params);
    } catch (cause) {
      throw new TemporaryGrantWriteConflictError(cause);
    }
  }

  async revoke(input: TemporaryGrantRevokeInput): Promise<void> {
    const db = await this.db();
    const params: Record<string, unknown> = {
      subject: input.subject,
      capability: input.capability,
      actor: input.actor,
      revokedAt: input.revokedAt,
      nextVersion: input.nextVersion,
    };
    if (input.expectedVersion !== undefined) params.expectedVersion = input.expectedVersion;
    if (input.reason) params.reason = input.reason;
    if (input.idempotencyKey) params.key = input.idempotencyKey;

    const versionCondition = input.expectedVersion === undefined ? "" : "AND version = $expectedVersion";
    const update = `
      UPDATE platform_operator_temporary_grant SET
        status = "revoked",
        revoked_at = $revokedAt,
        revoked_by_subject = $actor,
        ${updateReasonField("revoke_reason", input)}
        version = $nextVersion
      WHERE subject = $subject
        AND capability = $capability
        AND status = "active"
        ${versionCondition}
      RETURN AFTER
    `;

    try {
      if (input.idempotencyKey) {
        const requestInsert = requestInsertSql("revoke", { version: "$nextVersion", notAfter: "NONE" });
        await db.query(
          `
            BEGIN TRANSACTION;
            LET $updated = (${update});
            IF array::len($updated) = 1 {
              ${requestInsert}
            } ELSE {
              THROW "endpoint-probe-temporary-grant-write-conflict";
            };
            COMMIT TRANSACTION;
          `,
          params,
        );
        return;
      }
      const result = await db.query(`${update};`, params);
      if (statementRows(result).length !== 1) {
        throw new TemporaryGrantWriteConflictError("revoke affected no row");
      }
    } catch (cause) {
      if (cause instanceof TemporaryGrantWriteConflictError) throw cause;
      throw new TemporaryGrantWriteConflictError(cause);
    }
  }

  async recordRequest(input: TemporaryGrantRecordRequestInput): Promise<void> {
    const db = await this.db();
    const fields = [
      "subject: $subject",
      "capability: $capability",
      "idempotency_key: $key",
      `operation: "${input.operation}"`,
      input.resultVersion === undefined ? "result_version: NONE" : "result_version: $resultVersion",
      input.resultNotAfter === undefined ? "result_not_after: NONE" : "result_not_after: $resultNotAfter",
    ];
    const params: Record<string, unknown> = {
      subject: input.subject,
      capability: input.capability,
      key: input.idempotencyKey,
    };
    if (input.resultVersion !== undefined) params.resultVersion = input.resultVersion;
    if (input.resultNotAfter !== undefined) params.resultNotAfter = input.resultNotAfter;
    try {
      await db.query(
        `INSERT INTO platform_operator_temporary_grant_request { ${fields.join(", ")} };`,
        params,
      );
    } catch (cause) {
      throw new TemporaryGrantWriteConflictError(cause);
    }
  }
}

export function createSurrealTemporaryGrantStore(
  getSession: RootSessionFactory = getRootDatabaseSession,
  namespace: string = env.SURREAL_NS,
): TemporaryGrantStore {
  return new SurrealTemporaryGrantStore(getSession, namespace);
}

/**
 * 探针临时授权控制面。
 *
 * - 不读写永久 `platform_operator_capability` 行（除只读报告 permanentActive）。
 * - 到期在读路径即时失效；重启/seed 不续期、不把临时权限补进永久表。
 * - 授予/撤回校验部署配置的 grantor/grantee，禁止自授与任意主体。
 * - 读路径同时校验主体仍是 active 运营、且仍是当前配置的 grantee。
 * - 授予请求持久化 idempotencyKey；撤回/过期后同键重放不会重新授能。
 */
export class EndpointProbeTemporaryGrantService {
  constructor(
    private readonly store: TemporaryGrantStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async replayRecorded(
    subject: string,
    idempotencyKey: string,
    operation: "grant" | "revoke",
  ): Promise<EndpointProbeTemporaryGrantView | null> {
    const prior = await this.store.getRequest(subject, ENDPOINT_PROBE_TEMPORARY_CAPABILITY, idempotencyKey);
    if (!prior) return null;
    if (prior.operation !== operation) throw idempotencyConflict();
    return this.getStatusFor(subject);
  }

  /** 权限检查用：当前时刻对该主体仍然有效的临时探针能力（0 或 1 项）。 */
  async activeCapabilitiesFor(subject: string, at = this.now()): Promise<readonly PlatformOperatorCapability[]> {
    // 配置变更/缺失时旧主体立即失效；同一时刻只认当前配置的 grantee。
    const grantee = configuredTemporaryGranteeSubject();
    if (!grantee || subject !== grantee) return [];
    // 运营主体被禁用或移除后，即使临时行仍 active，也必须 fail closed。
    if (!(await this.store.isActiveOperator(subject))) return [];
    const row = await this.store.getGrant(subject, ENDPOINT_PROBE_TEMPORARY_CAPABILITY);
    if (!row || row.status !== "active") return [];
    const notAfter = asIso(row.not_after);
    if (!notAfter || Date.parse(notAfter) <= at) return [];
    return [ENDPOINT_PROBE_TEMPORARY_CAPABILITY];
  }

  async getStatusFor(subject: string): Promise<EndpointProbeTemporaryGrantView> {
    const row = await this.store.getGrant(subject, ENDPOINT_PROBE_TEMPORARY_CAPABILITY);
    const permanentActive = (await this.store.countPermanent(subject, ENDPOINT_PROBE_TEMPORARY_CAPABILITY)) > 0;
    return projectView({ subject, row, permanentActive, now: this.now() });
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
    const key = input.idempotencyKey?.trim() ?? "";
    if (key.length === 0) throw idempotencyRequired();

    // 持久幂等：同键请求一旦落库，之后只返回当前状态，不再写 not_after。
    const replay = await this.replayRecorded(grantee, key, "grant");
    if (replay) return replay;

    const now = this.now();
    const row = await this.store.getGrant(grantee, ENDPOINT_PROBE_TEMPORARY_CAPABILITY);
    const current = row ? projectView({ subject: grantee, row, permanentActive: false, now }) : null;

    if (current && current.status === "active") {
      // 有效期内的新请求也不续期；只登记请求标识，便于后续重放判定。
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) throw versionConflict();
      try {
        await this.store.recordRequest({
          subject: grantee,
          capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
          idempotencyKey: key,
          operation: "grant",
          resultVersion: current.version ?? undefined,
          resultNotAfter: current.notAfter ? new Date(current.notAfter) : undefined,
        });
      } catch (cause) {
        if (!(cause instanceof TemporaryGrantWriteConflictError)) throw cause;
        const recorded = await this.replayRecorded(grantee, key, "grant");
        if (!recorded) throw versionConflict();
        return recorded;
      }
      return this.getStatusFor(grantee);
    }

    if (current) {
      // 撤回/过期后的重新授予是新的明确授权：必须有当前版本和新的请求标识。
      if (input.expectedVersion === undefined) throw expectedVersionRequired();
      if (input.expectedVersion !== current.version) throw versionConflict();
    } else if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
      throw versionConflict();
    }

    const expectedVersion = current?.version ?? 0;
    const nextVersion = expectedVersion + 1;
    const grantedAt = new Date(now);
    const notAfter = new Date(now + ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS);
    try {
      await this.store.activate({
        subject: grantee,
        capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
        grantor,
        grantedAt,
        notAfter,
        expectedVersion,
        nextVersion,
        reason: input.reason,
        idempotencyKey: key,
      });
    } catch (cause) {
      if (!(cause instanceof TemporaryGrantWriteConflictError)) throw cause;
      const recorded = await this.replayRecorded(grantee, key, "grant");
      if (recorded) return recorded;
      throw versionConflict();
    }
    return this.getStatusFor(grantee);
  }

  async revoke(input: Readonly<{
    actorSubject: string;
    reason?: string;
    expectedVersion?: number;
    idempotencyKey?: string;
  }>): Promise<EndpointProbeTemporaryGrantView> {
    const { grantor, grantee } = assertTemporaryGrantConfigured();
    if (input.actorSubject !== grantor) {
      throw new HttpError(403, "endpoint-probe-temporary-grant-forbidden", "当前主体不能撤回探针临时能力");
    }
    const key = input.idempotencyKey?.trim() || undefined;

    if (key) {
      const replay = await this.replayRecorded(grantee, key, "revoke");
      if (replay) return replay;
    }

    const now = this.now();
    const row = await this.store.getGrant(grantee, ENDPOINT_PROBE_TEMPORARY_CAPABILITY);
    if (!row) {
      if (key) {
        try {
          await this.store.recordRequest({
            subject: grantee,
            capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
            idempotencyKey: key,
            operation: "revoke",
          });
        } catch (cause) {
          if (!(cause instanceof TemporaryGrantWriteConflictError)) throw cause;
          const recorded = await this.replayRecorded(grantee, key, "revoke");
          if (!recorded) throw versionConflict();
          return recorded;
        }
      }
      // 没有临时行也要如实报告永久能力，不能直接写 permanentActive=false。
      return this.getStatusFor(grantee);
    }

    const current = projectView({ subject: grantee, row, permanentActive: false, now });
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      if (current.status === "revoked") return this.getStatusFor(grantee);
      throw versionConflict();
    }
    if (current.status === "revoked") {
      if (key) {
        try {
          await this.store.recordRequest({
            subject: grantee,
            capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
            idempotencyKey: key,
            operation: "revoke",
            resultVersion: current.version ?? undefined,
          });
        } catch (cause) {
          if (!(cause instanceof TemporaryGrantWriteConflictError)) throw cause;
          const recorded = await this.replayRecorded(grantee, key, "revoke");
          if (!recorded) throw versionConflict();
          return recorded;
        }
      }
      return this.getStatusFor(grantee);
    }

    const nextVersion = (current.version ?? 0) + 1;
    try {
      await this.store.revoke({
        subject: grantee,
        capability: ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
        actor: input.actorSubject,
        revokedAt: new Date(now),
        expectedVersion: input.expectedVersion,
        nextVersion,
        reason: input.reason,
        idempotencyKey: key,
      });
    } catch (cause) {
      if (!(cause instanceof TemporaryGrantWriteConflictError)) throw cause;
      if (key) {
        const recorded = await this.replayRecorded(grantee, key, "revoke");
        if (recorded) return recorded;
      }
      const latest = await this.store.getGrant(grantee, ENDPOINT_PROBE_TEMPORARY_CAPABILITY);
      if (latest && latest.status === "revoked") return this.getStatusFor(grantee);
      throw versionConflict();
    }
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
