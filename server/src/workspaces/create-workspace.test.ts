import { describe, expect, test } from "bun:test";
import { loadTemplateScripts, type WorkspaceTemplateScript } from "@surreal-ck/shared/workspace-template";
import type { TemplatePackScript } from "@surreal-ck/shared/template-packs";
import { NATIVE_QUOTA_EXPECTED_CONTRACT, type NativeQuotaInfo } from "@surreal-ck/shared/native-quota";
import { DateTime, StringRecordId } from "surrealdb";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceCreator,
  type CreateWorkspaceClient,
  type CreateWorkspaceSessionFactory,
} from "./create-workspace";
import type { IdpTokenScopeAdapter } from "./idp-scope-adapter";
import type { SurrealTokenScope } from "./workspace-scope";
import type { NativeQuotaClient } from "../db/native-quota/client";
import type {
  ProvisioningControlPlane,
  ProvisioningWorkspaceRecord,
} from "./provisioning-saga";
import { commercialProductRules, SEEDED_PLAN_LIMITS } from "../db/quota-plan-rules";
import type { EntitlementBaseCandidate } from "../quota/entitlement-resolver";
import { canonicalNativePolicyDigest, compileQuotaPolicy } from "../quota/policy-compiler";

class FakeDb implements CreateWorkspaceClient {
  constructor(
    readonly database: string,
    private readonly state: FakeDbState,
  ) {}

  async query(sql: string, params?: Record<string, unknown>): Promise<any[]> {
    this.state.queries.push({ sql, params, database: this.database });
    const normalized = sql.trim().replace(/\s+/g, " ");

    if (this.state.failOn && this.database === this.state.failOn.database && normalized.includes(this.state.failOn.match)) {
      throw new Error("simulated query failure");
    }

    if (normalized.includes("FROM workspace WHERE slug")) {
      const slug = params?.slug;
      return [this.state.existingSlugs.has(slug as string) ? [{ id: "workspace:existing" }] : []];
    }

    if (normalized.includes("DEFINE DATABASE")) {
      const dbName = readDbNameFromDdl(normalized, "DEFINE DATABASE");
      if (dbName && this.state.physicalDbNames.has(dbName)) {
        throw new Error(`Database ${dbName} already exists`);
      }
      if (dbName) this.state.physicalDbNames.add(dbName);
    }

    if (normalized.includes("REMOVE DATABASE")) {
      const dbName = readDbNameFromDdl(normalized, "REMOVE DATABASE");
      if (dbName) this.state.physicalDbNames.delete(dbName);
    }

    if (normalized.includes("FROM ONLY $workspace") && normalized.includes("workspace_quota_runtime")) {
      return [
        [{
          status: "active",
          desired_entitlement: `resource_entitlement:${this.state.lastDbName}_v1`,
          applied_entitlement: `resource_entitlement:${this.state.lastDbName}_v1`,
          desired_quota_projection: `quota_policy_projection:${this.state.lastDbName}_v1`,
          applied_quota_projection: `quota_policy_projection:${this.state.lastDbName}_v1`,
        }],
        [{
          ledger_state: "ready",
          usage_trusted: true,
          last_native_audit_at: new Date().toISOString(),
        }],
      ];
    }

    if (normalized.includes("workspace_quota_runtime")) {
      return [[{
        ledger_state: "ready",
        usage_trusted: true,
        last_native_audit_at: new Date().toISOString(),
      }]];
    }

    return [[]];
  }
}

type FakeDbState = {
  queries: Array<{ sql: string; params?: Record<string, unknown>; database: string }>;
  requestedSessions: string[];
  existingSlugs: Set<string>;
  existingDbNames: Set<string>;
  physicalDbNames: Set<string>;
  lastDbName: string;
  failOn?: { database: string; match: string };
};

function createFakeDbState(): FakeDbState {
  return {
    queries: [],
    requestedSessions: [],
    existingSlugs: new Set(),
    existingDbNames: new Set(),
    physicalDbNames: new Set(),
    lastDbName: "ws_abcdef123456",
  };
}

function fakeSessionFactory(state: FakeDbState): CreateWorkspaceSessionFactory {
  return async (database) => {
    state.requestedSessions.push(database);
    return new FakeDb(database, state);
  };
}

function readDbNameFromDdl(sql: string, prefix: "DEFINE DATABASE" | "REMOVE DATABASE"): string | null {
  const tail = sql.slice(sql.indexOf(prefix) + prefix.length).trim();
  return tail.match(/^([a-zA-Z0-9_]+)/)?.[1] ?? null;
}

