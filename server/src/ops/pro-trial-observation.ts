import { jsonify } from "surrealdb";
import { z } from "zod";
import { getRootDatabaseSession } from "../db/root-connection";

type Database = { query(sql: string, vars?: Record<string, unknown>): Promise<unknown> };
const nullableString = z.string().nullable();
const revision = z.object({
  id: z.string(), product_revision: z.string(), fixture: z.boolean(), duration_days: z.number(),
  research_rate: z.number(), rate_revision: z.number(), reminder_hours: z.array(z.number()),
  approved_by: nullableString, created_at: nullableString,
});
const configuration = z.object({
  id: z.string(), enabled: z.boolean(), revision: z.string(), updated_by: nullableString, updated_at: nullableString,
});
const configurationSnapshot = z.object({ serverTime: z.string(), configuration: configuration.nullable(), revision: revision.nullable() });
const claim = z.object({
  id: z.string(), state: z.string(), slug: z.string(), started_at: z.string(), ends_at: z.string(),
  lease_until: nullableString, leaseHeld: z.boolean(), unexpired: z.boolean(),
  revision: nullableString, productRevision: nullableString, resourceRevision: nullableString,
});
const accountSnapshot = z.object({
  serverTime: z.string(), account: z.object({ id: z.string(), account_key: z.string(), status: z.string() }).nullable(),
  membership: z.object({ role: z.string(), status: z.string() }).nullable(),
  eligibility: z.object({ enabled: z.boolean(), approved_by: nullableString, updated_at: nullableString }).nullable(),
  trials: z.array(z.object({ id: z.string(), trial_start: z.string(), trial_end: z.string() })),
  slots: z.array(z.object({ id: z.string(), current_claim: z.string() })), claims: z.array(claim),
});

// Explicit projections: never return names, request keys, lease tokens, reasons or account lists.
export const READ_TRIAL_CONFIGURATION_SQL = `
LET $now = time::now();
LET $config = (SELECT id, enabled, revision, updated_by ?? NULL AS updated_by, updated_at ?? NULL AS updated_at
  FROM ONLY pro_trial_configuration:current);
LET $revision = IF $config != NONE THEN (
  SELECT id, product_revision, fixture, duration_days, research_rate, rate_revision, reminder_hours,
    approved_by ?? NULL AS approved_by, created_at ?? NULL AS created_at FROM ONLY $config.revision
) ELSE NONE END;
RETURN { serverTime: $now, configuration: $config ?? NULL, revision: $revision ?? NULL };
`;

export const READ_TRIAL_ACCOUNT_SQL = `
LET $now = time::now();
LET $account = (SELECT id, account_key, status FROM billing_account WHERE account_key = $accountKey LIMIT 1)[0];
LET $member = IF $account != NONE THEN (
  (SELECT role, status FROM billing_account_member WHERE billing_account = $account.id AND subject = $subject LIMIT 1)[0]
) ELSE NONE END;
LET $eligibility = IF $account != NONE THEN (
  (SELECT enabled, approved_by ?? NULL AS approved_by, updated_at ?? NULL AS updated_at
    FROM pro_trial_eligibility WHERE billing_account = $account.id LIMIT 1)[0]
) ELSE NONE END;
LET $trials = (
  SELECT id, trial_start, trial_end FROM quota_subscription WHERE $account != NONE AND billing_account = $account.id
    AND status = "trialing" AND trial_start <= $now AND trial_end > $now
);
LET $slots = (
  SELECT id, current_claim FROM pro_trial_slot WHERE $account != NONE AND billing_account = $account.id
);
LET $claims = (
  SELECT id, state, slug, started_at, ends_at, lease_until ?? NULL AS lease_until,
    (lease != NONE AND lease_until > $now) AS leaseHeld, (ends_at > $now) AS unexpired,
    offer.revision ?? NULL AS revision, offer.productRevision ?? NULL AS productRevision,
    offer.resourceRevision ?? NULL AS resourceRevision
  FROM pro_trial_claim WHERE $account != NONE AND billing_account = $account.id
    AND (ends_at > $now OR id IN $slots.current_claim)
);
RETURN { serverTime: $now, account: $account ?? NULL, membership: $member ?? NULL,
  eligibility: $eligibility ?? NULL, trials: $trials, slots: $slots, claims: $claims };
`;

function resultValue(result: unknown): unknown {
  if (!Array.isArray(result)) throw new Error("trial observation returned no result");
  return jsonify(result.at(-1));
}

export class ProTrialObservation {
  constructor(private readonly getDb: () => Promise<Database> = () => getRootDatabaseSession("_system")) {}

  async configuration() {
    const snapshot = configurationSnapshot.parse(resultValue(await (await this.getDb()).query(READ_TRIAL_CONFIGURATION_SQL)));
    return { ...snapshot, configurationState: snapshot.configuration ? "present" : "missing",
      revisionState: snapshot.revision ? "present" : snapshot.configuration ? "missing" : "not_referenced" };
  }

  async account(accountKey: string, subject: string) {
    const snapshot = accountSnapshot.parse(resultValue(await (await this.getDb()).query(READ_TRIAL_ACCOUNT_SQL, { accountKey, subject })));
    const slots = snapshot.slots.map(slot => {
      const current = snapshot.claims.find(c => c.id === slot.current_claim);
      return { ...slot, claimState: current ? "present" : "missing", blocksNewClaim: current?.unexpired ?? null };
    });
    return { ...snapshot, slots, subject, accountState: snapshot.account ? "present" : "missing",
      active: snapshot.account ? snapshot.account.status === "active" : null,
      administrator: snapshot.account ? snapshot.membership?.status === "active" && ["owner", "admin"].includes(snapshot.membership.role) : null,
      eligibilityState: snapshot.eligibility ? snapshot.eligibility.enabled ? "enabled" : "disabled" : "missing",
      eligible: snapshot.eligibility?.enabled ?? null,
      boundaries: { trial: "trial_start <= serverTime < trial_end", slot: "claim.ends_at > serverTime", lease: "lease_until > serverTime" },
    };
  }
}
