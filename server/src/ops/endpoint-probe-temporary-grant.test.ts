import { describe, expect, test } from "bun:test";
import { overrideEnv } from "../env";
import {
  ENDPOINT_PROBE_TEMPORARY_CAPABILITY,
  ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS,
  EndpointProbeTemporaryGrantService,
  mergeTemporaryCapabilities,
} from "./endpoint-probe-temporary-grant";

type Row = Record<string, unknown>;

class MemoryDb {
  private grant: Row | null = null;
  private permanent = new Map<string, Set<string>>();
  queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];

  seedPermanent(subject: string, capabilities: string[]) {
    this.permanent.set(subject, new Set(capabilities));
  }

  async query(sql: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.queries.push({ sql, params });
    const text = sql.replace(/\s+/g, " ");

    if (text.includes("FROM platform_operator_temporary_grant") && text.includes("SELECT capability, status, not_after")) {
      if (!this.grant || this.grant.subject !== params.subject) return [[]];
      return [[this.grant]];
    }

    if (text.includes("FROM platform_operator_temporary_grant") && text.includes("SELECT *")) {
      // status query may be followed by permanent count in the same script.
      const grantRows = !this.grant || this.grant.subject !== params.subject ? [] : [this.grant];
      if (text.includes("FROM platform_operator_capability")) {
        const caps = this.permanent.get(String(params.subject)) ?? new Set();
        const count = caps.has(String(params.capability)) ? 1 : 0;
        return [grantRows, [count]];
      }
      return [grantRows];
    }

    if (text.includes("INSERT INTO platform_operator_temporary_grant")) {
      this.grant = {
        id: "platform_operator_temporary_grant:1",
        subject: params.subject,
        capability: params.capability,
        status: "active",
        granted_by_subject: params.grantor,
        granted_at: params.grantedAt,
        not_after: params.notAfter,
        grant_reason: params.reason,
        version: 1,
      };
      return [[{ id: this.grant.id }]];
    }

    if (text.includes("UPDATE $id SET") && text.includes('status = "active"')) {
      if (!this.grant) throw new Error("missing grant");
      this.grant = {
        ...this.grant,
        status: "active",
        granted_by_subject: params.grantor,
        granted_at: params.grantedAt,
        not_after: params.notAfter,
        revoked_at: undefined,
        revoked_by_subject: undefined,
        grant_reason: params.reason,
        revoke_reason: undefined,
        version: params.version,
      };
      return [[{ id: this.grant.id }]];
    }

    if (text.includes("UPDATE $id SET") && text.includes('status = "revoked"')) {
      if (!this.grant) throw new Error("missing grant");
      this.grant = {
        ...this.grant,
        status: "revoked",
        revoked_at: params.revokedAt,
        revoked_by_subject: params.actor,
        revoke_reason: params.reason,
        version: params.version,
      };
      return [[{ id: this.grant.id }]];
    }

    throw new Error(`unexpected sql: ${text}`);
  }
}

describe("endpoint probe temporary grant service", () => {
  const GRANTOR = "grantor-subject";
  const GRANTEE = "26dba3a6-4392-4840-a856-264d6f07fbee";

  function service(db: MemoryDb, now: () => number) {
    overrideEnv({
      ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT: GRANTOR,
      ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: GRANTEE,
    } as never);
    return new EndpointProbeTemporaryGrantService(async () => db, "main", now);
  }

  test("mergeTemporaryCapabilities 去重并排序，不删除永久能力", () => {
    expect(mergeTemporaryCapabilities(
      ["quota.read", "subscription.manage"],
      [ENDPOINT_PROBE_TEMPORARY_CAPABILITY, "quota.read"],
    )).toEqual(["internal-ai.endpoint-probe", "quota.read", "subscription.manage"]);
  });

  test("单主体授予后有效，其它主体读不到临时能力；重放不续期", async () => {
    const db = new MemoryDb();
    let now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(db, () => now);

    const first = await svc.grant({ actorSubject: GRANTOR, reason: "fv06-once" });
    expect(first.status).toBe("active");
    expect(first.notAfter).toBe(new Date(now + ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS).toISOString());
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
    expect(await svc.activeCapabilitiesFor("other-subject")).toEqual([]);

    const replay = await svc.grant({ actorSubject: GRANTOR, reason: "fv06-once" });
    expect(replay.notAfter).toBe(first.notAfter);
    expect(replay.version).toBe(first.version);
  });

  test("越权授予与自授拒绝；未配置时 503", async () => {
    const db = new MemoryDb();
    const svc = service(db, () => Date.parse("2026-11-02T08:00:00.000Z"));
    await expect(svc.grant({ actorSubject: "stranger" })).rejects.toMatchObject({ status: 403, code: "endpoint-probe-temporary-grant-forbidden" });

    overrideEnv({
      ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT: GRANTOR,
      ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: GRANTOR,
    } as never);
    const misconfigured = new EndpointProbeTemporaryGrantService(async () => db, "main", () => Date.now());
    await expect(misconfigured.grant({ actorSubject: GRANTOR })).rejects.toMatchObject({ status: 503, code: "endpoint-probe-temporary-grant-misconfigured" });

    overrideEnv({
      ENDPOINT_PROBE_TEMPORARY_GRANTOR_SUBJECT: undefined,
      ENDPOINT_PROBE_TEMPORARY_GRANTEE_SUBJECT: undefined,
    } as never);
    const missing = new EndpointProbeTemporaryGrantService(async () => db, "main", () => Date.now());
    await expect(missing.grant({ actorSubject: GRANTOR })).rejects.toMatchObject({ status: 503, code: "endpoint-probe-temporary-grant-not-configured" });
  });

  test("30 分钟界限：到期后 activeCapabilities 立即为空；状态读为 expired", async () => {
    const db = new MemoryDb();
    let now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(db, () => now);
    await svc.grant({ actorSubject: GRANTOR });
    now += ENDPOINT_PROBE_TEMPORARY_GRANT_MAX_MS;
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([]);
    const status = await svc.getStatusFor(GRANTEE);
    expect(status.status).toBe("expired");
  });

  test("手动撤回后旧会话读面失效；永久能力保留并报告", async () => {
    const db = new MemoryDb();
    db.seedPermanent(GRANTEE, ["quota.read", ENDPOINT_PROBE_TEMPORARY_CAPABILITY]);
    const now = Date.parse("2026-11-02T08:00:00.000Z");
    const svc = service(db, () => now);
    await svc.grant({ actorSubject: GRANTOR });
    const revoked = await svc.revoke({ actorSubject: GRANTOR, reason: "done" });
    expect(revoked.status).toBe("revoked");
    expect(revoked.permanentActive).toBe(true);
    expect(await svc.activeCapabilitiesFor(GRANTEE)).toEqual([]);
  });

  test("版本冲突保护：expectedVersion 不匹配则 409", async () => {
    const db = new MemoryDb();
    const svc = service(db, () => Date.parse("2026-11-02T08:00:00.000Z"));
    await svc.grant({ actorSubject: GRANTOR });
    await expect(svc.revoke({ actorSubject: GRANTOR, expectedVersion: 99 }))
      .rejects.toMatchObject({ status: 409, code: "endpoint-probe-temporary-grant-version-conflict" });
  });
});
