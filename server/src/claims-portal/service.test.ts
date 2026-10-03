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

      if (sql.includes("SELECT id, roster_id, token_hash, status FROM $id")) {
        const token = store.tokens.find((row) => String(row.id) === String(vars.id));
        return [[token].filter(Boolean)];
      }

      throw new Error(`unhandled sql in memory db: ${sql.slice(0, 120)}`);
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
    seq: 0,
  };
  const db = createMemoryDb(store);
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
    now: options?.now,
  });
  return { service, store, db };
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
      }),
    ).rejects.toMatchObject({ status: 501, code: "attachment-storage-not-configured" });

    await expect(
      service.managerPresignedDownload({
        workspaceDb: "ws",
        attachmentId: "claim_attachment:a1",
      }),
    ).rejects.toMatchObject({ status: 501, code: "attachment-storage-not-configured" });
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
});
