import { describe, expect, test } from "bun:test";
import type { ParsedXlsxImport } from "./xlsx-import";
import { createXlsxParseTask, type XlsxParserWorker } from "./xlsx-parse-task";

class FakeWorker implements XlsxParserWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("OIP-13 XLSX Worker 解析任务", () => {
  test("把文件二进制交给 Worker 解析而不在主线程执行", async () => {
    const worker = new FakeWorker();
    const file = {
      name: "中文台账.xlsx",
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
    const task = createXlsxParseTask(file, () => worker);
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.posted).toHaveLength(1);
    const parsed: ParsedXlsxImport = {
      fileName: file.name,
      workbookName: "中文台账",
      sheets: [],
    };
    worker.onmessage?.(new MessageEvent("message", { data: { ok: true, parsed } }));

    expect(await task.promise).toEqual(parsed);
    expect(worker.terminated).toBe(true);
  });

  test("确认前取消会终止 Worker，解析结果不会再进入向导", async () => {
    const worker = new FakeWorker();
    const task = createXlsxParseTask({
      name: "大文件.xlsx",
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    }, () => worker);

    task.cancel();

    expect(worker.terminated).toBe(true);
    expect(task.promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
