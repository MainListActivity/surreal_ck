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

export type ComputeCapabilityMatrixInput = {
  isAuthenticated: boolean;
  isOffline: boolean;
};

export type WriteCapabilityTarget =
  | { kind: "research-session" }
  | { kind: "dynamic-table"; tableName: string }
  | { kind: "shared-resource" }
  | { kind: "shared-embedding" }
  | { kind: "shared-structure" };

const SHARED_WRITE_CAPABILITIES: readonly CapabilityKey[] = [
  "write_entity_data",
  "write_relation_data",
  "publish_shared_resource",
  "advance_shared_embedding",
  "write_shared_structure_ddl",
];

export function computeCapabilityMatrix(input: ComputeCapabilityMatrixInput): CapabilityMatrix {
  if (!input.isAuthenticated) {
    return createBlockedCapabilityMatrix("not-authenticated");
  }

  const matrix = Object.fromEntries(
    ALL_CAPABILITY_KEYS.map((key) => [key, { allowed: true } satisfies CapabilityState]),
  ) as CapabilityMatrix;

  if (input.isOffline) {
    for (const key of SHARED_WRITE_CAPABILITIES) {
      matrix[key] = { allowed: false, blockedBy: "offline" };
    }
  }

  return matrix;
}

export function createBlockedCapabilityMatrix(reason: CapabilityBlockedReason): CapabilityMatrix {
  return Object.fromEntries(
    ALL_CAPABILITY_KEYS.map((key) => [key, { allowed: false, blockedBy: reason } satisfies CapabilityState]),
  ) as CapabilityMatrix;
}

export function isCapabilityAllowed(matrix: CapabilityMatrix, key: CapabilityKey): boolean {
  return matrix[key].allowed;
}

export function capabilityForWriteTarget(target: WriteCapabilityTarget): CapabilityKey {
  switch (target.kind) {
    case "research-session":
      return "write_research_session";
    case "dynamic-table":
      return capabilityForDynamicTable(target.tableName);
    case "shared-resource":
      return "publish_shared_resource";
    case "shared-embedding":
      return "advance_shared_embedding";
    case "shared-structure":
      return "write_shared_structure_ddl";
  }
}

export function capabilityForDynamicTable(tableName: string): CapabilityKey {
  if (tableName.startsWith("ent_")) return "write_entity_data";
  if (tableName.startsWith("rel_")) return "write_relation_data";
  return "write_shared_structure_ddl";
}
