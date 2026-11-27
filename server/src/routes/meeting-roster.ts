import { isIP } from "node:net";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { env } from "../env";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { MAX_ROSTER_BATCH, rosterDenied, RosterMeetingService } from "../meeting/roster";
import { archiveConfigSchema } from "../meeting/roster-archive";
import type { MeetingEvidenceArchive } from "../meeting/evidence-archive";
import { renderVoteReceipt } from "../meeting/roster-receipt-pdf";
import { castVoteSchema, openPollSchema } from "../meeting/roster-votes";
import { requireOidc } from "../middleware/oidc";

const adminPath = "/api/workspaces/:slug/roster-meetings";
const publicPath = "/api/meeting/roster";
const cookieName = "__Secure-meeting-roster";
const recordId = z.string().min(3).max(512);
const key = z.string().trim().min(1).max(128);
const createBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  scheduled_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }).optional(),
  sheet_id: recordId,
  display_field: key.optional(),
  check_field: key.optional(),
  check_label: key.optional(),
  check_mode: z.enum(["full", "suffix4"]).optional(),
  admission: z.enum(["direct", "waiting"]).optional(),
  concurrency: z.enum(["replace", "reject"]).optional(),
  preset_key: key.optional(),
});
const verifyBody = z.strictObject({
  pass: z.string().max(160),
  code: z.string().max(32),
  check: z.string().max(512).optional(),
});
const batchBody = z.strictObject({ row_ids: z.array(recordId).min(1).max(MAX_ROSTER_BATCH) });
const reissueBody = z.strictObject({ row_id: recordId });
const generationBody = z.strictObject({ generation: z.number().int().positive() });
const moderationBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("lock"), locked: z.boolean() }),
  z.strictObject({ action: z.literal("focus"), focus: z.enum(["auto", "speaker", "screen"]) }),
  z.strictObject({ action: z.literal("allow"), identity: z.uuid() }),
  z.strictObject({ action: z.literal("withdraw"), identity: z.uuid() }),
  z.strictObject({ action: z.literal("mute-all") }),
]);

type Options = {
  service?: RosterMeetingService;
  origin?: string;
  trustedProxy?: boolean;
  requireUser?: () => MiddlewareHandler<AppBindings>;
  sourceIp?: (c: Context<AppBindings>) => string;
  evidence?: MeetingEvidenceArchive;
};

