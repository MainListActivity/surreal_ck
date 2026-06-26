import { getSurreal } from "./surreal";
import {
  aggregateActivity,
  loadActivityRows,
  normalizeRow,
  type ActivityEventRow,
  type ActivityFeedItem,
} from "./activity-feed";

/**
 * Reactive 首页动态 store。读取 / 聚合逻辑在 activity-feed.ts（已单测）；这里只管
 * runes 响应式 + LIVE 订阅生命周期 + actor 显示名映射。
 *
 * 写入由引擎层 DEFINE EVENT 负责（HR-14/15），前端零写。LIVE 订阅把新事件插到行表头，
 * 重新聚合后镜像进 $state，动态 tab 即时刷新。
 */

type UserLite = { id: string; displayName: string };

type FeedState = {
  loading: boolean;
  /** 原始行（created_at DESC），LIVE CREATE 插表头；聚合在 derived 里做。 */
  rows: ActivityEventRow[];
  /** actor user id → 显示名。 */
  users: Record<string, string>;
};

function createActivityFeed() {
  const state = $state<FeedState>({ loading: false, rows: [], users: {} });
  let unsub: (() => void) | null = null;
  let started = false;

  const items = $derived(aggregateActivity(state.rows));

  async function loadUsers(): Promise<void> {
    try {
      const rows = await getSurreal().query<Record<string, unknown>>(
        "SELECT id, display_name, email, kind FROM user",
      );
      const map: Record<string, string> = {};
      for (const r of rows) {
        const id = String(r.id);
        const name =
          (typeof r.display_name === "string" && r.display_name) ||
          (typeof r.email === "string" && r.email) ||
          (r.kind === "virtual" ? "AI 助手" : "未知用户");
        map[id] = name;
      }
      state.users = map;
    } catch {
      // 显示名解析失败不阻断动态：actorName 回退到 actorId。
    }
  }

  async function load(): Promise<void> {
    state.loading = true;
    try {
      await loadUsers();
      state.rows = await loadActivityRows(getSurreal(), 50);
    } catch {
      state.rows = [];
    } finally {
      state.loading = false;
    }
  }

  /** 初次进入「动态」tab 时调用：load 一次 + 起 LIVE 订阅（幂等，重复调用只起一次）。 */
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await load();
    try {
      unsub = await getSurreal().liveTable<Record<string, unknown>>("activity_event", (msg) => {
        if (msg.action === "CREATE") {
          const row = normalizeRow(msg.value);
          state.rows = [row, ...state.rows].slice(0, 50);
          // 新 actor 没在映射里就补一次（如新成员产生的动态）。
          if (row.actor && state.users[row.actor] === undefined) void loadUsers();
        } else if (msg.action === "DELETE") {
          const id = String(msg.value?.id ?? "");
          state.rows = state.rows.filter((r) => r.id !== id);
        }
      });
    } catch {
      // LIVE 起不来不致命：load 已经有初始数据，只是不实时。
    }
  }

  /** 组件卸载时调用，退订 LIVE。 */
  function stop(): void {
    unsub?.();
    unsub = null;
    started = false;
  }

  function actorName(item: ActivityFeedItem): string {
    if (!item.actorId) return "系统";
    return state.users[item.actorId] ?? item.actorId;
  }

  return {
    get loading(): boolean { return state.loading; },
    get items(): ActivityFeedItem[] { return items; },
    start,
    stop,
    actorName,
  };
}

export const activityFeed = createActivityFeed();
export type { UserLite };
