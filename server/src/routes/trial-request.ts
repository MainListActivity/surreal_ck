import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { PUBLIC_ACTION, TRIAL_PATH, publicRateLimited } from "@surreal-ck/shared/public-entry";
import { env } from "../env";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { publicProtection } from "../public-entry/protection";

const scenes = ["破产债权管理", "外部协作者门户", "保密日常协同", "债权人会议"] as const;
const form = z.strictObject({
  organization: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(50),
  contact: z.string().trim().min(3).max(120),
  scenes: z.array(z.enum(scenes)).min(1).max(scenes.length),
  requestKey: z.uuid(),
  turnstileToken: z.string().max(2048).optional(),
});
const denied = () => new HttpError(403, "trial-verification-failed", "安全验证失败，请重新验证后再试");
const unavailable = () => new HttpError(503, "trial-request-unavailable", "试用申请暂不可用，请稍后重试");

export function trialRequestCors(origin = env.TRIAL_REQUEST_ORIGIN) {
  return cors({
    origin: requestOrigin => requestOrigin === origin ? requestOrigin : undefined,
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    exposeHeaders: ["Retry-After"],
  });
}

export function createTrialRequestRoutes(options: {
  origin?: string;
  feedbackUrl?: string;
  request?: typeof fetch;
  protection?: typeof publicProtection;
} = {}) {
  const origin = options.origin ?? env.TRIAL_REQUEST_ORIGIN;
  const callback = options.feedbackUrl ?? env.TRIAL_FEEDBACK_URL;
  const request = options.request ?? fetch;
  const protection = options.protection ?? publicProtection;
  return new Hono<AppBindings>().post(TRIAL_PATH, bodyLimit({ maxSize: 8192 }), async c => {
    if (!origin || !callback) throw unavailable();
    const endpoint = new URL(callback);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^\/api\/feedback\/[a-z][a-z0-9_-]{0,40}$/u.test(endpoint.pathname)) throw unavailable();
    if (c.req.header("origin") !== origin || !c.req.header("content-type")?.startsWith("application/json")) throw denied();
    const parsed = form.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "trial-request-invalid", "请检查必填项和输入长度");
    const data = parsed.data;
    const blocked = await protection.challenge(c, PUBLIC_ACTION.trial, TRIAL_PATH, data.turnstileToken, denied);
    if (blocked) return blocked;
    let reply: Response;
    try {
      reply = await request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          requestKey: data.requestKey,
          text: `官网试用申请\n机构：${data.organization}\n场景：${[...new Set(data.scenes)].sort().join("、")}`,
          page: new URL("/trial/", origin).href,
          contact: `联系人：${data.name}\n联系方式：${data.contact}`,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw unavailable();
    }
    if (reply.status === 429) return publicRateLimited(3600);
    if (reply.status === 409) throw new HttpError(409, "trial-request-conflict", "表单内容已变更，请刷新页面后重新提交");
    if (reply.status !== 202) throw unavailable();
    const receipt = z.object({ ok: z.literal(true), result: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u) }) })
      .safeParse(await reply.json().catch(() => null));
    if (!receipt.success) throw unavailable();
    return c.json({ receipt: receipt.data.result.id }, 202);
  });
}
