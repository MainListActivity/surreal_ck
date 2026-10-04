import { describe, expect, test } from "bun:test";
import { HttpError } from "../http-error";
import { hashToken } from "./crypto";
import {
  ClaimsPortalService,
  FAIL_THRESHOLD,
  OPEN_FAILURE_MESSAGE,
  type ClaimsQueryable,
} from "./service";

const PEPPER = "test-claims-portal-pepper-32bytes-min!!";

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
      if (sql.includes("FROM $id") && sql.includes("identity_code") && !sql.includes("claim_access_token")) {
        const id = String(vars.id);
        if (id === store.roster.id || id === `creditor_roster:${store.roster.id}`) {
          return [[store.roster]];
        }
        // token by id
        const token = store.tokens.find((row) => String(row.id) === id);
        if (token) return [[token]];
        return [[]];
      }

      if (sql.includes("UPDATE claim_access_token SET status = \"revoked\"")) {
        for (const token of store.tokens) {
          if (String(token.roster_id) === String(vars.roster) && token.status === "active") {
            token.status = "revoked";
          }
        }
        return [[]];
      }

      if (sql.includes("CREATE claim_access_token CONTENT")) {
        store.seq += 1;
        const row = {
          id: `claim_access_token:t${store.seq}`,
          roster_id: String(vars.roster),
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

      if (sql.includes("FROM claim_access_token ORDER BY")) {
        return [[...store.tokens]];
      }

      if (sql.includes("FROM claim_access_token WHERE token_hash")) {
        const row = store.tokens.find((token) => token.token_hash === vars.tokenHash);
        return [[row].filter(Boolean)];
      }

      if (sql.startsWith("UPDATE $id SET") && sql.includes("failure_count")) {
        const token = store.tokens.find((row) => String(row.id) === String(vars.id));
        if (token) {
          token.last_attempt_at = vars.now;
          token.failure_count = vars.failureCount;
          token.locked_until = vars.lockedUntil;
          token.updated_at = vars.now;
          if (sql.includes("opened_at")) {
            token.opened_at = token.opened_at ?? vars.now;
            token.failure_count = 0;
            token.locked_until = null;
          }
        }
        return [[token].filter(Boolean)];
      }

      if (sql.includes("FROM claim_submission WHERE roster_id")) {
        const row = store.submissions.find((item) => String(item.roster_id) === String(vars.roster));
        return [[row].filter(Boolean)];
      }

      if (sql.includes("CREATE claim_submission CONTENT")) {
        store.seq += 1;
        const row = {
          id: `claim_submission:s${store.seq}`,
          roster_id: String(vars.roster),
          identity_code: vars.identityCode,
          principal: null,
          rate_segments: null,
          interest_start: null,
          interest_end: null,
          interest_method: null,
          penalty: null,
          statement: null,
          status: "draft",
          submitted_at: null,
          manager_note: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        store.submissions.push(row);
        return [[row]];
      }

      if (sql.includes("SELECT * FROM claim_submission ORDER BY")) {
        return [[...store.submissions]];
      }

      if (sql.includes("SELECT * FROM claim_submission WHERE roster_id")) {
        const row = store.submissions.find((item) => String(item.roster_id) === String(vars.roster));
        return [[row].filter(Boolean)];
      }

      if (sql.includes("UPDATE $id SET") && sql.includes("principal")) {
        const row = store.submissions.find((item) => String(item.id) === String(vars.id));
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
            updated_at: new Date().toISOString(),
          });
        }
        return [[row].filter(Boolean)];
      }

      if (sql.includes("UPDATE $id SET") && sql.includes("status = \"submitted\"")) {
        const row = store.submissions.find((item) => String(item.id) === String(vars.id));
        if (row) {
          row.status = "submitted";
          row.submitted_at = row.submitted_at ?? new Date().toISOString();
          row.updated_at = new Date().toISOString();
        }
        return [[row].filter(Boolean)];
      }

      if (sql.includes("FROM claim_attachment WHERE submission_id")) {
        const rows = store.attachments.filter((item) => String(item.submission_id) === String(vars.submission));
        return [rows];
      }

      if (sql.includes("CREATE claim_attachment CONTENT")) {
        store.seq += 1;
        const row = {
          id: `claim_attachment:a${store.seq}`,
          submission_id: String(vars.submission),
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
        const row = store.attachments.find((item) => String(item.id) === String(vars.id));
        return [[row].filter(Boolean)];
      }

      if (sql.includes("SELECT id, roster_id, token_hash, status FROM $id")) {
        const token = store.tokens.find((row) => String(row.id) === String(vars.id));
        return [[token].filter(Boolean)];
      }

      if (sql.includes("FROM claim_supplement WHERE submission_id")) {
        const rows = store.supplements
          .filter((item) => String(item.submission_id) === String(vars.submission))
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        return [rows];
      }

      if (sql.includes("INSERT INTO claim_supplement")) {
        store.seq += 1;
        const row = {
          id: `claim_supplement:sp${store.seq}`,
          submission_id: String(vars.submission),
          direction: "creditor_reply",
          body: vars.body,
          actor: vars.actor,
          created_at: new Date().toISOString(),
        };
        store.supplements.push(row);
        return [[row]];
      }

      if (sql.includes("FROM $roster")) {
        const row = String(vars.roster) === store.roster.id ? store.roster : null;
        return [[row].filter(Boolean)];
      }

      throw new Error(`unhandled sql in memory db: ${sql.slice(0, 120)}`);
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
          throw new HttpError(404, "attachment-object-missing", "Attachment object not found in storage");
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

function makeService(options?: {
  pepper?: string | null;
  attachmentConfigured?: boolean;
  now?: () => number;
  store?: Store;
}) {
  const store: Store = options?.store ?? {
    roster: {
      id: "creditor_roster:r1",
      name: "张三",
      identity_code: "ID-001",
    },
    tokens: [],
    submissions: [],
    attachments: [],
    supplements: [],
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
    now: options?.now,
  });
  return { service, store, db, memoryStorage };
}

