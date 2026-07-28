import { describe, expect, test } from "bun:test";
import type { NativeQuotaInfo } from "@surreal-ck/shared/native-quota";
import {
  QuotaInfoCache,
  QuotaRefreshRateLimitError,
} from "./quota-info-cache";

function info(observedAt: string): NativeQuotaInfo {
  return {
    database: "ws_demo",
    format_version: 1,
    latest_change: null,
    ledger: { active_epoch: 1, state: "ready", usage_trusted: true },
    observed_at: observedAt,
    policy: null,
    usage: {
      table_buckets: [],
      tables: [],
      unmatched: { table: [], field: [], record: [] },
    },
  };
}

describe("QuotaInfoCache", () => {
  test("caches INFO for 15 seconds", async () => {
    let now = 1_000;
    let calls = 0;
    const cache = new QuotaInfoCache({ now: () => now });
    const load = async () => {
      calls += 1;
      return info(`2026-07-28T00:00:0${calls}.000Z`);
    };

    const first = await cache.get({
      database: "ws_demo",
      actorSubject: "alice",
      load,
    });
    now += 14_999;
    const cached = await cache.get({
      database: "ws_demo",
      actorSubject: "bob",
      load,
    });
    now += 2;
    const expired = await cache.get({
      database: "ws_demo",
      actorSubject: "bob",
      load,
    });

    expect(first.fromCache).toBe(false);
    expect(cached.fromCache).toBe(true);
    expect(cached.cacheAgeMs).toBe(14_999);
    expect(expired.fromCache).toBe(false);
    expect(calls).toBe(2);
  });

  test("merges concurrent requests for the same database", async () => {
    let resolve!: (value: NativeQuotaInfo) => void;
    let calls = 0;
    const pending = new Promise<NativeQuotaInfo>((done) => {
      resolve = done;
    });
    const cache = new QuotaInfoCache();
    const load = async () => {
      calls += 1;
      return pending;
    };

    const first = cache.get({
      database: "ws_demo",
      actorSubject: "alice",
      load,
    });
    const second = cache.get({
      database: "ws_demo",
      actorSubject: "bob",
      force: true,
      load,
    });
    resolve(info("2026-07-28T00:00:00.000Z"));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls).toBe(1);
  });

  test("force refresh bypasses cache but is rate limited per actor and database", async () => {
    let now = 10_000;
    let calls = 0;
    const cache = new QuotaInfoCache({ now: () => now });
    const load = async () => {
      calls += 1;
      return info("2026-07-28T00:00:00.000Z");
    };

    await cache.get({
      database: "ws_demo",
      actorSubject: "alice",
      force: true,
      load,
    });

    const rejected = cache.get({
      database: "ws_demo",
      actorSubject: "alice",
      force: true,
      load,
    });
    await expect(rejected).rejects.toBeInstanceOf(QuotaRefreshRateLimitError);

    await cache.get({
      database: "ws_demo",
      actorSubject: "bob",
      force: true,
      load,
    });
    now += 10_000;
    await cache.get({
      database: "ws_demo",
      actorSubject: "alice",
      force: true,
      load,
    });
    expect(calls).toBe(3);
  });
});
