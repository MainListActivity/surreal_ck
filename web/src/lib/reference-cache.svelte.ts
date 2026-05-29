import type { RecordIdString, ReferenceTargetPreview } from "@surreal-ck/shared/rpc.types";
import { getSurreal } from "./surreal";
import { isLikelyRecordId, resolveReferences } from "./reference-cache";

export { collectReferenceIdsFromValues } from "./reference-cache";

/**
 * 引用展示值缓存（runes）。批量 + 节流地调用纯 {@link resolveReferences}（直连 SurrealDB），
 * 把结果镜像进 `$state.entries` 供 ReferenceCell / ReferenceCard / RecordPicker 响应式读取。
 *
 * 解析逻辑本身在 reference-cache.ts（已单测）；这里只管缓存策略与 runes 响应式。
 */
type CacheState = {
  /** id → preview。null 占位符表示「正在请求中」，避免重复发起。 */
  entries: Record<RecordIdString, ReferenceTargetPreview | null>;
};

function createReferenceCache() {
  const state = $state<CacheState>({ entries: {} });
  /** 节流：把短时间内的多次 ensure 合并成一个请求。 */
  let pendingIds = new Set<RecordIdString>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    flushTimer = null;
    if (pendingIds.size === 0) return;
    const batch = Array.from(pendingIds);
    pendingIds = new Set();

    // 占位 null 表示「请求中」。
    const next = { ...state.entries };
    for (const id of batch) {
      if (next[id] === undefined) next[id] = null;
    }
    state.entries = next;

    try {
      const items = await resolveReferences(getSurreal(), batch);
      const merged = { ...state.entries };
      for (const item of items) {
        merged[item.id] = item;
      }
      // resolveReferences 已对查不到的 id 返回 missing 占位，这里直接合并即可。
      state.entries = merged;
    } catch {
      // 失败时把占位清除，下次还可重试。
      const cleared = { ...state.entries };
      for (const id of batch) {
        if (cleared[id] === null) delete cleared[id];
      }
      state.entries = cleared;
    }
  }

  function ensure(ids: Iterable<RecordIdString>): void {
    let added = false;
    for (const id of ids) {
      if (typeof id !== "string" || !isLikelyRecordId(id)) continue;
      if (state.entries[id] !== undefined) continue; // 已缓存或请求中
      if (pendingIds.has(id)) continue;
      pendingIds.add(id);
      added = true;
    }
    if (!added) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 30);
  }

  function get(id: RecordIdString | null | undefined): ReferenceTargetPreview | null | undefined {
    if (!id) return undefined;
    return state.entries[id];
  }

  /** 上层修改了某条引用记录后调用，强制下次重新请求。 */
  function invalidate(id: RecordIdString): void {
    if (state.entries[id] === undefined) return;
    const next = { ...state.entries };
    delete next[id];
    state.entries = next;
  }

  return {
    ensure,
    get,
    invalidate,
    get entries() { return state.entries; },
  };
}

export const referenceCache = createReferenceCache();
