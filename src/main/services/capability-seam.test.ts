import { describe, expect, test } from "bun:test";
import {
  assertCapabilityAllowed,
  capabilityForWriteTarget,
  computeCapabilityMatrix,
  type CapabilityKey,
  type WriteCapabilityTarget,
} from "./capabilities";
import { ServiceError } from "./errors";

describe("离线写能力 seam", () => {
  test("写目标映射到具体 capability", () => {
    const cases: Array<[WriteCapabilityTarget, CapabilityKey]> = [
      [{ kind: "dynamic-table", tableName: "ent_demo_cases" }, "write_entity_data"],
      [{ kind: "dynamic-table", tableName: "rel_demo_owns" }, "write_relation_data"],
      [{ kind: "shared-resource" }, "publish_shared_resource"],
      [{ kind: "shared-embedding" }, "advance_shared_embedding"],
      [{ kind: "research-session" }, "write_research_session"],
    ];

    for (const [target, capability] of cases) {
      expect(capabilityForWriteTarget(target)).toBe(capability);
    }
  });

  test("离线时拒绝数据表、关系和共享资源库写入，但允许本地私有检索过程", () => {
    const matrix = computeCapabilityMatrix({ isAuthenticated: true, isOffline: true });
    const blockedTargets: WriteCapabilityTarget[] = [
      { kind: "dynamic-table", tableName: "ent_demo_cases" },
      { kind: "dynamic-table", tableName: "rel_demo_owns" },
      { kind: "shared-resource" },
      { kind: "shared-embedding" },
    ];

    for (const target of blockedTargets) {
      try {
        assertCapabilityAllowed(matrix, capabilityForWriteTarget(target));
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).code).toBe("OFFLINE_READ_ONLY");
      }
    }

    expect(() => assertCapabilityAllowed(
      matrix,
      capabilityForWriteTarget({ kind: "research-session" }),
    )).not.toThrow();
  });

  test("未登录时任意写目标都被 NOT_AUTHENTICATED 阻塞", () => {
    const matrix = computeCapabilityMatrix({ isAuthenticated: false, isOffline: false });

    try {
      assertCapabilityAllowed(matrix, capabilityForWriteTarget({ kind: "shared-resource" }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("NOT_AUTHENTICATED");
    }
  });
});
