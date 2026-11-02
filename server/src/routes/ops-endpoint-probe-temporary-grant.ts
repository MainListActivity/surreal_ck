import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { requirePlatformOperator } from "../ops/operator-auth";
import {
  configuredTemporaryGranteeSubject,
  configuredTemporaryGrantorSubject,
  EndpointProbeTemporaryGrantService,
  type EndpointProbeTemporaryGrantView,
} from "../ops/endpoint-probe-temporary-grant";
import { platformOperatorSubjectHash } from "../ops/platform-operators";

/**
 * 探针临时授权控制面（只服务 internal-ai.endpoint-probe）。
 *
 * - 授予/撤回：调用者必须是部署配置的 grantor，且不得自授；被授权主体固定为配置的 grantee。
 * - 状态读：grantor 可查被授权主体；被授权主体可查自己；其它主体 403。
 * - 不改 CSV、不写永久 capability 行；到期/撤回后旧会话下次请求即失效。
 */
const reasonSchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
  expectedVersion: z.number().int().min(0).optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
}).strict();

type AuditEvent =
  | "endpoint-probe-temporary-grant.grant"
  | "endpoint-probe-temporary-grant.revoke"
  | "endpoint-probe-temporary-grant.status";

function defaultAudit(event: AuditEvent, payload: Record<string, unknown>): void {
  console.info(`[ops-audit] ${event}`, payload);
}

function redactView(view: EndpointProbeTemporaryGrantView): EndpointProbeTemporaryGrantView {
  return view;
}

export function createOpsEndpointProbeTemporaryGrantRoutes(input: Readonly<{
  service?: EndpointProbeTemporaryGrantService;
  /** 授予/撤回鉴权；默认只要是有效运营主体即可进入路由，主体约束在服务内再校验。 */
  requireManager?: () => MiddlewareHandler<AppBindings>;
  requireReader?: () => MiddlewareHandler<AppBindings>;
  audit?: (event: AuditEvent, payload: Record<string, unknown>) => void;
}> = {}) {
  const service = input.service ?? new EndpointProbeTemporaryGrantService();
  // 用 quota.read 作为“有效运营主体”门槛；真正的 grantor/grantee 约束在服务内按部署配置校验。
  // 这样不会新造万能权限，也不会让仅持探针临时能力的主体自授/延长。
  const requireManager = input.requireManager ?? (() => requirePlatformOperator("quota.read"));
  const requireReader = input.requireReader ?? (() => requirePlatformOperator("quota.read"));
  const audit = input.audit ?? defaultAudit;

  return new Hono<AppBindings>()
    .get("/api/ops/internal-ai/endpoint-probe/temporary-grant", requireReader(), async (c) => {
      const actor = c.var.platformOperator.subject;
      const grantee = configuredTemporaryGranteeSubject();
      if (!grantee) throw new HttpError(503, "endpoint-probe-temporary-grant-not-configured", "探针临时授权引导主体未配置");
      // 只允许 grantor 或被授权主体本人读状态；其它运营主体拒绝，避免名单探测。
      const grantor = configuredTemporaryGrantorSubject();
      if (actor !== grantor && actor !== grantee) {
        throw new HttpError(403, "endpoint-probe-temporary-grant-forbidden", "当前主体不能读取探针临时授权状态");
      }
      const view = redactView(await service.getStatusFor(grantee));
      audit("endpoint-probe-temporary-grant.status", {
        actorHash: platformOperatorSubjectHash(actor),
        subjectHash: view.subjectHash,
        status: view.status,
        permanentActive: view.permanentActive,
      });
      return c.json(view);
    })
    .post("/api/ops/internal-ai/endpoint-probe/temporary-grant", requireManager(), async (c) => {
      if (new URL(c.req.url).search.length > 0) {
        throw new HttpError(400, "endpoint-probe-temporary-grant-input-rejected", "临时授权不接受查询串");
      }
      let payload: unknown = {};
      if ((c.req.raw.body ?? null) !== null) {
        try { payload = await c.req.json(); }
        catch { throw new HttpError(400, "endpoint-probe-temporary-grant-body-invalid", "请求体不是合法 JSON"); }
      }
      const parsed = reasonSchema.safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "endpoint-probe-temporary-grant-body-invalid", "临时授权参数不合法");
      const actor = c.var.platformOperator.subject;
      const view = redactView(await service.grant({
        actorSubject: actor,
        reason: parsed.data.reason,
        expectedVersion: parsed.data.expectedVersion,
        idempotencyKey: parsed.data.idempotencyKey,
      }));
      audit("endpoint-probe-temporary-grant.grant", {
        actorHash: platformOperatorSubjectHash(actor),
        subjectHash: view.subjectHash,
        status: view.status,
        notAfter: view.notAfter,
        version: view.version,
        permanentActive: view.permanentActive,
      });
      return c.json(view);
    })
    .post("/api/ops/internal-ai/endpoint-probe/temporary-grant/revoke", requireManager(), async (c) => {
      if (new URL(c.req.url).search.length > 0) {
        throw new HttpError(400, "endpoint-probe-temporary-grant-input-rejected", "临时授权不接受查询串");
      }
      let payload: unknown = {};
      if ((c.req.raw.body ?? null) !== null) {
        try { payload = await c.req.json(); }
        catch { throw new HttpError(400, "endpoint-probe-temporary-grant-body-invalid", "请求体不是合法 JSON"); }
      }
      const parsed = reasonSchema.safeParse(payload);
      if (!parsed.success) throw new HttpError(400, "endpoint-probe-temporary-grant-body-invalid", "临时授权参数不合法");
      const actor = c.var.platformOperator.subject;
      const view = redactView(await service.revoke({
        actorSubject: actor,
        reason: parsed.data.reason,
        expectedVersion: parsed.data.expectedVersion,
      }));
      audit("endpoint-probe-temporary-grant.revoke", {
        actorHash: platformOperatorSubjectHash(actor),
        subjectHash: view.subjectHash,
        status: view.status,
        version: view.version,
        permanentActive: view.permanentActive,
      });
      return c.json(view);
    });
}
