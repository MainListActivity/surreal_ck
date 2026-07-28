import { describe, expect, test } from "bun:test";
import {
  evaluateQuotaAlerts,
  type QuotaAlertSnapshot,
} from "./quota-alerts";

describe("evaluateQuotaAlerts", () => {
  test("notifies each reached threshold and the over-limit episode once", () => {
    const first = evaluateQuotaAlerts({
      projection: "quota_policy_projection:p1",
      previous: [],
      observations: [{
        resourceKey: "record/ent",
        tableIdentity: "ent_case",
        used: 101n,
        limit: 100n,
      }],
    });
    expect(first.map((item) => [item.snapshot.kind, item.snapshot.threshold])).toEqual([
      ["threshold", 80],
      ["threshold", 90],
      ["threshold", 100],
      ["over_limit", 100],
    ]);
    expect(first.every((item) => item.action === "notify")).toBe(true);

    const previous = first.map((item) => item.snapshot);
    const same = evaluateQuotaAlerts({
      projection: "quota_policy_projection:p1",
      previous,
      observations: [{
        resourceKey: "record/ent",
        tableIdentity: "ent_case",
        used: 101n,
        limit: 100n,
      }],
    });
    expect(same).toEqual([]);
  });

  test("does not treat at-limit as over-limit", () => {
    const transitions = evaluateQuotaAlerts({
      projection: "quota_policy_projection:p1",
      previous: [],
      observations: [{ resourceKey: "table/all", used: 0n, limit: 0n }],
    });
    expect(transitions.map((item) => [item.snapshot.kind, item.snapshot.threshold])).toEqual([
      ["threshold", 80],
      ["threshold", 90],
      ["threshold", 100],
    ]);
  });

  test("requires a five-point drop before rearming an episode", () => {
    const previous: QuotaAlertSnapshot = {
      projection: "quota_policy_projection:p1",
      kind: "threshold",
      resourceKey: "record/ent",
      threshold: 90,
      episode: 1,
      state: "notified",
      used: 91n,
      limit: 100n,
      ratioPercent: 91,
    };
    const notRearmed = evaluateQuotaAlerts({
      projection: previous.projection,
      previous: [previous],
      observations: [{ resourceKey: previous.resourceKey, used: 86n, limit: 100n }],
    });
    expect(
      notRearmed.find((item) => item.snapshot.threshold === 90)?.action,
    ).toBe("update");

    const cleared = evaluateQuotaAlerts({
      projection: previous.projection,
      previous: [previous],
      observations: [{ resourceKey: previous.resourceKey, used: 85n, limit: 100n }],
    });
    const clearedNinety = cleared.find((item) => item.snapshot.threshold === 90);
    expect(clearedNinety?.action).toBe("clear");

    const secondEpisode = evaluateQuotaAlerts({
      projection: previous.projection,
      previous: [clearedNinety!.snapshot],
      observations: [{ resourceKey: previous.resourceKey, used: 90n, limit: 100n }],
    });
    expect(
      secondEpisode.find((item) => item.snapshot.threshold === 90),
    ).toMatchObject({
      action: "notify",
      snapshot: { episode: 2, state: "notified" },
    });
  });

  test("projection changes create a new independently deduped fact", () => {
    const old: QuotaAlertSnapshot = {
      projection: "quota_policy_projection:p1",
      kind: "threshold",
      resourceKey: "record/ent",
      threshold: 80,
      episode: 1,
      state: "notified",
      used: 80n,
      limit: 100n,
      ratioPercent: 80,
    };
    const next = evaluateQuotaAlerts({
      projection: "quota_policy_projection:p2",
      previous: [old],
      observations: [{ resourceKey: "record/ent", used: 80n, limit: 100n }],
    });
    expect(next[0]).toMatchObject({
      action: "notify",
      snapshot: { projection: "quota_policy_projection:p2", episode: 1 },
    });
    expect(next[0]?.dedupeKey).not.toBe(
      "quota_policy_projection%3Ap1:threshold:record%2Fent::80:1",
    );
  });
});
