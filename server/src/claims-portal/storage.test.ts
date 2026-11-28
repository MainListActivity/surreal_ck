import { describe, expect, test } from "bun:test";
import {
  buildClaimsAttachmentKey,
  createAttachmentStorage,
  createCloudflareApiAttachmentStorage,
  createS3AttachmentStorage,
} from "./storage";

describe("claims-portal storage", () => {
  test("buildClaimsAttachmentKey 规范化 record id 与文件名", () => {
    expect(
      buildClaimsAttachmentKey({
        workspaceDb: "ws_case_a",
        submissionId: "claim_submission:s1",
        attachmentId: "uuid-1",
        fileName: "dir/合同.pdf",
      }),
    ).toBe("claims/ws_case_a/s1/uuid-1/dir_合同.pdf");
  });

  test("endpoint 含 api.cloudflare.com → CF REST 后端", () => {
    const storage = createAttachmentStorage({
      accountId: "acc",
      accessKeyId: "cf-api-token",
      secretAccessKey: "token-value",
      bucket: "bucket",
      endpoint: "https://api.cloudflare.com",
    });
    expect(storage).toBeTruthy();
    // 同工厂对 S3 endpoint 走另一路；此处只断言构造不抛。
    const s3 = createAttachmentStorage({
      accountId: "acc",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "bucket",
      endpoint: "https://acc.r2.cloudflarestorage.com",
    });
    expect(s3).toBeTruthy();
  });

  test("CF REST put/get 走 Bearer 与对象路径（mock fetch）", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; auth?: string | null }> = [];
    const objects = new Map<string, Uint8Array>();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({
        url,
        method,
        auth: init?.headers && typeof init.headers === "object" && "Authorization" in (init.headers as Record<string, string>)
          ? (init.headers as Record<string, string>).Authorization
          : null,
      });
      // URL path uses encodeURIComponent per segment; rebuild key from path after /objects/
      const afterObjects = url.split("/objects/")[1] ?? "";
      const rebuiltKey = afterObjects.split("/").map(decodeURIComponent).join("/");

      if (method === "PUT") {
        const body = init?.body instanceof Uint8Array
          ? init.body
          : new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        objects.set(rebuiltKey, body);
        return new Response(JSON.stringify({ success: true, result: { key: rebuiltKey } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET") {
        const hit = objects.get(rebuiltKey);
        if (!hit) return new Response("missing", { status: 404 });
        return new Response(hit, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      return new Response("nope", { status: 405 });
    }) as typeof fetch;

    try {
      const storage = createCloudflareApiAttachmentStorage({
        accountId: "acc-1",
        accessKeyId: "cf-api-token",
        secretAccessKey: "secret-token",
        bucket: "surreal-ck-claims-attachments",
        endpoint: "https://api.cloudflare.com",
      });
      const key = "claims/ws/s1/a1/file.pdf";
      const bytes = new TextEncoder().encode("pdf-bytes");
      await storage.putObject({ key, bytes, contentType: "application/pdf" });
      const got = await storage.getObject(key);
      expect(new TextDecoder().decode(got.body)).toBe("pdf-bytes");
      expect(got.contentType).toBe("application/pdf");
      expect(calls[0]?.method).toBe("PUT");
      expect(calls[0]?.auth).toBe("Bearer secret-token");
      expect(calls[0]?.url).toContain("/accounts/acc-1/r2/buckets/surreal-ck-claims-attachments/objects/");
      expect(calls[1]?.method).toBe("GET");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("CF REST 容量错误和传输失败均返回固定文案", async () => {
    const originalFetch = globalThis.fetch;
    const storage = createCloudflareApiAttachmentStorage({
      accountId: "test-account",
      accessKeyId: "test-key",
      secretAccessKey: "test-value",
      bucket: "test-bucket",
      endpoint: "https://api.cloudflare.com",
    });
    const input = { key: "a.pdf", bytes: new Uint8Array(16), contentType: "application/pdf" };
    const privateDetails = "mock-private-upstream-details";
    try {
      for (const [status, body, expectedStatus, code] of [
        [507, privateDetails, 507, "attachment-storage-full"],
        [400, `{"code":"QuotaExceeded","message":"${privateDetails}"}`, 507, "attachment-storage-full"],
        [413, privateDetails, 413, "attachment-too-large"],
        [500, privateDetails, 502, "attachment-upload-failed"],
      ] as const) {
        globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
        const error = await storage.putObject(input).catch((cause: unknown) => cause);
        expect(error).toMatchObject({ status: expectedStatus, code });
        expect(String(error)).not.toContain(privateDetails);
      }
      globalThis.fetch = (async () => { throw new Error(privateDetails); }) as unknown as typeof fetch;
      await expect(storage.putObject(input)).rejects.toMatchObject({
        status: 502,
        code: "attachment-upload-failed",
        message: "附件上传失败，请稍后重试",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("S3 签名 PUT 发送原始字节，映射裸 HTTP 状态与已知错误码", async () => {
    const results = [
      [507, "full", 507, "attachment-storage-full"],
      [400, "<Error><Code>InsufficientStorage</Code></Error>", 507, "attachment-storage-full"],
      [413, "too large", 413, "attachment-too-large"],
      [400, "<Error><Code>EntityTooLarge</Code></Error>", 413, "attachment-too-large"],
      [500, "mock-private-signed-url-details", 502, "attachment-upload-failed"],
    ] as const;
    const uploads: Array<{ method: string; path: string; mime: string | null; bytes: Uint8Array; signed: boolean }> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        uploads.push({
          method: req.method,
          path: decodeURIComponent(url.pathname),
          mime: req.headers.get("content-type"),
          bytes: new Uint8Array(await req.arrayBuffer()),
          signed: url.searchParams.has("X-Amz-Signature"),
        });
        const result = results[uploads.length - 1];
        return result ? new Response(result[1], { status: result[0] }) : new Response(null);
      },
    });
    try {
      const storage = createS3AttachmentStorage({
        accountId: "test-account",
        accessKeyId: "test-key",
        secretAccessKey: "test-value",
        bucket: "test-bucket",
        endpoint: `http://127.0.0.1:${upstream.port}`,
      });
      const input = {
        key: "claims/example/合同 1.pdf",
        bytes: new Uint8Array([37, 80, 68, 70]),
        contentType: "application/pdf",
      };
      for (const [, , status, code] of results) {
        const error = await storage.putObject(input).catch((cause: unknown) => cause);
        expect(error).toMatchObject({ status, code });
        expect(String(error)).not.toContain("mock-private-signed-url-details");
      }
      await storage.putObject(input);
      expect(uploads).toHaveLength(results.length + 1);
      for (const upload of uploads) {
        expect(upload).toEqual({
          method: "PUT",
          path: `/test-bucket/${input.key}`,
          mime: input.contentType,
          bytes: input.bytes,
          signed: true,
        });
      }
    } finally {
      upstream.stop(true);
    }
  });
});
