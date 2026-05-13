import { describe, expect, test } from "bun:test";
import {
  ALL_CAPABILITY_KEYS,
  computeCapabilityMatrix,
  isCapabilityAllowed,
  type CapabilityMatrix,
} from "./capabilities";

describe("能力矩阵", () => {
  test("已认证且在线时所有 capability 都 allowed", () => {
    const matrix = computeCapabilityMatrix({ isAuthenticated: true, isOffline: false });
    for (const key of ALL_CAPABILITY_KEYS) {
      expect(matrix[key]).toEqual({ allowed: true });
    }
  });

  test("未认证时所有 capability 都被 not-authenticated 阻塞", () => {
    const matrix = computeCapabilityMatrix({ isAuthenticated: false, isOffline: false });
    for (const key of ALL_CAPABILITY_KEYS) {
      const state = matrix[key];
      expect(state.allowed).toBe(false);
      if (!state.allowed) expect(state.blockedBy).toBe("not-authenticated");
    }
  });

  test("离线时 research_session 本地写仍 allowed", () => {
    const matrix = computeCapabilityMatrix({ isAuthenticated: true, isOffline: true });
    expect(matrix.write_research_session.allowed).toBe(true);
  });

  test("离线时所有共享写 capability 都被 offline 阻塞", () => {
    const matrix = computeCapabilityMatrix({ isAuthenticated: true, isOffline: true });
    const sharedWrites: Array<keyof CapabilityMatrix> = [
      "write_entity_data",
      "write_relation_data",
      "publish_shared_resource",
      "advance_shared_embedding",
      "write_shared_structure_ddl",
    ];
    for (const key of sharedWrites) {
      const state = matrix[key];
      expect(state.allowed).toBe(false);
      if (!state.allowed) expect(state.blockedBy).toBe("offline");
    }
  });

  test("isCapabilityAllowed 是 matrix.allowed 的便捷查询", () => {
    const matrix = computeCapabilityMatrix({ isAuthenticated: true, isOffline: true });
    expect(isCapabilityAllowed(matrix, "write_research_session")).toBe(true);
    expect(isCapabilityAllowed(matrix, "write_entity_data")).toBe(false);
  });
});
