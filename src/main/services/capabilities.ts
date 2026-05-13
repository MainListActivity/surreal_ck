/**
 * 应用能力矩阵 — 替代单一 readOnly 布尔值。
 * 每条 capability 描述一类写操作，并能解释为何被禁止。
 * 参见 ADR sync §11。
 */

export type CapabilityKey =
  | "write_research_session"
  | "write_entity_data"
  | "write_relation_data"
  | "publish_shared_resource"
  | "advance_shared_embedding"
  | "write_shared_structure_ddl";

export type CapabilityBlockedReason = "not-authenticated" | "offline";

export type CapabilityState =
  | { allowed: true }
  | { allowed: false; blockedBy: CapabilityBlockedReason };

export type CapabilityMatrix = Record<CapabilityKey, CapabilityState>;

export const ALL_CAPABILITY_KEYS: readonly CapabilityKey[] = [
  "write_research_session",
  "write_entity_data",
  "write_relation_data",
  "publish_shared_resource",
  "advance_shared_embedding",
  "write_shared_structure_ddl",
] as const;

const SHARED_WRITE_CAPABILITIES: readonly CapabilityKey[] = [
  "write_entity_data",
  "write_relation_data",
  "publish_shared_resource",
  "advance_shared_embedding",
  "write_shared_structure_ddl",
];

export type ComputeCapabilityMatrixInput = {
  isAuthenticated: boolean;
  isOffline: boolean;
};

export function computeCapabilityMatrix(input: ComputeCapabilityMatrixInput): CapabilityMatrix {
  const matrix: Partial<CapabilityMatrix> = {};
  if (!input.isAuthenticated) {
    for (const key of ALL_CAPABILITY_KEYS) {
      matrix[key] = { allowed: false, blockedBy: "not-authenticated" };
    }
    return matrix as CapabilityMatrix;
  }

  for (const key of ALL_CAPABILITY_KEYS) {
    matrix[key] = { allowed: true };
  }

  if (input.isOffline) {
    for (const key of SHARED_WRITE_CAPABILITIES) {
      matrix[key] = { allowed: false, blockedBy: "offline" };
    }
  }

  return matrix as CapabilityMatrix;
}

export function isCapabilityAllowed(matrix: CapabilityMatrix, key: CapabilityKey): boolean {
  return matrix[key].allowed;
}
