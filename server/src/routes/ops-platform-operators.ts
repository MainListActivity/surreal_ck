import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import { requirePlatformOperator } from "../ops/operator-auth";
import {
  SurrealPlatformOperatorList,
  platformOperatorSubjectHash,
  toPlatformOperatorsView,
  type PlatformOperatorListPort,
} from "../ops/platform-operators";

/**
 * 平台运营主体清单（只读）。
 *
 * 公司侧要判断「给某个运营身份追加一项能力会不会连带提权其它主体」，需要能看到
 * `_system.platform_operator` 里究竟有几个主体、各自持有什么能力。此前没有任何只读
 * 接口能读这份名单（seed 是唯一写源），判断只能靠猜。
 *
 * 边界：
 * - 只注册 GET；不写任何数据（未命中任何 INSERT/UPDATE/DELETE）。
 * - 主体只以 `subject_hash`（sha256 前缀）出现，不回传原始 subject、邮箱或 display_name。
 * - 鉴权沿用 `requirePlatformOperator`，读能力用既有只读能力 `quota.read`，不新增能力。
 * - 每次调用写一条结构化审计日志（只含调用者哈希与主体数量，不含 PII）。
 */
export type PlatformOperatorsListAudit = Readonly<{
  event: "platform-operators.list";
  actorHash: string;
  operatorCount: number;
}>;

function defaultAudit(entry: PlatformOperatorsListAudit): void {
  console.info("[ops-audit] platform-operators.list", entry);
}

export function createOpsPlatformOperatorsRoutes(input: Readonly<{
  list?: PlatformOperatorListPort;
  requireOperator?: () => MiddlewareHandler<AppBindings>;
  audit?: (entry: PlatformOperatorsListAudit) => void;
}> = {}) {
  const list = input.list ?? new SurrealPlatformOperatorList();
  const requireOperator = input.requireOperator ?? (() => requirePlatformOperator("quota.read"));
  const audit = input.audit ?? defaultAudit;

  return new Hono<AppBindings>()
    .get("/api/ops/platform-operators", requireOperator(), async (c) => {
      const currentSubject = c.var.platformOperator.subject;
      const view = toPlatformOperatorsView(await list.list(), currentSubject);
      audit({
        event: "platform-operators.list",
        actorHash: platformOperatorSubjectHash(currentSubject),
        operatorCount: view.operators.length,
      });
      return c.json(view);
    });
}
