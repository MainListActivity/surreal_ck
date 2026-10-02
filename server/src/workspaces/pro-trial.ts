import { HttpError } from "../http-error";
import type { WorkspaceCreator } from "./create-workspace";

export type TrialOffer = {
  revision: string;
  productRevision: string;
  resourceRevision: string;
  resourcePlanKey: string;
  collections: { key: string; label: string }[];
  allowance: number;
  researchRate: number;
  rateRevision: number;
  capacity: { label: string; limit: number }[];
  reminderHours: number[];
  fixture: boolean;
};
export type TrialClaim = {
  id: string;
  accountId: string;
  subject: string;
  slug: string;
  name: string;
  startedAt: string;
  endsAt: string;
  offer: TrialOffer;
  state: "provisioning" | "active";
};
export interface TrialStore {

  accounts(subject: string): Promise<{ key: string; name: string }[]>;
  offer(subject: string, accountKey: string, requestKey?: string): Promise<TrialOffer>;
  claim(input: { subject: string; accountKey: string; name: string; slug: string; key: string; offerRevision: string }): Promise<{ claim: TrialClaim; lease: string | null }>;
  status(subject: string, slug: string): Promise<{ state: string; remainingSeconds: number; startedAt: string; endsAt: string; allowance: number; collections: { key: string; label: string }[]; fixture: boolean; reminder: boolean; retention: string } | null>;
  finish(claim: TrialClaim, lease: string, success: boolean): Promise<void>;
}
export type TrialStart = { subject: string; subjectToken: string; email: string; accountKey: string; name: string; slug: string; key: string; offerRevision: string };

/** 账户资格与跨进程并发归 store；模板/native 配额归现有 creator；
 * 产品/内容/额度交付在 creator 的 activate 之前完成。 */
export class ProTrialService {
  constructor(private readonly store: TrialStore, private readonly creator: WorkspaceCreator, private readonly now: () => Date = () => new Date()) {}

  status(subject: string, slug: string) { return this.store.status(subject, slug); }

  accounts(subject: string) { return this.store.accounts(subject); }

  async preview(subject: string, accountKey: string, requestKey?: string) {
    const offer = await this.store.offer(subject, accountKey, requestKey);
    const start = this.now();
    return { ...offer, startedAt: start.toISOString(), endsAt: new Date(start.getTime() + 7 * 86400000).toISOString(), durationDays: 7,
      timezone: "UTC", excludes: ["专业模块", "Max API/MCP 与批量复制", "自动充值和自动转付费"],
      expiry: "到期直接进入保留模式，自己的成果保留；全文与追问按当前权限重新核验。" };
  }

  async start(input: TrialStart) {
    const { claim, lease } = await this.store.claim(input);
    if (!lease) {
      if (claim.state === "active") return { slug: claim.slug, startedAt: claim.startedAt, endsAt: claim.endsAt, state: "active" as const };
      throw new HttpError(409, "trial-provisioning", "试用正在交付，请使用原请求重试");
    }
    let success = false;
    try {
      const result = await this.creator.createWorkspace({
        subject: claim.subject, subjectToken: input.subjectToken, email: input.email, name: claim.name, slug: claim.slug,
        resourceSource: { planKey: claim.offer.resourcePlanKey, sourceKind: "trial", trial: {
          claimId: claim.id, billingAccountId: claim.accountId, productRevisionId: claim.offer.productRevision,
          resourceRevisionId: claim.offer.resourceRevision, researchRate: claim.offer.researchRate, rateRevision: claim.offer.rateRevision, fixture: claim.offer.fixture, leaseId: lease, startsAt: claim.startedAt, endsAt: claim.endsAt,
        } },
      });
      success = result.kind === "created" || result.kind === "scope-update-failed";
      if (!success) throw new HttpError(503, "trial-delivery-pending", "试用尚未完成交付，请使用原请求重试");
      return { slug: claim.slug, startedAt: claim.startedAt, endsAt: claim.endsAt, state: "active" as const };
    } finally {
      await this.store.finish(claim, lease, success);
    }
  }
}
