import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { createPublicProtection } from "../public-entry/protection";
import { handleError } from "../middleware/error";
import { ClaimsPortalService, type ClaimsQueryable } from "../claims-portal/service";
import { MAX_ATTACHMENT_BYTES, SESSION_COOKIE_NAME } from "../claims-portal/constants";
import { HttpError } from "../http-error";
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
  supplements: Array<Record<string, unknown>>;
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
      if (sql.includes("FROM creditor_roster WHERE id INSIDE")) {
        return [[store.roster].filter((row) => (vars.rosterIds as unknown[]).map(String).includes(row.id))];
      }
      if (sql.includes("CREATE $entry.token")) {
        for (const entry of vars.entries as { roster: unknown; token: unknown; hash: string }[]) {
          for (const old of store.tokens) {
            if (old.roster_id === String(entry.roster) && old.status === "active") old.status = "revoked";
          }
          store.tokens.push({
            id: String(entry.token), roster_id: String(entry.roster), token_hash: entry.hash,
            status: "active", opened_at: null, last_attempt_at: null, failure_count: 0, locked_until: null,
            created_by: vars.createdBy, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          });
        }
        return [[]];
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
      if (sql.includes("FROM claim_progress_event") || sql.includes("FROM claim_decision")) return [[]];
      if (sql.includes("FROM claim_supplement WHERE submission_id")) {
        const rows = store.supplements
          .filter((item) => String(item.submission_id) === submissionStr)
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        return [rows];
      }
      if (sql.includes("FROM $roster")) {
        const row = String(vars.roster) === rosterStr ? store.roster : null;
        return [[row].filter(Boolean)];
      }
      if (sql.includes("INSERT INTO claim_supplement")) {
        store.seq += 1;
        const row = {
          id: `claim_supplement:sp${store.seq}`,
          submission_id: submissionStr,
          direction: "creditor_reply",
          body: vars.body,
          actor: vars.actor,
          created_at: new Date().toISOString(),
        };
        store.supplements.push(row);
        return [[row]];
      }
      throw new Error(`unhandled sql: ${sql.slice(0, 100)}`);
    },
  };
}

