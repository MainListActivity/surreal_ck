import { describe, expect, test } from "bun:test";
import type { NativeQuotaInfo } from "@surreal-ck/shared/native-quota";
import { DateTime } from "surrealdb";
import type { NativeQuotaClient } from "../db/native-quota/client";
import { SurrealNativeAuditSweepHandler } from "./native-audit-sweep";
import type {
  QuotaAuthorityReader,
  QuotaObservationSink,
  QuotaWorkspaceAuthority,
} from "./quota-read-service";

function authority(slug: string): QuotaWorkspaceAuthority {
  return {
    workspace: {
      record: `workspace:${slug}`,
      slug,
      name: slug,
      database: `ws_${slug}`,
    },
    operatorCapabilities: [],
    runtime: {
      sync: "in_sync",
      serviceMode: "standard",
      compliance: "compliant",
      capacity: "normal",
      ledger: "ready",
      usageTrusted: true,
      autoReconcile: true,
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    commercialStateAt: "2026-07-28T00:00:00.000Z",
  };
}

function info(database: string): NativeQuotaInfo {
  return {
    database,
    format_version: 1,
    latest_change: null,
    ledger: { active_epoch: 1, state: "ready", usage_trusted: true },
    observed_at: "2026-07-28T00:00:00.000Z",
    policy: null,
    usage: {
      table_buckets: [],
      tables: [],
      unmatched: { table: [], field: [], record: [] },
    },
  };
}

describe("SurrealNativeAuditSweepHandler", () => {
  test("audits stale active workspaces through fresh native INFO", async () => {
    let queryParams: Record<string, unknown> | undefined;
    const observed: string[] = [];
    const authorityReader: QuotaAuthorityReader = {
      async findWorkspaceAuthority({ slug }) {
        return authority(slug);
      },
      async findBillingAuthority() {
        return null;
      },
    };
    const native: NativeQuotaClient = {
      async info(database) {
        return info(database);
      },
      async applyPolicy() {
        throw new Error("not used");
      },
      async rebuild() {
        throw new Error("not used");
      },
    };
    const sink: QuotaObservationSink = {
      async observe({ authority }) {
        observed.push(authority.workspace.slug);
      },
    };
    const handler = new SurrealNativeAuditSweepHandler(
      {
        async query(_sql, params) {
          queryParams = params;
          return [[
            { id: "workspace:a", slug: "a" },
            { id: "workspace:b", slug: "b" },
          ]];
        },
      },
      authorityReader,
      native,
      sink,
      {
        clock: {
          now: () => new DateTime("2026-07-28T00:15:00.000Z"),
        },
      },
    );

    await expect(handler.processPage({
      limit: 100,
      fencingToken: 1,
    })).resolves.toEqual({
      nextCursor: "workspace:b",
      completed: true,
      processed: 2,
      failed: 0,
    });
    expect(observed).toEqual(["a", "b"]);
    expect(String(queryParams?.cutoff)).toBe(
      "2026-07-28T00:00:00.000Z",
    );
  });
});
