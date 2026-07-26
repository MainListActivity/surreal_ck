import { env } from "../env";
import { getRootDatabaseSession } from "./root-connection";
import {
  commercialProductRules,
  SEEDED_PLAN_LIMITS,
  type SeededPlanKey,
} from "./quota-plan-rules";

export type QuotaPlanSeedClient = {
  query(sql: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type SeedQuotaPlansOptions = {
  getDbSession?: (database: string, namespace: string) => Promise<QuotaPlanSeedClient>;
  namespace?: string;
  createdBySubject?: string;
};

export type SeedQuotaPlansResult = {
  planKeys: SeededPlanKey[];
};

const SYSTEM_DATABASE = "_system";

const PLAN_SPECS: ReadonlyArray<{
  planKey: SeededPlanKey;
  displayName: string;
  visibility: "public" | "internal";
  templateKind: "commercial" | "trial" | "retention";
}> = [
  { planKey: "trial", displayName: "Trial", visibility: "public", templateKind: "trial" },
  { planKey: "plus", displayName: "Plus", visibility: "public", templateKind: "commercial" },
  { planKey: "pro", displayName: "Pro", visibility: "public", templateKind: "commercial" },
  { planKey: "max", displayName: "Max", visibility: "public", templateKind: "commercial" },
  {
    planKey: "retention",
    displayName: "Retention",
    visibility: "internal",
    templateKind: "retention",
  },
];

/**
 * Idempotently seed catalog plans and revision 1 for provisioning. Rules match
 * compiler coverage; values mirror legacy 020 tiers until product publishes
 * new immutable revisions.
 */
export async function seedQuotaPlans(
  options: SeedQuotaPlansOptions = {},
): Promise<SeedQuotaPlansResult> {
  const namespace = options.namespace ?? env.SURREAL_NS;
  const getDbSession = options.getDbSession
    ?? ((database: string, ns: string) => getRootDatabaseSession(database, ns));
  const createdBySubject = options.createdBySubject ?? "system:seed";
  const systemDb = await getDbSession(SYSTEM_DATABASE, namespace);

  for (const spec of PLAN_SPECS) {
    const planId = `quota_plan:${spec.planKey}`;
    const revisionId = `quota_plan_revision:${spec.planKey}_v1`;
    const rules = commercialProductRules(SEEDED_PLAN_LIMITS[spec.planKey]);

    await systemDb.query(
      `
        INSERT INTO quota_plan {
          id: type::record("quota_plan", $planKey),
          plan_key: $planKey,
          display_name: $displayName,
          visibility: $visibility,
          status: "active"
        }
        ON DUPLICATE KEY UPDATE
          display_name = $displayName,
          visibility = $visibility,
          status = "active";
      `,
      {
        planKey: spec.planKey,
        displayName: spec.displayName,
        visibility: spec.visibility,
      },
    );

    // Immutable revision: only insert when missing.
    await systemDb.query(
      `
        LET $existing = (
          SELECT VALUE id FROM type::record("quota_plan_revision", $revisionKey) LIMIT 1
        );
        IF array::len($existing) = 0 {
          CREATE type::record("quota_plan_revision", $revisionKey) CONTENT {
            plan: type::record("quota_plan", $planKey),
            revision: 1,
            template_kind: $templateKind,
            rules: $rules,
            created_by_subject: $createdBySubject,
            published_at: time::now(),
            correlation_id: $correlationId
          };
        };
        UPDATE type::record("quota_plan", $planKey) SET
          active_revision = type::record("quota_plan_revision", $revisionKey);
      `,
      {
        planKey: spec.planKey,
        revisionKey: `${spec.planKey}_v1`,
        templateKind: spec.templateKind,
        rules,
        createdBySubject,
        correlationId: `seed-plan-${spec.planKey}-v1`,
        planId,
        revisionId,
      },
    );
  }

  return { planKeys: PLAN_SPECS.map((spec) => spec.planKey) };
}
