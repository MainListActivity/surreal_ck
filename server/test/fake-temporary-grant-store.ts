import {
  ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
  TemporaryGrantWriteConflictError,
  type TemporaryGrantActivateInput,
  type TemporaryGrantRecordRequestInput,
  type TemporaryGrantRevokeInput,
  type TemporaryGrantStore,
} from "../src/ops/endpoint-probe-temporary-grant";

export type FakeGrantRow = {
  id: string;
  subject: string;
  capability: string;
  status: "active" | "revoked";
  granted_by_subject: string;
  granted_at: Date;
  not_after: Date;
  revoked_at?: Date;
  revoked_by_subject?: string;
  grant_reason?: string;
  revoke_reason?: string;
  version: number;
};

export type FakeRequestRow = {
  subject: string;
  capability: string;
  idempotency_key: string;
  operation: "grant" | "revoke";
  result_version?: number;
  result_not_after?: Date;
};

/**
 * 内存临时授权存储。用于不启动公司 fork 的单测/路由测。
 * 写入语义与 SurrealTemporaryGrantStore 保持一致：版本 CAS、同键唯一、冲突抛错。
 */
export class FakeTemporaryGrantStore implements TemporaryGrantStore {
  readonly activeOperators = new Set<string>();
  readonly grants = new Map<string, FakeGrantRow>();
  readonly requests = new Map<string, FakeRequestRow>();
  readonly permanent = new Map<string, Set<string>>();
  private sequence = 1;

  private grantKey(subject: string, capability: string): string {
    return `${subject}\u0000${capability}`;
  }

  private requestKey(subject: string, capability: string, key: string): string {
    return `${subject}\u0000${capability}\u0000${key}`;
  }

  seedOperator(subject: string): void {
    this.activeOperators.add(subject);
  }

  disableOperator(subject: string): void {
    this.activeOperators.delete(subject);
  }

  seedPermanent(subject: string, capabilities: readonly string[]): void {
    this.permanent.set(subject, new Set(capabilities));
  }

  getGrantRow(subject: string): FakeGrantRow | undefined {
    return this.grants.get(this.grantKey(subject, ENDPOINT_PROBE_TEMPORARY_CAPABILITY));
  }

  async isActiveOperator(subject: string): Promise<boolean> {
    return this.activeOperators.has(subject);
  }

  async getGrant(subject: string, capability: string): Promise<Record<string, unknown> | null> {
    return this.grants.get(this.grantKey(subject, capability)) ?? null;
  }

  async getRequest(
    subject: string,
    capability: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown> | null> {
    return this.requests.get(this.requestKey(subject, capability, idempotencyKey)) ?? null;
  }

  async countPermanent(subject: string, capability: string): Promise<number> {
    return this.permanent.get(subject)?.has(capability) ? 1 : 0;
  }

  async activate(input: TemporaryGrantActivateInput): Promise<void> {
    const key = this.requestKey(input.subject, input.capability, input.idempotencyKey);
    if (this.requests.has(key)) throw new TemporaryGrantWriteConflictError("duplicate request key");
    const existingKey = this.grantKey(input.subject, input.capability);
    const existing = this.grants.get(existingKey);
    if (input.expectedVersion === 0) {
      if (existing) throw new TemporaryGrantWriteConflictError("concurrent insert");
      this.grants.set(existingKey, {
        id: `platform_operator_temporary_grant:${this.sequence++}`,
        subject: input.subject,
        capability: input.capability,
        status: "active",
        granted_by_subject: input.grantor,
        granted_at: input.grantedAt,
        not_after: input.notAfter,
        grant_reason: input.reason,
        version: input.nextVersion,
      });
    } else {
      if (!existing || existing.version !== input.expectedVersion) {
        throw new TemporaryGrantWriteConflictError("version mismatch");
      }
      this.grants.set(existingKey, {
        ...existing,
        status: "active",
        granted_by_subject: input.grantor,
        granted_at: input.grantedAt,
        not_after: input.notAfter,
        revoked_at: undefined,
        revoked_by_subject: undefined,
        grant_reason: input.reason,
        revoke_reason: undefined,
        version: input.nextVersion,
      });
    }
    this.requests.set(key, {
      subject: input.subject,
      capability: input.capability,
      idempotency_key: input.idempotencyKey,
      operation: "grant",
      result_version: input.nextVersion,
      result_not_after: input.notAfter,
    });
  }

  async revoke(input: TemporaryGrantRevokeInput): Promise<void> {
    if (input.idempotencyKey) {
      const key = this.requestKey(input.subject, input.capability, input.idempotencyKey);
      if (this.requests.has(key)) throw new TemporaryGrantWriteConflictError("duplicate request key");
    }
    const existingKey = this.grantKey(input.subject, input.capability);
    const existing = this.grants.get(existingKey);
    if (!existing) throw new TemporaryGrantWriteConflictError("missing grant");
    if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new TemporaryGrantWriteConflictError("version mismatch");
    }
    if (existing.status !== "active") throw new TemporaryGrantWriteConflictError("already revoked");
    this.grants.set(existingKey, {
      ...existing,
      status: "revoked",
      revoked_at: input.revokedAt,
      revoked_by_subject: input.actor,
      revoke_reason: input.reason,
      version: input.nextVersion,
    });
    if (input.idempotencyKey) {
      this.requests.set(this.requestKey(input.subject, input.capability, input.idempotencyKey), {
        subject: input.subject,
        capability: input.capability,
        idempotency_key: input.idempotencyKey,
        operation: "revoke",
        result_version: input.nextVersion,
      });
    }
  }

  async recordRequest(input: TemporaryGrantRecordRequestInput): Promise<void> {
    const key = this.requestKey(input.subject, input.capability, input.idempotencyKey);
    if (this.requests.has(key)) throw new TemporaryGrantWriteConflictError("duplicate request key");
    this.requests.set(key, {
      subject: input.subject,
      capability: input.capability,
      idempotency_key: input.idempotencyKey,
      operation: input.operation,
      result_version: input.resultVersion,
      result_not_after: input.resultNotAfter,
    });
  }
}
