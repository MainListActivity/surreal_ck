import { describe, expect, test } from "bun:test";
import type { NativeQuotaInfo } from "@surreal-ck/shared/native-quota";
import { StringRecordId } from "surrealdb";
import type { NativeQuotaClient } from "../db/native-quota/client";
import { SurrealQuotaOperatorMaintenance } from "./operator-maintenance";
import type {
  QuotaAuthorityReader,
  QuotaObservationSink,
} from "./quota-read-service";

const nativeInfo: NativeQuotaInfo = {
  database: "ws_demo",
  format_version: 1,
  latest_change: null,
  ledger: { active_epoch: 2, state: "ready", usage_trusted: true },
  observed_at: "2026-07-29T12:00:00.000Z",
  policy: null,
  usage: {
    table_buckets: [],
    tables: [],
    unmatched: { table: [], field: [], record: [] },
  },
};

describe("SurrealQuotaOperatorMaintenance", () => {
  test("rebuild is root-side and persists only fresh INFO observation", async () => {
    const calls: string[] = [];
    const reader: QuotaAuthorityReader = {
      async findWorkspaceAuthority({ slug, actor }) {
        calls.push(`authority:${slug}:${actor.subject}`);
        return {
          workspace: {
            record: "workspace:demo",
            slug: "demo",
            name: "Demo",
            database: "ws_demo",
          },
          operatorCapabilities: ["quota.read", "ledger.rebuild"],
          runtime: {
            sync: "in_sync",
            compliance: "compliant",
            capacity: "normal",
            serviceMode: "standard",
            ledger: "corrupt",
            usageTrusted: false,
            autoReconcile: true,
            updatedAt: "2026-07-29T11:00:00.000Z",
          },
          commercialStateAt: "2026-07-29T11:00:00.000Z",
        };
      },
      async findBillingAuthority() {
        return null;
      },
    };
    const native: NativeQuotaClient = {
      async rebuild(database) {
        calls.push(`rebuild:${database}`);
        return {
          operation_id: "rebuild-1",
          operation: "rebuild_quota",
          database,
          previous_generation: null,
          generation: null,
          changed: true,
        };
      },
      async info(database) {
        calls.push(`info:${database}`);
        return nativeInfo;
      },
      async applyPolicy() {
        throw new Error("not used");
      },
    };
    const observations: QuotaObservationSink = {
      async observe({ info }) {
        calls.push(`observe:${info.ledger.state}`);
      },
    };
    const service = new SurrealQuotaOperatorMaintenance(
      {
        async query(_sql, params) {
          expect(params?.workspace).toEqual(
            new StringRecordId("workspace:demo"),
          );
          return [["demo"]];
        },
      },
      reader,
      native,
      observations,
    );

    await service.rebuildLedger({
      workspace: new StringRecordId("workspace:demo"),
      actorSubject: "operator:alice",
    });
    expect(calls).toEqual([
      "authority:demo:operator:alice",
      "rebuild:ws_demo",
      "info:ws_demo",
      "observe:ready",
    ]);
  });
});
