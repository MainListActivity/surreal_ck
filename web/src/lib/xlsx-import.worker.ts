/// <reference lib="webworker" />

import { parseXlsxImport } from "./xlsx-import";

self.onmessage = (event: MessageEvent<{ data: ArrayBuffer; fileName: string }>) => {
  try {
    const parsed = parseXlsxImport(event.data.data, event.data.fileName);
    self.postMessage({ ok: true, parsed });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    self.postMessage({ ok: false, error: error.split(/\r?\n/u, 1)[0] ?? "XLSX 解析失败" });
  }
};