function recordingIdpAdapter(): {
  adapter: IdpTokenScopeAdapter;
  calls: Array<{ subjectToken: string; scope: SurrealTokenScope }>;
} {
  const calls: Array<{ subjectToken: string; scope: SurrealTokenScope }> = [];
  return {
    calls,
    adapter: {
      async updateUserScope(input) {
        calls.push(input);
        return { accessToken: "scoped-token", expiresIn: 3600 };
      },
    },
  };
}

const templateScripts: WorkspaceTemplateScript[] = [
  { version: 1, name: "001-access.surql", sql: "DEFINE ACCESS admin ON DATABASE TYPE JWT URL 'x';" },
  { version: 2, name: "002-tables-core.surql", sql: "DEFINE TABLE user SCHEMAFULL;" },
  { version: 3, name: "003-tables-office.surql", sql: "DEFINE TABLE office_role SCHEMAFULL;" },
];

const selectedTemplatePacks: TemplatePackScript[] = [
  {
    name: "test-pack",
    fileName: "test-pack.surql",
    sql: 'INSERT INTO workbook_template { key: "test-pack" };',
  },
];

function planRevision(planKey = "trial") {
  const rules = commercialProductRules(SEEDED_PLAN_LIMITS.trial);
  return {
    id: new StringRecordId(`quota_plan_revision:${planKey}_v1`),
    template_kind: planKey === "trial" ? ("trial" as const) : ("commercial" as const),
    rules,
  };
}

function createMockControlPlane(state: FakeDbState): ProvisioningControlPlane {
  const stages: string[] = [];
  return {
    stages,
    async reserveWorkspace(input) {
      if (state.existingSlugs.has(input.slug)) return { kind: "slug-conflict" };
      if (state.existingDbNames.has(input.dbName)) return { kind: "db-name-conflict" };
      state.existingSlugs.add(input.slug);
      state.existingDbNames.add(input.dbName);
      state.lastDbName = input.dbName;
      const workspace: ProvisioningWorkspaceRecord = {
        id: new StringRecordId(`workspace:${input.dbName}`),
        dbName: input.dbName,
        slug: input.slug,
        name: input.name,
        ownerSubject: input.ownerSubject,
        status: "provisioning",
        stage: "reserved",
        quotaMigrationState: "not_started",
      };
      return { kind: "reserved", workspace };
    },
    async loadPlan(planKey) {
      if (planKey === "missing") return null;
      const revision = planRevision(planKey);
      return { planRevision: revision, rules: revision.rules };
    },
    async persistResourceSource(input) {
      const subscriptionId = new StringRecordId(`quota_subscription:${input.workspace.dbName}`);
      const candidate: EntitlementBaseCandidate = {
        subscription: {
          id: subscriptionId,
          billing_account: new StringRecordId("billing_account:personal"),
          source: "manual",
          status: input.sourceKind === "trial" ? "trialing" : "active",
          trial_start: input.sourceKind === "trial" ? new DateTime("2026-07-01T00:00:00.000Z") : undefined,
          trial_end: input.sourceKind === "trial" ? new DateTime("2026-08-01T00:00:00.000Z") : undefined,
        },
        item: {
          id: new StringRecordId(`quota_subscription_item:${input.workspace.dbName}`),
          subscription: subscriptionId,
          workspace: input.workspace.id,
          plan_revision: input.planRevision.id,
          status: "active",
          effective_from: new DateTime("2026-07-01T00:00:00.000Z"),
        },
        planRevision: input.planRevision,
      };
      return candidate;
    },
    async persistEntitlementAndProjection(input) {
      return {
        entitlementId: input.entitlement.id,
        projectionId: input.projection.id,
      };
    },
    async markStage(input) {
      stages.push(input.stage);
      if (input.status === "active") stages.push("active");
    },
    async markAppliedFromNative() {},
    async createPhysicalDatabase(dbName) {
      if (state.physicalDbNames.has(dbName)) return { kind: "db-name-conflict" };
      state.physicalDbNames.add(dbName);
      return { kind: "created" };
    },
    async dropPhysicalDatabase(dbName) {
      state.physicalDbNames.delete(dbName);
      state.queries.push({
        sql: `REMOVE DATABASE IF EXISTS ${dbName};`,
        database: "_system",
      });
    },
    async releaseReservation(workspace) {
      state.existingSlugs.delete(workspace.slug);
      state.existingDbNames.delete(workspace.dbName);
    },
  } as ProvisioningControlPlane & { stages: string[] };
}

