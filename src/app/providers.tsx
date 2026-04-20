/**
 * 应用全局 Provider（local-first 版本）
 *
 * 移除了 OIDC 认证流程，本地模式下身份由 Bun 主进程通过 IPC 提供。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { SurrealProvider } from "../lib/surreal/provider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // local-first：数据始终本地可用，不需要 stale 自动重新获取
      staleTime: 5 * 60 * 1_000,
      retry: 1,
    },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SurrealProvider>{children}</SurrealProvider>
    </QueryClientProvider>
  );
}
