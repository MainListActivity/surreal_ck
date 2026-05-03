import { appApi } from "./app-api";
import type { RecordIdString, ReferenceTargetPreview } from "../../shared/rpc.types";

type CacheState = {
  /** id → preview。null 占位符表示「正在请求中」，避免重复发起。 */
  entries: Record<RecordIdString, ReferenceTargetPreview | null>;
};

function isLikelyRecordId(value: string): boolean {
  const colon = value.indexOf(":");
  return colon > 0 && colon < value.length - 1;
}

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
      const res = await appApi.resolveReferences(batch);
      if (!res.ok) {
        // 失败时把占位清除，下次还可重试。
        const cleared = { ...state.entries };
        for (const id of batch) {
          if (cleared[id] === null) delete cleared[id];
        }
        state.entries = cleared;
        return;
      }
      const merged = { ...state.entries };
      const seen = new Set<string>();
      for (const item of res.data.items) {
        merged[item.id] = item;
        seen.add(item.id);
      }
      // 后端没返回的 id（无权限或不存在）：留下占位 missing。
      for (const id of batch) {
        if (!seen.has(id)) {
          merged[id] = {
            id,
            table: id.slice(0, id.indexOf(":")),
            primaryLabel: "已删除的记录",
            missing: true,
            preview: [],
          };
        }
      }
      state.entries = merged;
    } catch {
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

/** 给一行的 values 提取出所有 reference 列对应的 RecordId 字符串，扁平化数组。 */
export function collectReferenceIdsFromValues(
  values: Record<string, unknown>,
  referenceKeys: string[],
): RecordIdString[] {
  const out: RecordIdString[] = [];
  for (const key of referenceKeys) {
    const v = values[key];
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string") out.push(item);
    } else if (typeof v === "string") {
      out.push(v);
    }
  }
  return out;
}
