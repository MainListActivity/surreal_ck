/**
 * 漏斗事件白名单：与 shared/sql/system/040-funnel-event-count.surql 的 event ASSERT
 * 保持一致。运营汇总端点只接受这里的取值，不做任意筛选。
 */
export const FUNNEL_EVENT_NAMES = [
  "invite_issued",
  "first_login",
  "template_created",
  "import_succeeded",
  "first_success",
  "ai_proposal_adopted",
  "return_week2",
] as const;

export type FunnelEventName = (typeof FUNNEL_EVENT_NAMES)[number];

export function isFunnelEventName(value: string): value is FunnelEventName {
  return (FUNNEL_EVENT_NAMES as readonly string[]).includes(value);
}