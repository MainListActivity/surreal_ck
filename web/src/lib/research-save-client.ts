/**
 * RR-012 资源保存确认动作的 SSE 客户端。
 *
 * 这是后端少数保留 endpoint 之一（embedding key 在服务端）；
 * 其余资源读写由浏览器直连 SurrealDB。事件解析容忍未知事件（向前兼容）。
 */
import { parseResearchSaveEvent, type ResearchSaveEvent } from "@surreal-ck/shared";
import { getToken as defaultGetToken } from "./auth";

export type ResearchSaveClientOptions = {
  baseUrl?: string;
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
};

export type ResearchSaveClient = {
  /** 发起一次保存动作；事件按服务端顺序回调，流结束后 resolve。HTTP 失败直接抛错。 */
  save(request: unknown, onEvent: (event: ResearchSaveEvent) => void): Promise<void>;
};

function parseSseBlock(block: string): ResearchSaveEvent | null {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  if (dataLines.length === 0) return null;
  try {
    return parseResearchSaveEvent(JSON.parse(dataLines.join("\n")));
  } catch {
    return null;
  }
}

export function createResearchSaveClient(options: ResearchSaveClientOptions = {}): ResearchSaveClient {
  const getToken = options.getToken ?? defaultGetToken;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "";

  return {
    async save(request, onEvent) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = getToken();
      if (token) headers.authorization = `Bearer ${token}`;

      const response = await fetchImpl(`${baseUrl}/api/resources/research/save`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });
      if (!response.ok || !response.body) {
        throw new Error(`资源保存请求失败（${response.status}）`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const flush = (chunk: string) => {
        buffer += chunk;
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const event = parseSseBlock(block);
          if (event) onEvent(event);
          separator = buffer.indexOf("\n\n");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        flush(decoder.decode(value, { stream: true }));
      }
      flush(decoder.decode());
    },
  };
}
