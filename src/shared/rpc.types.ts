import type { ElectrobunRPCSchema } from "electrobun/bun";

export type RowData = {
  id: string;
  name: string;
  value: string;
};

export interface AppRPC extends ElectrobunRPCSchema {
  bun: {
    requests: {
      query: { params: { sql: string }; response: unknown[] };
    };
    messages: {
      log: { msg: string };
    };
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      pushRows: { rows: RowData[] };
    };
  };
}
