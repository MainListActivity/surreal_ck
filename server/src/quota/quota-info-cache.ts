import type { NativeQuotaInfo } from "@surreal-ck/shared/native-quota";

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_FORCE_REFRESH_INTERVAL_MS = 10_000;

export type QuotaInfoCacheResult = Readonly<{
  info: NativeQuotaInfo;
  loadedAt: number;
  cacheAgeMs: number;
  fromCache: boolean;
}>;

type CacheEntry = Readonly<{
  info: NativeQuotaInfo;
  loadedAt: number;
  expiresAt: number;
}>;

export class QuotaRefreshRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Quota refresh is rate limited");
    this.name = "QuotaRefreshRateLimitError";
  }
}

export type QuotaInfoCacheOptions = Readonly<{
  ttlMs?: number;
  forceRefreshIntervalMs?: number;
  now?: () => number;
}>;

/**
 * 每 database 合并 INFO 请求并缓存短暂快照。
 * 显式刷新只绕过已完成缓存，不绕过同 database 正在执行的请求。
 */
export class QuotaInfoCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();
  private readonly lastForceRefresh = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly forceRefreshIntervalMs: number;
  private readonly now: () => number;

  constructor(options: QuotaInfoCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.forceRefreshIntervalMs =
      options.forceRefreshIntervalMs ?? DEFAULT_FORCE_REFRESH_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  async get(input: Readonly<{
    database: string;
    actorSubject: string;
    force?: boolean;
    load: () => Promise<NativeQuotaInfo>;
  }>): Promise<QuotaInfoCacheResult> {
    const now = this.now();
    const running = this.inFlight.get(input.database);
    if (running) {
      if (input.force) {
        this.lastForceRefresh.set(
          `${input.actorSubject}\0${input.database}`,
          now,
        );
      }
      const entry = await running;
      return this.result(entry, false);
    }

    if (input.force) {
      const forceKey = `${input.actorSubject}\0${input.database}`;
      const last = this.lastForceRefresh.get(forceKey);
      if (last !== undefined && now - last < this.forceRefreshIntervalMs) {
        throw new QuotaRefreshRateLimitError(
          this.forceRefreshIntervalMs - (now - last),
        );
      }
      this.lastForceRefresh.set(forceKey, now);
    } else {
      const cached = this.entries.get(input.database);
      if (cached && cached.expiresAt > now) {
        return this.result(cached, true);
      }
    }

    const loading = input.load().then((info): CacheEntry => {
      const loadedAt = this.now();
      const entry = {
        info,
        loadedAt,
        expiresAt: loadedAt + this.ttlMs,
      };
      this.entries.set(input.database, entry);
      return entry;
    });
    this.inFlight.set(input.database, loading);

    try {
      return this.result(await loading, false);
    } finally {
      if (this.inFlight.get(input.database) === loading) {
        this.inFlight.delete(input.database);
      }
    }
  }

  invalidate(database: string): void {
    this.entries.delete(database);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.lastForceRefresh.clear();
  }

  private result(entry: CacheEntry, fromCache: boolean): QuotaInfoCacheResult {
    return {
      info: entry.info,
      loadedAt: entry.loadedAt,
      cacheAgeMs: Math.max(0, this.now() - entry.loadedAt),
      fromCache,
    };
  }
}
