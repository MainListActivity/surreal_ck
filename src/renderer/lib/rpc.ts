import { Electroview } from "electrobun/view";
import type { AppRPC } from "../../shared/rpc.types";
import { applyAuthState } from "./auth.svelte";

let _rows: ((rows: { id: string; name: string; value: string }[]) => void) | null = null;

export function onPushRows(cb: (rows: { id: string; name: string; value: string }[]) => void) {
  _rows = cb;
}

export const rpc = Electroview.defineRPC<AppRPC>({
  handlers: {
    requests: {},
    messages: {
      pushRows: ({ rows }) => {
        _rows?.(rows);
      },
      authStateChanged: ({ state }) => {
        applyAuthState(state);
      },
    },
  },
});

export const view = new Electroview({ rpc });