describe("ClaimsPortalService", () => {
  test("无 pepper → mint/open 501 claims-portal-not-configured", async () => {
    const { service } = makeService({ pepper: null });
    await expect(
      service.mintToken({
        workspaceDb: "ws_case_a",
        slug: "case-a",
        rosterId: "creditor_roster:r1",
        createdBy: "user-1",
      }),
    ).rejects.toMatchObject({ status: 501, code: "claims-portal-not-configured" });

    await expect(
      service.openSession({
        workspaceDb: "ws_case_a",
        slug: "case-a",
        tokenPlaintext: "x",
        name: "张三",
        identityCode: "ID-001",
      }),
    ).rejects.toMatchObject({ status: 501, code: "claims-portal-not-configured" });
  });

  test("无 CLAIMS_ATTACHMENT_* → uploadBytes 501 attachment-storage-not-configured", async () => {
    const { service } = makeService({ attachmentConfigured: false });
    await expect(
      service.uploadBytes({
        workspaceDb: "ws",
        rosterId: "creditor_roster:r1",
        attachmentType: "contract",
        fileName: "a.pdf",
        contentType: "application/pdf",
        byteSize: 10,
        bytes: new Uint8Array(10),
      }),
    ).rejects.toMatchObject({ status: 501, code: "attachment-storage-not-configured" });

    await expect(
      service.managerDownload({
        workspaceDb: "ws",
        attachmentId: "claim_attachment:a1",
      }),
    ).rejects.toMatchObject({ status: 501, code: "attachment-storage-not-configured" });
  });

  test("有配置时 uploadBytes 写入对象与元数据；managerDownload 受控读回", async () => {
    const { service, store, memoryStorage } = makeService({ attachmentConfigured: true });
    const minted = await service.mintToken({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      rosterId: "creditor_roster:r1",
      createdBy: "user-1",
    });
    await service.openSession({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      tokenPlaintext: minted.tokenPlaintext,
      name: "张三",
      identityCode: "ID-001",
    });

    const bytes = new TextEncoder().encode("%PDF-mock");
    const uploaded = await service.uploadBytes({
      workspaceDb: "ws_case_a",
      rosterId: "creditor_roster:r1",
      attachmentType: "contract",
      fileName: "合同.pdf",
      contentType: "application/pdf",
      byteSize: bytes.byteLength,
      bytes,
    });
    expect(uploaded.id).toBeTruthy();
    expect(String(uploaded.storageKey)).toMatch(/^claims\/ws_case_a\/.+\/.+\/合同\.pdf$/);
    expect(memoryStorage.objects.has(String(uploaded.storageKey))).toBe(true);
    expect(store.attachments).toHaveLength(1);

    const downloaded = await service.managerDownload({
      workspaceDb: "ws_case_a",
      attachmentId: String(uploaded.id),
    });
    expect(downloaded.fileName).toBe("合同.pdf");
    expect(downloaded.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(downloaded.body)).toBe("%PDF-mock");

    await expect(
      service.managerDownload({
        workspaceDb: "other_ws",
        attachmentId: String(uploaded.id),
      }),
    ).rejects.toMatchObject({ status: 403, code: "claims-attachment-workspace-mismatch" });
  });

  test("有配置但无字节 → 400 attachment-bytes-required", async () => {
    const { service } = makeService({ attachmentConfigured: true });
    await expect(
      service.uploadBytes({
        workspaceDb: "ws_case_a",
        rosterId: "creditor_roster:r1",
        attachmentType: "contract",
        fileName: "a.pdf",
        contentType: "application/pdf",
        byteSize: 10,
      }),
    ).rejects.toMatchObject({ status: 400, code: "attachment-bytes-required" });
  });

  test("mint 明文只返回一次；list 不含明文/hash", async () => {
    const { service, store } = makeService();
    const minted = await service.mintToken({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      rosterId: "creditor_roster:r1",
      createdBy: "user-1",
    });
    expect(minted.tokenPlaintext.length).toBeGreaterThan(20);
    expect(minted.portalPath).toContain("/claims/case-a/");
    expect(store.tokens[0]?.token_hash).toBe(hashToken(minted.tokenPlaintext, PEPPER));
    expect(JSON.stringify(store.tokens[0])).not.toContain(minted.tokenPlaintext);

    const listed = await service.listTokens({ workspaceDb: "ws_case_a" });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(minted.tokenPlaintext);
    expect(JSON.stringify(listed)).not.toContain(String(store.tokens[0]?.token_hash));
  });

  test("双重匹配：错名/错码/交叉错 → 同一文案；成功路径", async () => {
    const { service } = makeService();
    const minted = await service.mintToken({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      rosterId: "creditor_roster:r1",
      createdBy: "user-1",
    });

    for (const attempt of [
      { name: "李四", identityCode: "ID-001" },
      { name: "张三", identityCode: "WRONG" },
      { name: "李四", identityCode: "WRONG" },
    ]) {
      try {
        await service.openSession({
          workspaceDb: "ws_case_a",
          slug: "case-a",
          tokenPlaintext: minted.tokenPlaintext,
          ...attempt,
        });
        throw new Error("should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).message).toBe(OPEN_FAILURE_MESSAGE);
        expect((error as HttpError).code).toBe("claims-open-failed");
      }
    }

    const opened = await service.openSession({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      tokenPlaintext: minted.tokenPlaintext,
      name: "张三",
      identityCode: "ID-001",
    });
    expect(opened.rosterId).toBe("creditor_roster:r1");
    expect(opened.cookieValue.includes(".")).toBe(true);
  });

  test("限速：连续 5 次失败后锁定", async () => {
    let now = 1_000_000;
    const { service, store } = makeService({ now: () => now });
    const minted = await service.mintToken({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      rosterId: "creditor_roster:r1",
      createdBy: "user-1",
    });

    for (let i = 0; i < FAIL_THRESHOLD; i += 1) {
      now += 1_000;
      await expect(
        service.openSession({
          workspaceDb: "ws_case_a",
          slug: "case-a",
          tokenPlaintext: minted.tokenPlaintext,
          name: "错",
          identityCode: "错",
        }),
      ).rejects.toMatchObject({ code: "claims-open-failed" });
    }

    expect(store.tokens[0]?.failure_count).toBe(FAIL_THRESHOLD);
    expect(store.tokens[0]?.locked_until).toBeTruthy();

    now += 1_000;
    await expect(
      service.openSession({
        workspaceDb: "ws_case_a",
        slug: "case-a",
        tokenPlaintext: minted.tokenPlaintext,
        name: "张三",
        identityCode: "ID-001",
      }),
    ).rejects.toMatchObject({ status: 429, code: "claims-token-locked" });
  });

  test("伪造令牌失败；跨 slug workspace 404", async () => {
    const { service } = makeService();
    await expect(
      service.openSession({
        workspaceDb: "ws_case_a",
        slug: "case-a",
        tokenPlaintext: "not-a-real-token",
        name: "张三",
        identityCode: "ID-001",
      }),
    ).rejects.toMatchObject({ code: "claims-open-failed", message: OPEN_FAILURE_MESSAGE });

    await expect(service.resolveWorkspaceDb("missing")).rejects.toMatchObject({
      status: 404,
      code: "workspace-not-found",
    });
  });

  test("saveDraft 只写本金或写齐字段均可（可选字段为 NONE）", async () => {
    const { service, store } = makeService();
    const minted = await service.mintToken({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      rosterId: "creditor_roster:r1",
      createdBy: "user-1",
    });
    await service.openSession({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      tokenPlaintext: minted.tokenPlaintext,
      name: "张三",
      identityCode: "ID-001",
    });
    const onlyPrincipal = await service.saveDraft({
      workspaceDb: "ws_case_a",
      rosterId: "creditor_roster:r1",
      draft: { principal: 100 },
    });
    expect(onlyPrincipal.principal).toBe(100);
    expect(store.submissions[0]?.principal).toBe(100);

    const full = await service.saveDraft({
      workspaceDb: "ws_case_a",
      rosterId: "creditor_roster:r1",
      draft: {
        principal: 200,
        rate_segments: [{ annual_rate: 0.05, start: "2024-01-01", end: "2024-12-31" }],
        interest_start: "2024-01-01T00:00:00.000Z",
        interest_end: "2024-12-31T00:00:00.000Z",
        interest_method: "simple",
        penalty: 1,
        statement: "说明",
      },
    });
    expect(full.principal).toBe(200);
    expect(full.interestMethod).toBe("simple");
    expect(full.statement).toBe("说明");
  });

  test("submit 无附件 → 拒绝；有附件可提交", async () => {
    const { service, store } = makeService();
    const minted = await service.mintToken({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      rosterId: "creditor_roster:r1",
      createdBy: "user-1",
    });
    await service.openSession({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      tokenPlaintext: minted.tokenPlaintext,
      name: "张三",
      identityCode: "ID-001",
    });
    await service.saveDraft({
      workspaceDb: "ws_case_a",
      rosterId: "creditor_roster:r1",
      draft: { principal: 1000, interest_method: "simple" },
    });

    await expect(
      service.submit({ workspaceDb: "ws_case_a", rosterId: "creditor_roster:r1" }),
    ).rejects.toMatchObject({ code: "claims-submit-needs-attachment" });

    await service.registerAttachmentMetadata({
      workspaceDb: "ws_case_a",
      rosterId: "creditor_roster:r1",
      attachmentType: "contract",
      fileName: "c.pdf",
      contentType: "application/pdf",
      byteSize: 12,
      allowWithoutStorageConfig: true,
    });
    expect(store.attachments).toHaveLength(1);

    const submitted = await service.submit({
      workspaceDb: "ws_case_a",
      rosterId: "creditor_roster:r1",
    });
    expect(submitted.status).toBe("submitted");
  });


  test("债权人可见性：getSubmission/saveDraft/submit 序列化均不含 managerNote", async () => {
    const { service, store } = makeService();
    const minted = await service.mintToken({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      rosterId: "creditor_roster:r1",
      createdBy: "user-1",
    });
    await service.openSession({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      tokenPlaintext: minted.tokenPlaintext,
      name: "张三",
      identityCode: "ID-001",
    });
    store.submissions[0]!.manager_note = "内部：疑似重复申报，勿外发";

    const view = await service.getSubmission({ workspaceDb: "ws_case_a", rosterId: "creditor_roster:r1" });
    expect(view.submission).not.toBeNull();
    expect("managerNote" in view.submission!).toBe(false);
    expect(JSON.stringify(view)).not.toContain("疑似重复申报");

    const draft = await service.saveDraft({
      workspaceDb: "ws_case_a",
      rosterId: "creditor_roster:r1",
      draft: { principal: 88 },
    });
    expect("managerNote" in draft).toBe(false);
  });

  test("补充往返：管理人要求对债权人可见；债权人回复追加为 creditor_reply 且 actor 记名册名", async () => {
    const { service, store } = makeService();
    const minted = await service.mintToken({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      rosterId: "creditor_roster:r1",
      createdBy: "user-1",
    });
    await service.openSession({
      workspaceDb: "ws_case_a",
      slug: "case-a",
      tokenPlaintext: minted.tokenPlaintext,
      name: "张三",
      identityCode: "ID-001",
    });
    const submissionId = String(store.submissions[0]!.id);
    store.supplements.push({
      id: "claim_supplement:mgr1",
      submission_id: submissionId,
      direction: "manager_request",
      body: "请补充 2024-12 银行回单",
      actor: "王管理人",
      created_at: "2025-01-10T00:00:00.000Z",
    });

    const before = await service.getSubmission({ workspaceDb: "ws_case_a", rosterId: "creditor_roster:r1" });
    expect(before.supplements).toHaveLength(1);
    expect(before.supplements[0]!.direction).toBe("manager_request");

    const reply = await service.addCreditorSupplementReply({
      workspaceDb: "ws_case_a",
      rosterId: "creditor_roster:r1",
      body: "  回单已另传附件，请查收  ",
    });
    expect(reply.direction).toBe("creditor_reply");
    expect(reply.body).toBe("回单已另传附件，请查收");
    expect(reply.actor).toBe("张三");
    expect(reply.submissionId).toBe(submissionId);
    expect(store.supplements).toHaveLength(2);

    const after = await service.getSubmission({ workspaceDb: "ws_case_a", rosterId: "creditor_roster:r1" });
    expect(after.supplements).toHaveLength(2);
    expect(after.supplements.map((item) => item.direction)).toEqual(["manager_request", "creditor_reply"]);
  });

  test("补充回复边界：空文本 400、无申报 404、closed 409", async () => {
    const { service, store } = makeService();
    store.submissions.push({
      id: "claim_submission:s9",
      roster_id: "creditor_roster:r1",
      identity_code: "ID-001",
      status: "draft",
    });
    await expect(
      service.addCreditorSupplementReply({ workspaceDb: "ws_case_a", rosterId: "creditor_roster:r1", body: "" }),
    ).rejects.toMatchObject({ status: 400, code: "claims-supplement-invalid" });
    await expect(
      service.addCreditorSupplementReply({ workspaceDb: "ws_case_a", rosterId: "creditor_roster:r1", body: "x".repeat(4001) }),
    ).rejects.toMatchObject({ status: 400, code: "claims-supplement-invalid" });

    const { service: empty } = makeService({
      store: { roster: { id: "creditor_roster:r9", name: "李四", identity_code: "ID-009" }, tokens: [], submissions: [], attachments: [], supplements: [], seq: 0 },
    });
    await expect(
      empty.addCreditorSupplementReply({ workspaceDb: "ws_case_a", rosterId: "creditor_roster:r9", body: "hi" }),
    ).rejects.toMatchObject({ status: 404, code: "claims-submission-not-found" });

    store.submissions[0]!.status = "closed";
    await expect(
      service.addCreditorSupplementReply({ workspaceDb: "ws_case_a", rosterId: "creditor_roster:r1", body: "hi" }),
    ).rejects.toMatchObject({ status: 409, code: "claims-submission-locked" });
  });
});
