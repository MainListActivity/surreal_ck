import type { ParsedXlsxImport } from "./xlsx-import";

export type XlsxParserWorker = {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
  terminate: () => void;
};

export type XlsxFileLike = {
  name: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export function createXlsxParseTask(
  file: XlsxFileLike,
  createWorker: () => XlsxParserWorker = defaultWorker,
): { promise: Promise<ParsedXlsxImport>; cancel: () => void } {
  const worker = createWorker();
  let settled = false;
  let rejectPromise: (reason: unknown) => void = () => undefined;

  const promise = new Promise<ParsedXlsxImport>((resolve, reject) => {
    rejectPromise = reject;
    worker.onmessage = (event) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      const message = event.data as
        | { ok: true; parsed: ParsedXlsxImport }
        | { ok: false; error: string };
      if (message.ok) resolve(message.parsed);
      else reject(new Error(message.error));
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error("XLSX 解析失败，请检查文件后重试"));
    };
    void file.arrayBuffer().then((data) => {
      if (settled) return;
      worker.postMessage({ data, fileName: file.name }, [data]);
    }, (cause) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(cause);
    });
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectPromise(abortError());
    },
  };
}

function defaultWorker(): XlsxParserWorker {
  return new Worker(new URL("./xlsx-import.worker.ts", import.meta.url), { type: "module" });
}

function abortError(): Error {
  const error = new Error("XLSX 解析已取消");
  error.name = "AbortError";
  return error;
}
