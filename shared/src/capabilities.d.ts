export type CapabilityKey = "write_research_session" | "write_entity_data" | "write_relation_data" | "publish_shared_resource" | "advance_shared_embedding" | "write_shared_structure_ddl";
export type CapabilityBlockedReason = "not-authenticated" | "offline";
export type CapabilityState = {
    allowed: true;
} | {
    allowed: false;
    blockedBy: CapabilityBlockedReason;
};
export type CapabilityMatrix = Record<CapabilityKey, CapabilityState>;
export declare const ALL_CAPABILITY_KEYS: readonly CapabilityKey[];
export type ComputeCapabilityMatrixInput = {
    isAuthenticated: boolean;
    isOffline: boolean;
};
export type WriteCapabilityTarget = {
    kind: "research-session";
} | {
    kind: "dynamic-table";
    tableName: string;
} | {
    kind: "shared-resource";
} | {
    kind: "shared-embedding";
} | {
    kind: "shared-structure";
};
export declare function computeCapabilityMatrix(input: ComputeCapabilityMatrixInput): CapabilityMatrix;
export declare function createBlockedCapabilityMatrix(reason: CapabilityBlockedReason): CapabilityMatrix;
export declare function isCapabilityAllowed(matrix: CapabilityMatrix, key: CapabilityKey): boolean;
export declare function capabilityForWriteTarget(target: WriteCapabilityTarget): CapabilityKey;
export declare function capabilityForDynamicTable(tableName: string): CapabilityKey;
