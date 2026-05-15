type FetchInput = string | URL | Request;
type FetchInit = RequestInit;
type FetchLike = (input: FetchInput, init?: FetchInit) => Promise<Response>;
type HeaderInput = NonNullable<FetchInit["headers"]>;
type BodyInput = NonNullable<FetchInit["body"]>;

export type HttpFailureLogPayload = {
  method: string;
  url: string;
  request: {
    headers: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    statusText: string;
    body?: unknown;
  };
  error?: string;
};

type HttpFailureLogger = (message: string, payload: HttpFailureLogPayload) => void;

const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 50;
const REDACTED = "[redacted]";

let installed = false;

export function installHttpFailureLogger(): void {
  if (installed) return;
  installed = true;
  const originalFetch = globalThis.fetch;
  const wrappedFetch = createHttpFailureLoggingFetch(originalFetch.bind(globalThis), (message, payload) => {
    console.error(message, payload);
  });
  Object.assign(wrappedFetch, {
    preconnect: originalFetch.preconnect.bind(originalFetch),
  });
  globalThis.fetch = wrappedFetch as typeof globalThis.fetch;
}

export function createHttpFailureLoggingFetch(
  baseFetch: FetchLike,
  logger: HttpFailureLogger,
): FetchLike {
  return (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const request = await snapshotRequest(input, init);

    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (err) {
      logger("[http] request failed", {
        ...request,
        request: request.request,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      throw err;
    }

    if (response.status < 200 || response.status >= 300) {
      logger("[http] non-2xx response", {
        ...request,
        request: request.request,
        response: await snapshotResponse(response),
      });
    }

    return response;
  }) as FetchLike;
}

async function snapshotRequest(
  input: Parameters<FetchLike>[0],
  init?: Parameters<FetchLike>[1],
): Promise<Omit<HttpFailureLogPayload, "response" | "error">> {
  const requestInput = input instanceof Request ? input : undefined;
  const headers = mergeHeaders(requestInput?.headers, init?.headers);
  const body = init?.body !== undefined
    ? await snapshotBody(init.body, headers["content-type"])
    : requestInput
      ? await snapshotRequestBody(requestInput, headers["content-type"])
      : undefined;

  return {
    method: init?.method ?? requestInput?.method ?? "GET",
    url: sanitizeUrl(requestInput?.url ?? String(input)),
    request: {
      headers,
      ...(body !== undefined ? { body } : {}),
    },
  };
}

async function snapshotResponse(response: Response): Promise<NonNullable<HttpFailureLogPayload["response"]>> {
  const headers = headersToObject(response.headers);
  return {
    status: response.status,
    statusText: response.statusText,
    body: await snapshotResponseBody(response, headers["content-type"]),
  };
}

function mergeHeaders(
  requestHeaders?: Headers,
  initHeaders?: HeaderInput,
): Record<string, string> {
  const headers = new Headers(requestHeaders);
  if (initHeaders) {
    new Headers(initHeaders).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return headersToObject(headers);
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = isSensitiveKey(key) ? REDACTED : truncateString(value);
  });
  return out;
}

async function snapshotRequestBody(body: Request, contentType?: string): Promise<unknown> {
  if (body.bodyUsed) return "[body already used]";
  try {
    return snapshotText(await body.clone().text(), contentType);
  } catch (err) {
    return `[body unavailable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

async function snapshotResponseBody(response: Response, contentType?: string): Promise<unknown> {
  try {
    return snapshotText(await response.clone().text(), contentType);
  } catch (err) {
    return `[body unavailable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

async function snapshotBody(body: BodyInput | null, contentType?: string): Promise<unknown> {
  if (body == null) return undefined;
  if (typeof body === "string") return snapshotText(body, contentType);
  if (body instanceof URLSearchParams) return redactValue(Object.fromEntries(body.entries()));
  if (body instanceof FormData) return redactValue(formDataToObject(body));
  if (body instanceof Blob) return snapshotBlob(body, contentType);
  if (body instanceof ArrayBuffer) return `[binary body: ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[binary body: ${body.byteLength} bytes]`;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return "[stream body]";
  return truncateString(String(body));
}

async function snapshotBlob(blob: Blob, contentType?: string): Promise<unknown> {
  if (blob.size > MAX_STRING_LENGTH) return `[blob body: ${blob.size} bytes]`;
  return snapshotText(await blob.text(), blob.type || contentType);
}

function snapshotText(text: string, contentType?: string): unknown {
  if (!text) return "";
  const normalizedContentType = contentType?.toLowerCase() ?? "";
  const trimmed = text.trim();

  if (normalizedContentType.includes("application/json") || looksLikeJson(trimmed)) {
    try {
      return redactValue(JSON.parse(trimmed));
    } catch {
      return truncateString(text);
    }
  }

  if (normalizedContentType.includes("application/x-www-form-urlencoded")) {
    return redactValue(Object.fromEntries(new URLSearchParams(text).entries()));
  }

  return truncateString(text);
}

function formDataToObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    const entryValue: unknown = value;
    out[key] = isBlobLike(entryValue) ? `[file: ${fileName(entryValue)}, ${entryValue.size} bytes]` : entryValue;
  }
  return out;
}

function isBlobLike(value: unknown): value is Blob {
  return value instanceof Blob;
}

function fileName(value: Blob): string {
  return "name" in value && typeof value.name === "string" ? value.name : "blob";
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const [key, value] of url.searchParams.entries()) {
      url.searchParams.set(key, isSensitiveKey(key) ? REDACTED : truncateString(value));
    }
    return url.toString();
  } catch {
    return truncateString(rawUrl);
  }
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return truncateString(value);
  if (typeof value !== "object" || value === null) return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, seen);
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "code" ||
    normalized === "codeverifier" ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("apikey")
  );
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function looksLikeJson(value: string): boolean {
  return (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  );
}
