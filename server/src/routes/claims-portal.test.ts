import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { handleError } from "../middleware/error";
import { ClaimsPortalService, type ClaimsQueryable } from "../claims-portal/service";
import { SESSION_COOKIE_NAME } from "../claims-portal/constants";
import { createClaimsPortalRoutes } from "./claims-portal";
import { hashToken } from "../claims-portal/crypto";

const PEPPER = "test-claims-portal-pepper-32bytes-min!!";

const testUser = {
  subject: "user-123",
  email: "ada@example.test",
  raw: { db: "ws_case_a", ac: "admin" },
  rawToken: "test-token",
};

function useUser(user = testUser): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.set("user", { ...user });
    await next();
  };
}

type Store = {
  roster: { id: string; name: string; identity_code: string };
  tokens: Array<Record<string, unknown>>;
  submissions: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  seq: number;
};

function createMemoryDb(store: Store): ClaimsQueryable {
  return {
    async query(sql: string, vars: Record<string, unknown> = {}) {
      const idStr = vars.id != null ? String(vars.id) : "";
      const rosterStr = vars.roster != null ? String(vars.roster) : "";
      const submissionStr = vars.submission != null ? String(vars.submission) : "";

      if (sql.includes("FROM $id") && sql.includes("name, identity_code")) {
        if (idStr === store.roster.id) return [[store.roster]];
        return [[]];
      }
      if (sql.includes("SELECT id, roster_id, token_hash, status FROM $id")) {
        const token = store.tokens.find((row) => String(row.id) === idStr);
        return [[token].filter(Boolean)];
      }
      if (sql.includes("UPDATE claim_access_token SET status = \"revoked\"")) {
        for (const token of store.tokens) {
          if (String(token.roster_id) === rosterStr && token.status === "active") token.status = "revoked";
        }
        return [[]];
      }
      if (sql.includes("CREATE claim_access_token CONTENT")) {
        store.seq += 1;
        const row = {
          id: `claim_access_token:t${store.seq}`,
          roster_id: rosterStr,
          token_hash: vars.tokenHash,
          status: "active",
          opened_at: null,
          last_attempt_at: null,
          failure_count: 0,
          locked_until: null,
          created_by: vars.createdBy,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        store.tokens.push(row);
        return [[row]];
      }
      if (sql.includes("FROM claim_access_token ORDER BY")) return [[...store.tokens]];
      if (sql.includes("FROM claim_access_token WHERE token_hash")) {
        const row = store.tokens.find((token) => token.token_hash === vars.tokenHash);
        return [[row].filter(Boolean)];
      }
      if (sql.startsWith("UPDATE $id SET") && sql.includes("failure_count")) {
        const token = store.tokens.find((row) => String(row.id) === idStr);
        if (token) {
          token.last_attempt_at = vars.now;
          if (sql.includes("opened_at")) {
            token.opened_at = token.opened_at ?? vars.now;
            token.failure_count = 0;
            token.locked_until = null;
          } else {
            token.failure_count = vars.failureCount;
            token.locked_until = vars.lockedUntil;
          }
        }
        return [[token].filter(Boolean)];
      }
      if (sql.includes("FROM claim_submission WHERE roster_id") || sql.includes("SELECT * FROM claim_submission WHERE roster_id")) {
        const row = store.submissions.find((item) => String(item.roster_id) === rosterStr);
        return [[row].filter(Boolean)];
      }
      if (sql.includes("CREATE claim_submission CONTENT")) {
        store.seq += 1;
        const row = {
          id: `claim_submission:s${store.seq}`,
          roster_id: rosterStr,
          identity_code: vars.identityCode,
          principal: null,
          status: "draft",
          submitted_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        store.submissions.push(row);
        return [[row]];
      }
      if (sql.includes("SELECT * FROM claim_submission ORDER BY")) return [[...store.submissions]];
      if (sql.includes("UPDATE $id SET") && sql.includes("principal")) {
        const row = store.submissions.find((item) => String(item.id) === idStr);
        if (row) {
          Object.assign(row, {
            principal: vars.principal,
            rate_segments: vars.rateSegments,
            interest_start: vars.interestStart,
            interest_end: vars.interestEnd,
            interest_method: vars.interestMethod,
            penalty: vars.penalty,
            statement: vars.statement,
            status: "draft",
          });
        }
        return [[row].filter(Boolean)];
      }
      if (sql.includes("UPDATE $id SET") && sql.includes("status = \"submitted\"")) {
        const row = store.submissions.find((item) => String(item.id) === idStr);
        if (row) {
          row.status = "submitted";
          row.submitted_at = row.submitted_at ?? new Date().toISOString();
        }
        return [[row].filter(Boolean)];
      }
      if (sql.includes("FROM claim_attachment WHERE submission_id")) {
        return [store.attachments.filter((item) => String(item.submission_id) === submissionStr)];
      }
      if (sql.includes("CREATE claim_attachment CONTENT")) {
        store.seq += 1;
        const row = {
          id: `claim_attachment:a${store.seq}`,
          submission_id: submissionStr,
          attachment_type: vars.attachmentType,
          file_name: vars.fileName,
          content_type: vars.contentType,
          byte_size: vars.byteSize,
          storage_key: vars.storageKey,
          uploaded_at: vars.uploadedAt,
          created_at: new Date().toISOString(),
        };
        store.attachments.push(row);
        return [[row]];
      }
      if (sql.includes("FROM $id") && sql.includes("storage_key")) {
        const row = store.attachments.find((item) => String(item.id) === idStr);
        return [[row].filter(Boolean)];
      }
      throw new Error(`unhandled sql: ${sql.slice(0, 100)}`);
    },
  };
}

function makeMemoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    storage: {
      async putObject(input: { key: string; bytes: Uint8Array; contentType: string }) {
        objects.set(input.key, { bytes: input.bytes, contentType: input.contentType });
      },
      async getObject(key: string) {
        const hit = objects.get(key);
        if (!hit) {
          const { HttpError } = await import("../http-error");
          throw new HttpError(404, "attachment-object-missing", "missing");
        }
        return {
          body: hit.bytes,
          contentType: hit.contentType,
          contentLength: hit.bytes.byteLength,
        };
      },
    },
  };
}