function makeMemoryStorage(putObjectError?: HttpError) {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    storage: {
      async putObject(input: { key: string; bytes: Uint8Array; contentType: string }) {
        if (putObjectError) throw putObjectError;
        objects.set(input.key, { bytes: input.bytes, contentType: input.contentType });
      },
      async getObject(key: string) {
        const hit = objects.get(key);
        if (!hit) {
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
  checkDiskSpace?: () => Promise<number>;
  putObjectError?: HttpError;
  user?: typeof testUser;
}) {
  const store: Store = {
    roster: { id: "creditor_roster:r1", name: "张三", identity_code: "ID-001" },
    tokens: [],
    submissions: [],
    attachments: [],
    supplements: [],
    seq: 0,
  };
  const db = createMemoryDb(store);
  const memoryStorage = makeMemoryStorage(options?.putObjectError);
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
    checkDiskSpace: options?.checkDiskSpace ?? (async () => Number.MAX_SAFE_INTEGER),
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

async function openAttachmentUpload(app: Hono<AppBindings>) {
  const mint = await app.request("/api/workspaces/case-a/claims-portal/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rosterId: "creditor_roster:r1" }),
  });
  expect(mint.status).toBe(200);
  const { tokenPlaintext } = await mint.json<{ tokenPlaintext: string }>();
  const open = await app.request(`/api/claims-portal/case-a/${tokenPlaintext}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "张三", identityCode: "ID-001" }),
  });
  expect(open.status).toBe(200);
  const cookie = open.headers.get("set-cookie")!.split(";")[0]!;
  return { path: `/api/claims-portal/case-a/${tokenPlaintext}/attachments`, cookie };
}

function jsonAttachment(bytes: Uint8Array): string {
  return JSON.stringify({
    attachmentType: "contract",
    fileName: "a.pdf",
    contentType: "application/pdf",
    bytesBase64: Buffer.from(bytes).toString("base64"),
  });
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

  test("换发后旧 cookie 下一次请求失败，无法靠打开接口区分作废或不存在的令牌", async () => {
    const { app } = makeApp();
    const mint = async () => {
      const response = await app.request("/api/workspaces/case-a/claims-portal/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rosterId: "creditor_roster:r1" }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { tokenPlaintext: string };
      return `/api/claims-portal/case-a/${body.tokenPlaintext}`;
    };
    const open = (url: string, identityCode = "ID-001") => app.request(`${url}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "张三", identityCode }),
    });

    const oldUrl = await mint();
    const opened = await open(oldUrl);
    expect(opened.status).toBe(200);
    const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
    const read = () => app.request(`${oldUrl}/submission`, { headers: { cookie } });
    expect((await read()).status).toBe(200);

    const newUrl = await mint();
    const unauthenticated = await app.request(`${oldUrl}/submission`);
    const denied = await read();
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual(await unauthenticated.json());
    const wrongCredentials = await open(newUrl, "wrong");
    expect(wrongCredentials.status).toBe(401);
    const failure = await wrongCredentials.json();
    for (const url of [oldUrl, "/api/claims-portal/case-a/unknown"]) {
      const refused = await open(url);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual(failure);
      expect(refused.headers.has("set-cookie")).toBe(false);
    }
    expect((await open(newUrl)).status).toBe(200);
  });

  test("债权人补充往返端点：回复落库为 creditor_reply，GET 可见往返且不含管理人笔记", async () => {
    const { app, store } = makeApp();
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
    store.submissions[0]!.manager_note = "内部：勿回发给债权人";
    store.supplements.push({
      id: "claim_supplement:mgr1",
      submission_id: String(store.submissions[0]!.id),
      direction: "manager_request",
      body: "请补充银行流水",
      actor: "王管理人",
      created_at: "2025-01-10T00:00:00.000Z",
    });

    const reply = await app.request(
      `/api/claims-portal/case-a/${minted.tokenPlaintext}/submission/supplement`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ body: "流水已补传附件" }),
      },
    );
    expect(reply.status).toBe(200);
    const replyBody = await reply.json();
    expect(replyBody.supplement.direction).toBe("creditor_reply");
    expect(replyBody.supplement.actor).toBe("张三");
    expect(store.supplements).toHaveLength(2);

    const get = await app.request(
      `/api/claims-portal/case-a/${minted.tokenPlaintext}/submission`,
      { headers: { cookie } },
    );
    const body = await get.json();
    expect(body.supplements).toHaveLength(2);
    expect(body.supplements[0].direction).toBe("manager_request");
    expect(JSON.stringify(body)).not.toContain("勿回发给债权人");
    expect("managerNote" in body.submission).toBe(false);
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

  test("上传和查询不公开存储键或案件库名；管理人仍可按 ID 下载", async () => {
    const { app, memoryStorage, store } = makeApp({ attachmentConfigured: true });
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
    expect(uploaded.attachment).not.toHaveProperty("storageKey");
    expect(JSON.stringify(uploaded)).not.toContain("ws_case_a");
    expect(memoryStorage.objects.size).toBe(1);

    const submission = store.submissions[0]!;
    submission.manager_note = "只供管理人留存的笔记";
    const listed = await app.request(
      `/api/claims-portal/case-a/${minted.tokenPlaintext}/submission`,
      { headers: { cookie } },
    );
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.attachments).toEqual([uploaded.attachment]);
    expect(listedBody.submission).not.toHaveProperty("managerNote");
    expect(JSON.stringify(listedBody)).not.toContain("ws_case_a");
    expect(JSON.stringify(listedBody)).not.toContain(submission.manager_note as string);

    const download = await app.request(
      `/api/workspaces/case-a/claims-portal/attachments/${uploaded.attachment.id}/download`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("cache-control")).toContain("no-store");
    expect(download.headers.get("content-disposition")).toContain("a.pdf");
    expect(await download.text()).toBe("%PDF-1.4 mock");
  });

  test.each(["multipart", "base64"] as const)("%s 文件 20 MiB 可上传，超出一个字节返回 413", async (format) => {
    const { app, store, memoryStorage } = makeApp({ attachmentConfigured: true });
    const { path, cookie } = await openAttachmentUpload(app);
    let declaredBytes = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        declaredBytes = Number(request.headers.get("content-length"));
        return app.fetch(request);
      },
    });
    try {
      for (const size of [MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES + 1]) {
        const bytes = new Uint8Array(size);
        const headers = new Headers({ cookie });
        let body: FormData | string;
        if (format === "multipart") {
          const form = new FormData();
          form.set("attachmentType", "contract");
          form.set("file", new File([bytes], "a.pdf", { type: "application/pdf" }));
          body = form;
        } else {
          headers.set("content-type", "application/json");
          body = jsonAttachment(bytes);
        }
        const res = await fetch(new URL(path, server.url), { method: "POST", headers, body });
        expect(declaredBytes).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
        if (size === MAX_ATTACHMENT_BYTES) {
          expect(res.status).toBe(200);
          expect((await res.json()).attachment.byteSize).toBe(MAX_ATTACHMENT_BYTES);
        } else {
          expect(res.status).toBe(413);
          expect((await res.json()).error.code).toBe("attachment-too-large");
        }
      }
    } finally {
      server.stop(true);
    }
    expect(memoryStorage.objects.size).toBe(1);
    expect(store.attachments).toHaveLength(1);
  });

  test("声明的请求体超限时，在磁盘查询和解析前返回 413", async () => {
    let probes = 0;
    const { app, store, memoryStorage } = makeApp({
      attachmentConfigured: true,
      checkDiskSpace: async () => { probes++; return 0; },
    });
    const { path, cookie } = await openAttachmentUpload(app);
    const res = await app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "content-length": String(2 * MAX_ATTACHMENT_BYTES) },
      body: "invalid json",
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("attachment-too-large");
    expect(probes).toBe(0);
    expect(memoryStorage.objects.size).toBe(0);
    expect(store.attachments).toHaveLength(0);
  });

  test.each([1, 2])("第 %i 次磁盘检查不足时返回 507，且对象和元数据均未写入", async (failingProbe) => {
    let probes = 0;
    const { app, store, memoryStorage } = makeApp({
      attachmentConfigured: true,
      checkDiskSpace: async () => ++probes === failingProbe ? 0 : Number.MAX_SAFE_INTEGER,
    });
    const { path, cookie } = await openAttachmentUpload(app);
    const res = await app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: jsonAttachment(new Uint8Array(16)),
    });
    expect(res.status).toBe(507);
    expect((await res.json()).error.code).toBe("upload-insufficient-storage");
    expect(probes).toBe(failingProbe);
    expect(memoryStorage.objects.size).toBe(0);
    expect(store.attachments).toHaveLength(0);
  });

  test("磁盘查询故障返回固定 503 文案", async () => {
    const { app, store } = makeApp({
      attachmentConfigured: true,
      checkDiskSpace: async () => { throw new Error("mock-private-probe-details"); },
    });
    const { path, cookie } = await openAttachmentUpload(app);
    const res = await app.request(path, { method: "POST", headers: { cookie }, body: "invalid json" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("upload-storage-check-failed");
    expect(JSON.stringify(body)).not.toContain("mock-private-probe-details");
    expect(store.attachments).toHaveLength(0);
  });

  test("对象存储 507 透传，附件元数据未写入", async () => {
    const { app, store } = makeApp({
      attachmentConfigured: true,
      putObjectError: new HttpError(507, "attachment-storage-full", "附件存储空间不足，请稍后重试"),
    });
    const { path, cookie } = await openAttachmentUpload(app);
    const res = await app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: jsonAttachment(new Uint8Array(16)),
    });
    expect(res.status).toBe(507);
    expect((await res.json()).error.code).toBe("attachment-storage-full");
    expect(store.attachments).toHaveLength(0);
  });
});


test("门户公开入口在访问工作区前拒绝缺少 Turnstile 的核验与写入", async () => {
  let resolved = 0;
  const service = new ClaimsPortalService({
    resolveWorkspace: async () => { resolved++; return null; },
  });
  const protection = createPublicProtection({ enabled: true, verify: async token => token === "verified" });
  const app = new Hono().onError(handleError).route("/", createClaimsPortalRoutes({ service, protection }));
  const base = "/api/claims-portal/case/unknown";
  const session = { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "测试", identityCode: "测试编码" }) };
  const missing = await app.request(base + "/session", session);
  expect(missing.status).toBe(401);
  const error = await missing.json();
  for (const suffix of ["/submission/submit", "/submission/supplement", "/attachments"]) {
    const response = await app.request(base + suffix, { method: "POST" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(error);
  }
  expect(resolved).toBe(0);
  const wrongLink = await app.request(base + "/session", {
    ...session, body: JSON.stringify({ name: "测试", identityCode: "测试编码", turnstileToken: "verified" }),
  });
  expect(wrongLink.status).toBe(401);
  expect(await wrongLink.json()).toEqual(error);
  expect(resolved).toBe(1);
});