function createMockNative(planKey = "trial"): NativeQuotaClient {
  const rules = commercialProductRules(SEEDED_PLAN_LIMITS.trial);
  // Build a projection-compatible digest via the real compiler once.
  const entitlement = {
    id: new StringRecordId("resource_entitlement:probe"),
    workspace: new StringRecordId("workspace:probe"),
    revision: 1,
    source_type: "trial" as const,
    plan_revision: new StringRecordId(`quota_plan_revision:${planKey}_v1`),
    service_mode: "standard" as const,
    rules,
    source_digest: "x",
    effective_at: new DateTime("2026-07-01T00:00:00.000Z"),
    resolved_at: new DateTime("2026-07-01T00:00:00.000Z"),
    correlation_id: "probe",
  };
  const compiled = compileQuotaPolicy({
    projection: {
      id: new StringRecordId("quota_policy_projection:probe"),
      revision: 1,
      createdAt: new DateTime("2026-07-01T00:00:00.000Z"),
    },
    entitlement,
  });
  const digest = compiled.projection.canonical_digest;

  return {
    async info(database): Promise<NativeQuotaInfo> {
      return {
        format_version: NATIVE_QUOTA_EXPECTED_CONTRACT.infoFormatVersion,
        database,
        policy: {
          generation: 1,
          rules: compiled.projection.rules,
        },
        ledger: {
          state: "ready",
          usage_trusted: true,
        },
        usage: {
          tables: [],
        },
      } as NativeQuotaInfo;
    },
    async applyPolicy() {
      return {
        format_version: 1,
        operation_id: "op-1",
        outcome: "applied",
        generation: 1,
        digest,
      } as any;
    },
    async rebuild() {
      return {
        format_version: 1,
        operation_id: "rebuild-1",
        outcome: "ready",
      } as any;
    },
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    subject: "user-123",
    subjectToken: "subject-token",
    email: "ada@example.test",
    name: "Acme Legal",
    slug: "acme",
    resourceSource: { planKey: "trial", sourceKind: "trial" as const },
    ...overrides,
  };
}

