import type { ElectrobunRPCSchema } from "electrobun/bun";

export type RowData = {
  id: string;
  name: string;
  value: string;
};

export type AuthState = {
  loggedIn: boolean;
  expiresAt?: number;
  error?: string;
  offlineMode?: boolean;
};

export interface AppRPC extends ElectrobunRPCSchema {
  bun: {
    requests: {
      query: { params: { sql: string }; response: unknown[] };
      getAuthState: { params: Record<string, never>; response: AuthState };
      logout: { params: Record<string, never>; response: void };
    };
    messages: {
      log: { msg: string };
      startLogin: Record<string, never>;
    };
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      pushRows: { rows: RowData[] };
      authStateChanged: { state: AuthState };
    };
  };
}
