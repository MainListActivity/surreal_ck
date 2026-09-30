/**
 * LCA06 受控研究窗口：服务端为调用者开设的 content_reader 会话。
 *
 * 复用 LCA04 的 search exchange（成员索引 → 权益快照 → 目录投影 → IdP 换票），
 * 但租约 token 不回传浏览器，而是服务端自持：AI 执行窗口用它与 workspace 会话并行
 * 读取当前获授权语料。窗口绑定调用者身份与权益修订，超出租约即失效（fail closed）。
 * 打开失败一律解释为 unavailable，不向上抛原始错误（不泄漏投影/IdP 细节）。
 */
import { Surreal } from "surrealdb";
import type { ContentReaderError, SessionUser } from "@surreal-ck/shared";
import { env } from "../env";
import { createContentSearchExchangeHandler } from "../content/search-exchange";

export type ContentResearchWindowReady = {
  kind: "ready";
  /** content_reader RECORD 会话：数据库层按 gate 强制授权，查询不到授权外内容。 */
  session: Pick<Surreal, "query">;
  namespace: string;
  database: string;
  /** 权益修订（证据登记绑定用）。 */
  entitlementRevision: string;
  digest: string;
  leaseEndSeconds: number;
  /** 窗口关闭：丢弃会话；投影随 confirmed_until 到期自动失效。 */
  close(): Promise<void>;
};

export type ContentResearchWindow =
  | ContentResearchWindowReady
  | { kind: "empty" }
  | { kind: "unavailable"; reason: ContentReaderError | "platform_error" };

export type ContentResearchSessionFactory = (caller: SessionUser) => Promise<ContentResearchWindow>;

export type ContentResearchSessionFactoryDeps = {
  searchExchange?: ReturnType<typeof createContentSearchExchangeHandler>;
  /** 测试注入：替代真实 Surreal 会话（默认 new Surreal()）。 */
  openSession?: () => Pick<Surreal, "connect" | "authenticate" | "close" | "query">;
};

export function createContentResearchSessionFactory(
  deps: ContentResearchSessionFactoryDeps = {},
): ContentResearchSessionFactory {
  const searchExchange = deps.searchExchange ?? createContentSearchExchangeHandler();
  const openSession = deps.openSession ?? (() => new Surreal());
  return async (caller: SessionUser): Promise<ContentResearchWindow> => {
    let exchange: Awaited<ReturnType<typeof searchExchange>>;
    try {
      exchange = await searchExchange(caller, {});
    } catch {
      return { kind: "unavailable", reason: "platform_error" };
    }
    if ("ok" in exchange) {
      // not_member/entitlement_absent/action_denied 等都归一为不可用；
      // 具体原因不进入模型上下文，也不进入诊断日志。
      return { kind: "unavailable", reason: exchange.ok === false ? exchange.error : "platform_error" };
    }
    if (exchange.status === "empty") return { kind: "empty" };

    const session = openSession();
    try {
      await session.connect(env.SURREAL_URL, {
        namespace: exchange.namespace,
        database: exchange.database,
      });
      await session.authenticate(exchange.accessToken);
    } catch {
      await closeQuietly(session);
      return { kind: "unavailable", reason: "platform_error" };
    }
    return {
      kind: "ready",
      session,
      namespace: exchange.namespace,
      database: exchange.database,
      entitlementRevision: exchange.entitlementRevision,
      digest: exchange.digest,
      leaseEndSeconds: exchange.leaseEndSeconds,
      close: () => closeQuietly(session),
    } satisfies ContentResearchWindowReady;
  };
}

async function closeQuietly(session: { close?: () => Promise<unknown> }): Promise<void> {
  try {
    await session.close?.();
  } catch {
    // 关闭失败不影响窗口语义：租约到期自然失效。
  }
}