function csvCell(value: string): string {
  const safe = /^[\s\uFEFF]*[=+\-@＝＋－＠]/u.test(value) || /^[\r\n\t]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function configuredOrigin(value: string | undefined): string {
  const url = value && URL.canParse(value) ? new URL(value) : undefined;
  if (!url || url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new HttpError(503, "meeting-roster-unavailable", "名册会议服务尚未启用");
  }
  return url.origin;
}

function clientIp(c: Context<AppBindings>, proxy: boolean): string {
  const edge = c.req.header("cf-connecting-ip");
  if (proxy && edge && isIP(edge)) return edge;
  const bun = c.env as { requestIP?(request: Request): { address: string } | null } | undefined;
  return bun?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

async function json(c: Context<AppBindings>, limit: number): Promise<unknown> {
  if (Number(c.req.header("content-length") ?? "0") > limit) return null;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(buffer + decoder.decode()) as unknown;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function input<T>(c: Context<AppBindings>, schema: z.ZodType<T>, limit = 4096): Promise<T> {
  const parsed = schema.safeParse(await json(c, limit));
  if (!parsed.success) throw new HttpError(400, "meeting-roster-invalid", "名册会议参数无效");
  return parsed.data;
}

function param(c: Context<AppBindings>, name: "slug" | "meeting" | "pass" | "poll"): string {
  const value = c.req.param(name);
  if (!value) throw new HttpError(400, "meeting-roster-invalid", "名册会议参数无效");
  return value;
}

export function createMeetingRosterRoutes(options: Options = {}) {
  const app = new Hono<AppBindings>();
  const service = options.service ?? new RosterMeetingService();
  const origin = options.origin ?? env.MEETING_ROSTER_ORIGIN;
  const proxy = options.trustedProxy ?? env.MEETING_GUEST_TRUST_PROXY === "1";
  const oidc = (options.requireUser ?? requireOidc)();

  const headers: MiddlewareHandler<AppBindings> = async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  };
  const dbs = new WeakMap<Request, string>();
  const admin: MiddlewareHandler<AppBindings> = async (c, next) => {
    const database = await service.workspaceDb(param(c, "slug"));
    const raw = c.var.user.raw;
    if (raw.db !== database || raw.ac !== "admin") {
      throw new HttpError(403, "meeting-roster-admin-required", "需要目标工作区的管理员身份");
    }
    service.assertEnabled();
    dbs.set(c.req.raw, database);
    await next();
  };
  const database = (c: Context<AppBindings>) => dbs.get(c.req.raw)!;
  const hostActor = (c: Context<AppBindings>) => {
    const { exp, name } = c.var.user.raw;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 <= Date.now()) throw rosterDenied();
    return {
      workspace: database(c), subject: c.var.user.subject, expiresAt: exp * 1000, workspaceAdmin: true,
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 96) : "主持人",
    };
  };
  const requireOrigin: MiddlewareHandler<AppBindings> = async (c, next) => {
    service.assertEnabled();
    if (c.req.header("origin") !== configuredOrigin(origin)) throw rosterDenied();
    await next();
  };
  const csv = (c: Context<AppBindings>, site: string, entries: { name: string; code: string; pass: string; checkLabel?: string }[]) => {
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="roster-meeting-invitations.csv"');
    return c.body("\uFEFF姓名,访问码,参会链接\r\n" + entries.map(({ name, code, pass, checkLabel }) => {
      const hint = checkLabel ? `&check_label=${encodeURIComponent(checkLabel)}` : "";
      return [name, code, `${site}/meeting/roster#pass=${encodeURIComponent(pass)}${hint}`].map(csvCell).join(",");
    }).join("\r\n") + "\r\n");
  };

  app.use(publicPath + "/*", headers);
  app.post(publicPath + "/verify", requireOrigin, async (c) => {
    const parsed = verifyBody.safeParse(await json(c, 2048));
    const result = await service.verify(parsed.success ? parsed.data : { pass: "", code: "" },
      options.sourceIp?.(c) ?? clientIp(c, proxy), c.req.header("user-agent"));
    setCookie(c, cookieName, result.cookie, {
      path: publicPath, secure: true, httpOnly: true, sameSite: "Strict", maxAge: result.maxAge,
    });
    return c.json({ state: result.state, title: result.title, name: result.name, check_label: result.check_label, recording: result.recording });
  });
  app.get(publicPath + "/session", async (c) => c.json(await service.session(getCookie(c, cookieName))));
  app.post(publicPath + "/credentials", requireOrigin, async (c) => {
    const confirmation = await json(c, 256);
    const consent = z.strictObject({ consent: z.literal(true) }).safeParse(confirmation).success;
    return c.json(await service.credentials(getCookie(c, cookieName), consent));
  });
  app.post(publicPath + "/raise-hand", requireOrigin, async (c) => {
    await service.raiseHand(getCookie(c, cookieName));
    return c.body(null, 204);
  });
  app.get(publicPath + "/polls", async (c) => c.json({ polls: await service.polls(getCookie(c, cookieName)) }));
  app.post(publicPath + "/polls/:poll/vote", requireOrigin, async (c) =>
    c.json(await service.vote(getCookie(c, cookieName), param(c, "poll"), await input(c, castVoteSchema))));
  app.get(publicPath + "/polls/:poll/receipt.pdf", async (c) => {
    const pdf = await renderVoteReceipt(await service.voteReceipt(getCookie(c, cookieName), param(c, "poll")));
    return c.body(new Uint8Array(pdf), 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="meeting-vote-receipt.pdf"',
      "X-Content-Type-Options": "nosniff",
    });
  });

  const evidencePath = adminPath + "/:meeting/evidence";
  app.use(evidencePath + "/*", (c, next) => {
    if (!c.req.header("authorization")) throw new HttpError(403, "meeting-evidence-denied", "无权下载会议存证包");
    return next();
  });
  app.use(adminPath + "/:meeting/*", headers, oidc, admin);
  const evidence = () => {
    if (!options.evidence) throw new HttpError(503, "meeting-evidence-unavailable", "会议存证服务尚未启用");
    return options.evidence;
  };
  app.get(evidencePath + "/status", async (c) =>
    c.json(await evidence().status(database(c), param(c, "meeting"))));
  app.post(evidencePath + "/finalize", async (c) => {
    await service.queueEvidence(database(c), param(c, "meeting"));
    return c.body(null, 202);
  });
  app.post(evidencePath + "/grant", async (c) => {
    const meeting = param(c, "meeting");
    const { token, ...grant } = await evidence().grant(database(c), meeting, c.var.user.subject);
    const path = evidencePath.replace(":slug", encodeURIComponent(param(c, "slug")))
      .replace(":meeting", encodeURIComponent(meeting)) + "/download";
    return c.json({ ...grant, url: `${path}?ticket=${encodeURIComponent(token)}` });
  });
  app.get(evidencePath + "/download", async (c) => {
    const blob = await evidence().download(database(c), param(c, "meeting"), c.var.user.subject, c.req.query("ticket") ?? "");
    return new Response(blob, { headers: {
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      "Content-Type": "application/x-tar", "Content-Disposition": 'attachment; filename="meeting-evidence.tar"',
    } });
  });
  app.get(adminPath, headers, oidc, admin, async (c) => c.json({ meetings: await service.list(database(c)) }));
  app.post(adminPath, headers, oidc, admin, async (c) => c.json(await service.create(database(c), c.var.user.subject, await input(c, createBody)), 201));
  app.get(adminPath + "/:meeting/passes", async (c) => c.json({
    passes: await service.passes(database(c), param(c, "meeting")),
  }));
  app.post(adminPath + "/:meeting/passes", async (c) => {
    const site = configuredOrigin(origin);
    const { row_ids } = await input(c, batchBody, 512_000);
    return csv(c, site, await service.issue(database(c), param(c, "slug"), param(c, "meeting"), row_ids, c.var.user.subject));
  });
  app.post(adminPath + "/:meeting/passes/reissue", async (c) => {
    const site = configuredOrigin(origin);
    const { row_id } = await input(c, reissueBody);
    return csv(c, site, await service.issue(database(c), param(c, "slug"), param(c, "meeting"), [row_id], c.var.user.subject, true));
  });
  app.delete(adminPath + "/:meeting/passes/:pass", async (c) => {
    await service.revoke(database(c), param(c, "meeting"), param(c, "pass"), c.var.user.subject);
    return c.body(null, 204);
  });
  app.post(adminPath + "/:meeting/start", async (c) => {
    return c.json(await service.start(hostActor(c), param(c, "meeting")), 201);
  });
  app.post(adminPath + "/:meeting/end", async (c) => {
    await service.end(hostActor(c), param(c, "meeting"));
    return c.body(null, 204);
  });
  app.get(adminPath + "/:meeting/moderation", async (c) => c.json(await service.moderation(hostActor(c), param(c, "meeting"))));
  app.post(adminPath + "/:meeting/moderation", async (c) =>
    c.json(await service.moderation(hostActor(c), param(c, "meeting"), await input(c, moderationBody))));
  app.get(adminPath + "/:meeting/polls", async (c) =>
    c.json({ polls: await service.hostPolls(database(c), param(c, "meeting")) }));
  app.post(adminPath + "/:meeting/polls", async (c) =>
    c.json(await service.openPoll(hostActor(c), param(c, "meeting"), await input(c, openPollSchema, 8192)), 201));
  app.get(adminPath + "/:meeting/archive-config", async (c) =>
    c.json(await service.archiveConfig(database(c), param(c, "meeting"))));
  app.put(adminPath + "/:meeting/archive-config", async (c) =>
    c.json(await service.bindArchive(database(c), param(c, "meeting"), await input(c, archiveConfigSchema))));
  app.post(adminPath + "/:meeting/archive", async (c) =>
    c.json(await service.archive(hostActor(c), param(c, "meeting"))));
  app.get(adminPath + "/:meeting/waiting", async (c) => c.json({
    waiting: await service.waiting(database(c), param(c, "meeting")),
  }));
  for (const action of ["admit", "reject", "kick"] as const) {
    app.post(adminPath + `/:meeting/passes/:pass/${action}`, async (c) => {
      const { generation } = await input(c, generationBody);
      await service.decide(database(c), param(c, "meeting"), param(c, "pass"), generation, action, c.var.user.subject);
      return c.body(null, 204);
    });
  }
  return app;
}
