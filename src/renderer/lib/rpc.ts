import { Electroview } from "electrobun/view";
import type { AppRPC } from "../../shared/rpc.types";

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
    },
  },
});

export const view = new Electroview({ rpc });
