import { PUBLIC_ACTION } from "@surreal-ck/shared/public-entry";
import { bodyLimit } from "hono/body-limit";
import { publicProtection } from "../public-entry/protection";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { claimCsvCell } from "@surreal-ck/shared/claims-portal";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requireOidc } from "../middleware/oidc";
import { ClaimsPortalService } from "../claims-portal/service";
import { renderClaimRecordPdf } from "../claims-portal/record-pdf";
import { OPEN_FAILURE_MESSAGE, SESSION_COOKIE_NAME } from "../claims-portal/constants";

export type ClaimsPortalRouteOptions = {
  protection?: typeof publicProtection;
  service?: ClaimsPortalService;
  requireUser?: () => MiddlewareHandler<AppBindings>;
};

function assertAdminScope(user: AppBindings["Variables"]["user"], dbName: string): void {
  const raw = user.raw as { db?: unknown; ac?: unknown };
  if (raw.db !== dbName || raw.ac !== "admin") {
    throw new HttpError(403, "claims-portal-scope-mismatch", "需要目标工作区的 admin 身份");
  }
}

function readJsonBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createClaimsPortalRoutes(
  options: ClaimsPortalRouteOptions = {},
): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();
  const protection = options.protection ?? publicProtection;
  const service = options.service ?? new ClaimsPortalService();
  const requireUser = options.requireUser ?? requireOidc;

  // ── 公开：债权人令牌入口 ──────────────────────────────────────────────

  const denied = () => new HttpError(401, "claims-open-failed", OPEN_FAILURE_MESSAGE);
  routes.post("/api/claims-portal/:slug/:token/session", bodyLimit({ maxSize: 8192 }), async (c) => {
    const slug = c.req.param("slug");
    const token = c.req.param("token");
    const body = readJsonBody(await c.req.json().catch(() => null));
    const blocked = await protection.challenge(c, PUBLIC_ACTION.claims, JSON.stringify([slug, token]), body.turnstileToken, denied);
    if (blocked) return blocked;
    const name = typeof body.name === "string" ? body.name : "";
    const identityCode =
      typeof body.identityCode === "string"
        ? body.identityCode
        : typeof body.identity_code === "string"
          ? body.identity_code
          : "";
    if (!name.trim() || !identityCode.trim()) {
      throw new HttpError(400, "claims-open-invalid", "name and identityCode are required");
    }

    const opened = await (async () => {
      try {
        const workspaceDb = await service.resolveWorkspaceDb(slug);
        return await service.openSession({ workspaceDb, slug, tokenPlaintext: token, name, identityCode });
      } catch (error) {
        if (protection.enabled && error instanceof HttpError &&
          ["workspace-not-found", "claims-token-locked"].includes(error.code)) throw denied();
        throw error;
      }
    })();

    setCookie(c, SESSION_COOKIE_NAME, opened.cookieValue, {
      httpOnly: true,
      sameSite: "Lax",
      path: `/api/claims-portal/${encodeURIComponent(slug)}/`,
      expires: new Date(opened.exp),
      secure: true,
    });

    return c.json({ ok: true, rosterId: opened.rosterId, exp: opened.exp });
  });

  async function readPortalRecord(c: Context<AppBindings, "/api/claims-portal/:slug/:token/submission">) {
    const slug = c.req.param("slug");
    const token = c.req.param("token");
    const workspaceDb = await service.resolveWorkspaceDb(slug);
    const session = service.verifyPortalSession({
      cookieRaw: getCookie(c, SESSION_COOKIE_NAME),
      slug,
      tokenPlaintext: token,
    });
    await service.assertTokenMatchesSession({
      workspaceDb,
      tokenPlaintext: token,
      tokenId: session.tokenId,
      rosterId: session.rosterId,
    });
    return service.getSubmission({
      workspaceDb,
      rosterId: session.rosterId,
    });
  }

  const verifyWrite: MiddlewareHandler<AppBindings, "/api/claims-portal/:slug/:token/*"> = async (c, next) => {
    const key = JSON.stringify([c.req.param("slug"), c.req.param("token")]);
    const blocked = await protection.challenge(c, PUBLIC_ACTION.claimsWrite, key, c.req.header("x-turnstile-token"), denied);
    return blocked ?? next();
  };

  routes.get("/api/claims-portal/:slug/:token/submission", async (c) => {
    const result = await readPortalRecord(c);
    return c.json({ ok: true, ...result });
  });

  routes.get("/api/claims-portal/:slug/:token/submission.pdf", async (c) => {
    const record = await readPortalRecord(c);
    if (!record.submission || record.submission.status === "draft") {
      throw new HttpError(409, "claims-not-submitted", "提交申报后才能下载往来记录");
    }
    const pdf = await renderClaimRecordPdf(record, record.submission);
    return c.body(new Uint8Array(pdf), 200, {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="claim-record.pdf"',
      "Referrer-Policy": "no-referrer",
    });
  });

  routes.put("/api/claims-portal/:slug/:token/submission", async (c) => {
    const slug = c.req.param("slug");
    const token = c.req.param("token");
    const body = readJsonBody(await c.req.json().catch(() => null));
    const workspaceDb = await service.resolveWorkspaceDb(slug);
    const session = service.verifyPortalSession({
      cookieRaw: getCookie(c, SESSION_COOKIE_NAME),
      slug,
      tokenPlaintext: token,
    });
    await service.assertTokenMatchesSession({
      workspaceDb,
      tokenPlaintext: token,
      tokenId: session.tokenId,
      rosterId: session.rosterId,
    });
    const submission = await service.saveDraft({
      workspaceDb,
      rosterId: session.rosterId,
      draft: body,
    });
    return c.json({ ok: true, submission });
  });

  routes.post("/api/claims-portal/:slug/:token/submission/submit", verifyWrite, async (c) => {
    const slug = c.req.param("slug");
    const token = c.req.param("token");
    const workspaceDb = await service.resolveWorkspaceDb(slug);
    const session = service.verifyPortalSession({
      cookieRaw: getCookie(c, SESSION_COOKIE_NAME),
      slug,
      tokenPlaintext: token,
    });
    await service.assertTokenMatchesSession({
      workspaceDb,
      tokenPlaintext: token,
      tokenId: session.tokenId,
      rosterId: session.rosterId,
    });
    const submission = await service.submit({
      workspaceDb,
      rosterId: session.rosterId,
    });
    return c.json({ ok: true, submission });
  });

  routes.post("/api/claims-portal/:slug/:token/submission/supplement", verifyWrite, async (c) => {
    const slug = c.req.param("slug");
    const token = c.req.param("token");
    const body = readJsonBody(await c.req.json().catch(() => null));
    const workspaceDb = await service.resolveWorkspaceDb(slug);
    const session = service.verifyPortalSession({
      cookieRaw: getCookie(c, SESSION_COOKIE_NAME),
      slug,
      tokenPlaintext: token,
    });
    await service.assertTokenMatchesSession({
      workspaceDb,
      tokenPlaintext: token,
      tokenId: session.tokenId,
      rosterId: session.rosterId,
    });
    const supplement = await service.addCreditorSupplementReply({
      workspaceDb,
      rosterId: session.rosterId,
      body: typeof body.body === "string" ? body.body : "",
      requestId: body.requestId,
      attachmentIds: body.attachmentIds,
    });
    return c.json({ ok: true, supplement });
  });

  routes.post("/api/claims-portal/:slug/:token/attachments", verifyWrite, async (c) => {
    const slug = c.req.param("slug");
    const token = c.req.param("token");
    const workspaceDb = await service.resolveWorkspaceDb(slug);
    const session = service.verifyPortalSession({
      cookieRaw: getCookie(c, SESSION_COOKIE_NAME),
      slug,
      tokenPlaintext: token,
    });
    await service.assertTokenMatchesSession({
      workspaceDb,
      tokenPlaintext: token,
      tokenId: session.tokenId,
      rosterId: session.rosterId,
    });

    // 缺附件存储配置时先 fail-closed，不把 multipart/字节体读入内存再 501。
    service.assertAttachmentStorageConfigured();
    const contentType = c.req.header("content-type") ?? "";
    let attachmentType: unknown;
    let fileName: unknown;
    let mime: unknown;
    let byteSize: unknown;
    let bytes: Uint8Array | undefined;

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      attachmentType = form.attachmentType ?? form.attachment_type;
      const file = form.file;
      if (file instanceof File) {
        fileName = file.name;
        mime = file.type || form.contentType || form.content_type;
        const buffer = new Uint8Array(await file.arrayBuffer());
        bytes = buffer;
        byteSize = buffer.byteLength;
      } else {
        fileName = form.fileName ?? form.file_name;
        mime = form.contentType ?? form.content_type;
        byteSize = form.byteSize ?? form.byte_size;
      }
    } else {
      const body = readJsonBody(await c.req.json().catch(() => null));
      attachmentType = body.attachmentType ?? body.attachment_type;
      fileName = body.fileName ?? body.file_name;
      mime = body.contentType ?? body.content_type;
      byteSize = body.byteSize ?? body.byte_size;
      if (typeof body.bytesBase64 === "string") {
        bytes = Uint8Array.from(Buffer.from(body.bytesBase64, "base64"));
        byteSize = bytes.byteLength;
      }
    }

    const attachment = await service.uploadBytes({
      workspaceDb,
      rosterId: session.rosterId,
      attachmentType,
      fileName,
      contentType: mime,
      byteSize,
      bytes,
    });
    return c.json({ ok: true, attachment });
  });

  // ── 管理人：OIDC + workspace admin ────────────────────────────────────

  routes.post("/api/workspaces/:slug/claims-portal/tokens", requireUser(), async (c) => {
    const slug = c.req.param("slug");
    const workspaceDb = await service.resolveWorkspaceDb(slug);
    assertAdminScope(c.var.user, workspaceDb);
    const body = readJsonBody(await c.req.json().catch(() => null));
    const rosterId = typeof body.rosterId === "string"
      ? body.rosterId
      : typeof body.roster_id === "string"
        ? body.roster_id
        : "";
    if (!rosterId) {
      throw new HttpError(400, "claims-roster-id-required", "rosterId is required");
    }
    const minted = await service.mintToken({
      workspaceDb,
      slug,
      rosterId,
      createdBy: c.var.user.subject,
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      tokenPlaintext: minted.tokenPlaintext,
      tokenId: minted.tokenId,
      portalPath: minted.portalPath,
      status: minted.status,
    });
  });

  routes.post("/api/workspaces/:slug/claims-portal/tokens:batch", requireUser(), async (c) => {
    const slug = c.req.param("slug");
    const workspaceDb = await service.resolveWorkspaceDb(slug);
    assertAdminScope(c.var.user, workspaceDb);
    const body = readJsonBody(await c.req.json().catch(() => null));
    const caller = URL.parse(c.req.header("origin") ?? "");
    const origin = caller && ["http:", "https:"].includes(caller.protocol) ? caller.origin : new URL(c.req.url).origin;
    const issued = await service.mintTokenBatch({
      workspaceDb, slug, rosterIds: body.rosterIds, createdBy: c.var.user.subject,
    });
    const lines = issued.map((row) => [row.name, row.identityCode, `${origin}${row.portalPath}`].map(claimCsvCell).join(","));
    return c.body(`\uFEFF名称,识别码,链接\r\n${lines.join("\r\n")}\r\n`, 200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="claims-portal-links.csv"',
    });
  });

  routes.delete("/api/workspaces/:slug/claims-portal/tokens/:tokenId", requireUser(), async (c) => {
    const workspaceDb = await service.resolveWorkspaceDb(c.req.param("slug"));
    assertAdminScope(c.var.user, workspaceDb);
    await service.revokeToken({ workspaceDb, tokenId: c.req.param("tokenId"), actor: c.var.user.subject });
    return c.json({ ok: true });
  });

  routes.get("/api/workspaces/:slug/claims-portal/tokens", requireUser(), async (c) => {
    const slug = c.req.param("slug");
    const workspaceDb = await service.resolveWorkspaceDb(slug);
    assertAdminScope(c.var.user, workspaceDb);
    const tokens = await service.listTokens({ workspaceDb });
    return c.json({ ok: true, tokens });
  });

  routes.get("/api/workspaces/:slug/claims-portal/submissions", requireUser(), async (c) => {
    const slug = c.req.param("slug");
    const workspaceDb = await service.resolveWorkspaceDb(slug);
    assertAdminScope(c.var.user, workspaceDb);
    const submissions = await service.managerListSubmissions({ workspaceDb });
    return c.json({ ok: true, submissions });
  });

  routes.get(
    "/api/workspaces/:slug/claims-portal/attachments/:attachmentId/download",
    requireUser(),
    async (c) => {
      const slug = c.req.param("slug");
      const attachmentId = c.req.param("attachmentId");
      const workspaceDb = await service.resolveWorkspaceDb(slug);
      assertAdminScope(c.var.user, workspaceDb);
      const downloaded = await service.managerDownload({ workspaceDb, attachmentId });
      const safeName = downloaded.fileName.replace(/["\r\n]/g, "_");
      return new Response(downloaded.body, {
        status: 200,
        headers: {
          "content-type": downloaded.contentType,
          "content-length": String(downloaded.byteSize),
          "content-disposition": `attachment; filename="${safeName}"`,
          "cache-control": "private, no-store",
        },
      });
    },
  );

  return routes;
}