describe("createWorkspace lifecycle", () => {
  test("requires an explicit resource source", async () => {
    const state = createFakeDbState();
    const { adapter } = recordingIdpAdapter();
    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(state),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      controlPlane: createMockControlPlane(state),
      nativeQuotaClient: createMockNative(),
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    const result = await creator.createWorkspace({
      ...baseInput(),
      resourceSource: { planKey: "" },
    });
    expect(result.kind).toBe("no-resource-source");
  });

  test("新工作区在 native policy 后应用模板脚本", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "surreal-ck-create-workspace-"));
    try {
      await writeFile(join(migrationsDir, "001-base.surql"), "-- base migration", "utf8");
      await writeFile(join(migrationsDir, "002-existing.surql"), "-- existing migration", "utf8");
      await writeFile(join(migrationsDir, "003-auto-discovered.surql"), "-- newly added fixture", "utf8");
      const state = createFakeDbState();
      const { adapter } = recordingIdpAdapter();
      const creator = createWorkspaceCreator({
        getDbSession: fakeSessionFactory(state),
        idpTokenScopeAdapter: adapter,
        loadTemplateScripts: () => loadTemplateScripts({ migrationsDir }),
        controlPlane: createMockControlPlane(state),
        nativeQuotaClient: createMockNative(),
        generateId: () => "abcdef123456",
        namespace: "main",
      });

      const result = await creator.createWorkspace(baseInput());
      expect(result.kind).toBe("created");

      const workspaceQueries = state.queries
        .filter((query) => query.database === "ws_abcdef123456")
        .map((query) => query.sql.trim())
        .filter((sql) => sql.startsWith("--"));
      expect(workspaceQueries.slice(0, 3)).toEqual([
        "-- base migration",
        "-- existing migration",
        "-- newly added fixture",
      ]);
    } finally {
      await rm(migrationsDir, { recursive: true });
    }
  });

  test("通用 schema 完成后播种部署选择的模板包", async () => {
    const state = createFakeDbState();
    const { adapter } = recordingIdpAdapter();
    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(state),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      loadTemplatePackScripts: async () => selectedTemplatePacks,
      controlPlane: createMockControlPlane(state),
      nativeQuotaClient: createMockNative(),
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    await creator.createWorkspace(baseInput());

    const workspaceQueries = state.queries
      .filter((query) => query.database === "ws_abcdef123456")
      .map((query) => query.sql);
    expect(workspaceQueries.indexOf(selectedTemplatePacks[0]!.sql)).toBeGreaterThan(
      workspaceQueries.indexOf(templateScripts.at(-1)!.sql),
    );
  });

  test("模板包失败时进入 provisioning_error 且不签发 scope", async () => {
    const state = createFakeDbState();
    const { adapter, calls } = recordingIdpAdapter();
    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(state),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      loadTemplatePackScripts: async () => {
        throw new Error("unknown template pack: missing-pack");
      },
      controlPlane: createMockControlPlane(state),
      nativeQuotaClient: createMockNative(),
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    const result = await creator.createWorkspace(baseInput());
    expect(result.kind).toBe("provisioning_error");
    expect(calls).toEqual([]);
    // Physical db retained for retry after policy applied
    expect(state.physicalDbNames.has("ws_abcdef123456")).toBe(true);
  });

  test("provisions with native policy before templates, then issues scope only when active", async () => {
    const state = createFakeDbState();
    const { adapter, calls } = recordingIdpAdapter();
    const controlPlane = createMockControlPlane(state);
    let applyOrder: string[] = [];
    const native = createMockNative();
    const wrappedNative: NativeQuotaClient = {
      async info(database) {
        applyOrder.push("info");
        return native.info(database);
      },
      async applyPolicy(input) {
        applyOrder.push("apply");
        return native.applyPolicy(input);
      },
      async rebuild(database) {
        applyOrder.push("rebuild");
        return native.rebuild(database);
      },
    };

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(state),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      controlPlane,
      nativeQuotaClient: wrappedNative,
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    const result = await creator.createWorkspace(baseInput());
    expect(result).toEqual({
      kind: "created",
      slug: "acme",
      dbName: "ws_abcdef123456",
      accessToken: "scoped-token",
      expiresIn: 3600,
    });
    expect(applyOrder[0]).toBe("apply");
    expect(calls).toEqual([
      { subjectToken: "subject-token", scope: { db: "ws_abcdef123456", ac: "admin" } },
    ]);

    const templateIndex = state.queries.findIndex(
      (q) => q.database === "ws_abcdef123456" && q.sql.includes("DEFINE ACCESS"),
    );
    expect(templateIndex).toBeGreaterThan(-1);
  });

  test("returns slug-conflict and never creates a database when slug already exists", async () => {
    const state = createFakeDbState();
    state.existingSlugs.add("acme");
    const { adapter, calls } = recordingIdpAdapter();

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(state),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      controlPlane: createMockControlPlane(state),
      nativeQuotaClient: createMockNative(),
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    const result = await creator.createWorkspace(baseInput());
    expect(result).toEqual({ kind: "slug-conflict" });
    expect(state.physicalDbNames.has("ws_abcdef123456")).toBe(false);
    expect(calls).toEqual([]);
  });

  test("does not drop a pre-existing physical database when generated db name collides", async () => {
    const state = createFakeDbState();
    state.physicalDbNames.add("ws_abcdef123456");
    const { adapter, calls } = recordingIdpAdapter();
    const ids = ["abcdef123456", "fedcba654321"];

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(state),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      controlPlane: createMockControlPlane(state),
      nativeQuotaClient: createMockNative(),
      generateId: () => ids.shift() ?? "unused",
      namespace: "main",
    });

    const result = await creator.createWorkspace(baseInput());
    expect(result).toEqual({
      kind: "created",
      slug: "acme",
      dbName: "ws_fedcba654321",
      accessToken: "scoped-token",
      expiresIn: 3600,
    });
    expect(calls).toEqual([
      { subjectToken: "subject-token", scope: { db: "ws_fedcba654321", ac: "admin" } },
    ]);
  });

  test("returns scope-update-failed and keeps the database when IdP scope update fails", async () => {
    const state = createFakeDbState();
    const failingAdapter: IdpTokenScopeAdapter = {
      async updateUserScope() {
        throw new Error("idp unreachable");
      },
    };

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(state),
      idpTokenScopeAdapter: failingAdapter,
      loadTemplateScripts: async () => templateScripts,
      controlPlane: createMockControlPlane(state),
      nativeQuotaClient: createMockNative(),
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    const result = await creator.createWorkspace(baseInput());
    expect(result).toEqual({
      kind: "scope-update-failed",
      slug: "acme",
      dbName: "ws_abcdef123456",
    });
    expect(state.physicalDbNames.has("ws_abcdef123456")).toBe(true);
  });

  test("policy readback failure never becomes active or issues scope", async () => {
    const state = createFakeDbState();
    const { adapter, calls } = recordingIdpAdapter();
    const native: NativeQuotaClient = {
      async info(database) {
        return {
          format_version: 1,
          database,
          policy: null,
          ledger: { state: "uninitialized", usage_trusted: false },
          usage: null,
        } as any;
      },
      async applyPolicy() {
        return { format_version: 1, operation_id: "x", outcome: "applied" } as any;
      },
      async rebuild() {
        return { format_version: 1, operation_id: "y", outcome: "ready" } as any;
      },
    };

    const creator = createWorkspaceCreator({
      getDbSession: fakeSessionFactory(state),
      idpTokenScopeAdapter: adapter,
      loadTemplateScripts: async () => templateScripts,
      controlPlane: createMockControlPlane(state),
      nativeQuotaClient: native,
      generateId: () => "abcdef123456",
      namespace: "main",
    });

    const result = await creator.createWorkspace(baseInput());
    expect(result.kind).toBe("provisioning_error");
    expect(calls).toEqual([]);
  });
});