function makeApp(options?: {
  pepper?: string | null;
  attachmentConfigured?: boolean;
  user?: typeof testUser;
}) {
  const store: Store = {
    roster: { id: "creditor_roster:r1", name: "张三", identity_code: "ID-001" },
    tokens: [],
    submissions: [],
    attachments: [],
    seq: 0,
  };
  const db = createMemoryDb(store);
  const memoryStorage = makeMemoryStorage();
  const service = new ClaimsPortalService({
    getSession: async () => db,
    resolveWorkspace: async (slug) => (slug === "case-a" ? { dbName: "ws_case_a" } : null),
    getPepper: () => (options && "pepper" in options ? options.pepper ?? null : PEPPER),
    getAttachmentConfig: () =>
      options?.attachmentConfigured
        ? {
            accountId: "a",
            accessKeyId: "k",
            secretAccessKey: "s",
            bucket: "b",
            endpoint: "https://e",
          }
        : null,
    createStorage: () => memoryStorage.storage,
  });
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.route(
    "/",
    createClaimsPortalRoutes({
      service,
      requireUser: () => useUser(options?.user ?? testUser),
    }),
  );
  return { app, store, service, memoryStorage };
}

describe("claims-portal routes", () => {
  test("无 pepper → mint 501 claims-portal-not-configured", async () => {
    const { app } = makeApp({ pepper: null });
    const res = await app.request("/api/workspaces/case-a/claims-portal/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rosterId: "creditor_roster:r1" }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe("claims-portal-not-configured");
  });

  test("无附件配置 → 上传 501 attachment-storage-not-configured", async () => {
    const { app } = makeApp({ attachmentConfigured: false });
    const mint = await app.request("/api/workspaces/case-a/claims-portal/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rosterId: "creditor_roster:r1" }),
    });
    const minted = await mint.json();
    const open = await app.request(
      `/api/claims-portal/case-a/${minted.tokenPlaintext}/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "张三", identityCode: "ID-001" }),
      },
    );
    expect(open.status).toBe(200);
    const cookie = open.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(SESSION_COOKIE_NAME);

    const upload = await app.request(
      `/api/claims-portal/case-a/${minted.tokenPlaintext}/attachments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookie.split(";")[0]!,
        },
        body: JSON.stringify({
          attachmentType: "contract",
          fileName: "a.pdf",
          contentType: "application/pdf",
          byteSize: 10,
        }),
      },
    );
    expect(upload.status).toBe(501);
    expect((await upload.json()).error.code).toBe("attachment-storage-not-configured");
  });

  test("管理人 list tokens 不含明文；公开 open 成功后可读草稿", async () => {
    const { app, store } = makeApp();
    const mint = await app.request("/api/workspaces/case-a/claims-portal/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rosterId: "creditor_roster:r1" }),
    });
    const minted = await mint.json();
    expect(minted.tokenPlaintext).toBeTruthy();

    const listed = await app.request("/api/workspaces/case-a/claims-portal/tokens");
    const listedBody = await listed.json();
    expect(JSON.stringify(listedBody)).not.toContain(minted.tokenPlaintext);
    expect(JSON.stringify(listedBody)).not.toContain(String(store.tokens[0]?.token_hash));
    expect(store.tokens[0]?.token_hash).toBe(hashToken(minted.tokenPlaintext, PEPPER));

    const open = await app.request(
      `/api/claims-portal/case-a/${minted.tokenPlaintext}/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "张三", identityCode: "ID-001" }),
      },
    );
    const cookie = (open.headers.get("set-cookie") ?? "").split(";")[0]!;

    const get = await app.request(
      `/api/claims-portal/case-a/${minted.tokenPlaintext}/submission`,
      { headers: { cookie } },
    );
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.submission.status).toBe("draft");
  });

  test("跨 slug / 伪造令牌失败", async () => {
    const { app } = makeApp();
    const missing = await app.request("/api/claims-portal/nope/tok/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "张三", identityCode: "ID-001" }),
    });
    expect(missing.status).toBe(404);

    const fake = await app.request("/api/claims-portal/case-a/fake-token/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "张三", identityCode: "ID-001" }),
    });
    expect(fake.status).toBe(401);
    expect((await fake.json()).error.message).toBe("姓名或识别码不正确");
  });

  test("非 admin scope → 403", async () => {
    const { app } = makeApp({
      user: { ...testUser, raw: { db: "ws_case_a", ac: "participant" } },
    });
    const res = await app.request("/api/workspaces/case-a/claims-portal/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rosterId: "creditor_roster:r1" }),
    });
    expect(res.status).toBe(403);
  });

  test("管理人下载缺附件配置 → 501", async () => {
    const { app } = makeApp({ attachmentConfigured: false });
    const res = await app.request(
      "/api/workspaces/case-a/claims-portal/attachments/claim_attachment:a1/download",
    );
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("attachment-storage-not-configured");
  });

  test("有附件配置：上传字节成功，管理人受控下载", async () => {
    const { app, memoryStorage } = makeApp({ attachmentConfigured: true });
    const mint = await app.request("/api/workspaces/case-a/claims-portal/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rosterId: "creditor_roster:r1" }),
    });
    const minted = await mint.json();
    const open = await app.request(
      `/api/claims-portal/case-a/${minted.tokenPlaintext}/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "张三", identityCode: "ID-001" }),
      },
    );
    const cookie = (open.headers.get("set-cookie") ?? "").split(";")[0]!;
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 mock");
    const upload = await app.request(
      `/api/claims-portal/case-a/${minted.tokenPlaintext}/attachments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
        },
        body: JSON.stringify({
          attachmentType: "contract",
          fileName: "a.pdf",
          contentType: "application/pdf",
          byteSize: pdfBytes.byteLength,
          bytesBase64: Buffer.from(pdfBytes).toString("base64"),
        }),
      },
    );
    expect(upload.status).toBe(200);
    const uploaded = await upload.json();
    expect(uploaded.ok).toBe(true);
    expect(uploaded.attachment.id).toBeTruthy();
    expect(memoryStorage.objects.size).toBe(1);

    const download = await app.request(
      `/api/workspaces/case-a/claims-portal/attachments/${uploaded.attachment.id}/download`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("cache-control")).toContain("no-store");
    expect(download.headers.get("content-disposition")).toContain("a.pdf");
    expect(await download.text()).toBe("%PDF-1.4 mock");
  });
});
