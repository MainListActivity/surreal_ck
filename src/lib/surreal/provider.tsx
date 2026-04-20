/**
 * SurrealProvider（local-first IPC 版本）
 *
 * 在 local-first 架构下，数据库连接由 Bun 主进程持有，
 * React 端通过 IPC 调用数据库操作，不再需要真正的连接管理。
 *
 * 保留 Provider 组件和 useSurreal hook 以维持 API 兼容性，
 * 但内部不再持有 Surreal 实例或连接状态。
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";

import {
  connectionState,
  dbQuery,
  dbCreate,
  dbMerge,
  dbDelete,
  dbUpsert,
  getLocalUser,
  type ConnectionSnapshot,
  useConnectionSnapshot,
} from "./client";

export interface SurrealProviderState {
  /** IPC 模式下始终为 true（主进程管理连接） */
  isConnected: boolean;
  connectionSnapshot: ConnectionSnapshot;
  /** 兼容旧 API，实际为 no-op */
  connect: () => Promise<void>;
  /** 兼容旧 API，实际为 no-op */
  close: () => Promise<void>;
  /** 数据库操作（委托给 IPC）*/
  db: {
    query: typeof dbQuery;
    create: typeof dbCreate;
    merge: typeof dbMerge;
    delete: typeof dbDelete;
    upsert: typeof dbUpsert;
    getLocalUser: typeof getLocalUser;
  };
}

export interface SurrealProviderProps {
  children: ReactNode;
}

const SurrealContext = createContext<SurrealProviderState | undefined>(
  undefined,
);

export function SurrealProvider({ children }: SurrealProviderProps) {
  const connectionSnapshot = useConnectionSnapshot();

  const connect = useCallback(async () => {
    // no-op：主进程自动管理连接
  }, []);

  const close = useCallback(async () => {
    // no-op
  }, []);

  const value = useMemo<SurrealProviderState>(
    () => ({
      isConnected: connectionSnapshot.state === "connected",
      connectionSnapshot,
      connect,
      close,
      db: {
        query: dbQuery,
        create: dbCreate,
        merge: dbMerge,
        delete: dbDelete,
        upsert: dbUpsert,
        getLocalUser,
      },
    }),
    [connectionSnapshot, connect, close],
  );

  return (
    <SurrealContext.Provider value={value}>{children}</SurrealContext.Provider>
  );
}

export function useSurreal(): SurrealProviderState {
  const context = useContext(SurrealContext);

  if (!context) {
    throw new Error("useSurreal must be used within a SurrealProvider");
  }

  return context;
}
