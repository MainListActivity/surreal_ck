export const QUOTA_ALERT_THRESHOLDS = [80, 90, 100] as const;
export type QuotaAlertThreshold = (typeof QUOTA_ALERT_THRESHOLDS)[number];
export type QuotaAlertKind = "threshold" | "over_limit";

export type QuotaAlertObservation = Readonly<{
  resourceKey: string;
  tableIdentity?: string;
  used: bigint;
  limit: bigint;
}>;

export type QuotaAlertSnapshot = Readonly<{
  projection: string;
  kind: QuotaAlertKind;
  resourceKey: string;
  tableIdentity?: string;
  threshold: QuotaAlertThreshold;
  episode: number;
  state: "notified" | "cleared";
  used: bigint;
  limit: bigint;
  ratioPercent: number;
}>;

export type QuotaAlertTransition = Readonly<{
  action: "notify" | "update" | "clear";
  snapshot: QuotaAlertSnapshot;
  dedupeKey: string;
}>;

function ratioPercent(used: bigint, limit: bigint): number {
  if (limit === 0n) return used === 0n ? 100 : 101;
  const basisPoints = (used * 10_000n) / limit;
  return Number(basisPoints) / 100;
}

function identity(input: Readonly<{
  projection: string;
  kind: QuotaAlertKind;
  resourceKey: string;
  tableIdentity?: string;
  threshold: QuotaAlertThreshold;
}>): string {
  return [
    input.projection,
    input.kind,
    input.resourceKey,
    input.tableIdentity ?? "",
    input.threshold,
  ].map((part) => encodeURIComponent(String(part))).join(":");
}

function nextTransition(input: Readonly<{
  projection: string;
  kind: QuotaAlertKind;
  observation: QuotaAlertObservation;
  threshold: QuotaAlertThreshold;
  previous?: QuotaAlertSnapshot;
}>): QuotaAlertTransition | null {
  const ratio = ratioPercent(input.observation.used, input.observation.limit);
  const reached = input.kind === "over_limit"
    ? input.observation.used > input.observation.limit
    : ratio >= input.threshold;
  const rearmed = ratio <= input.threshold - 5;
  const base = identity({
    projection: input.projection,
    kind: input.kind,
    resourceKey: input.observation.resourceKey,
    tableIdentity: input.observation.tableIdentity,
    threshold: input.threshold,
  });

  if (!input.previous) {
    if (!reached) return null;
    const snapshot: QuotaAlertSnapshot = {
      projection: input.projection,
      kind: input.kind,
      resourceKey: input.observation.resourceKey,
      ...(input.observation.tableIdentity
        ? { tableIdentity: input.observation.tableIdentity }
        : {}),
      threshold: input.threshold,
      episode: 1,
      state: "notified",
      used: input.observation.used,
      limit: input.observation.limit,
      ratioPercent: ratio,
    };
    return {
      action: "notify",
      snapshot,
      dedupeKey: `${base}:1`,
    };
  }

  if (input.previous.state === "notified" && rearmed) {
    return {
      action: "clear",
      snapshot: {
        ...input.previous,
        state: "cleared",
        used: input.observation.used,
        limit: input.observation.limit,
        ratioPercent: ratio,
      },
      dedupeKey: `${base}:${input.previous.episode}`,
    };
  }

  if (input.previous.state === "cleared" && reached) {
    const episode = input.previous.episode + 1;
    return {
      action: "notify",
      snapshot: {
        ...input.previous,
        state: "notified",
        episode,
        used: input.observation.used,
        limit: input.observation.limit,
        ratioPercent: ratio,
      },
      dedupeKey: `${base}:${episode}`,
    };
  }

  if (
    input.previous.used === input.observation.used
    && input.previous.limit === input.observation.limit
  ) {
    return null;
  }

  return {
    action: "update",
    snapshot: {
      ...input.previous,
      used: input.observation.used,
      limit: input.observation.limit,
      ratioPercent: ratio,
    },
    dedupeKey: `${base}:${input.previous.episode}`,
  };
}

/**
 * 只对 finite + trusted usage 调用。每个 projection 独立评估；同一 episode
 * 只有 notify transition 会写 immutable outbox。
 */
export function evaluateQuotaAlerts(input: Readonly<{
  projection: string;
  observations: readonly QuotaAlertObservation[];
  previous: readonly QuotaAlertSnapshot[];
}>): readonly QuotaAlertTransition[] {
  const previousByIdentity = new Map(
    input.previous.map((snapshot) => [
      identity({
        projection: snapshot.projection,
        kind: snapshot.kind,
        resourceKey: snapshot.resourceKey,
        tableIdentity: snapshot.tableIdentity,
        threshold: snapshot.threshold,
      }),
      snapshot,
    ]),
  );
  const transitions: QuotaAlertTransition[] = [];

  for (const observation of input.observations) {
    for (const threshold of QUOTA_ALERT_THRESHOLDS) {
      const key = identity({
        projection: input.projection,
        kind: "threshold",
        resourceKey: observation.resourceKey,
        tableIdentity: observation.tableIdentity,
        threshold,
      });
      const transition = nextTransition({
        projection: input.projection,
        kind: "threshold",
        observation,
        threshold,
        previous: previousByIdentity.get(key),
      });
      if (transition) transitions.push(transition);
    }

    const overKey = identity({
      projection: input.projection,
      kind: "over_limit",
      resourceKey: observation.resourceKey,
      tableIdentity: observation.tableIdentity,
      threshold: 100,
    });
    const overTransition = nextTransition({
      projection: input.projection,
      kind: "over_limit",
      observation,
      threshold: 100,
      previous: previousByIdentity.get(overKey),
    });
    if (overTransition) transitions.push(overTransition);
  }

  return transitions;
}
