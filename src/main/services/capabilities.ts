export {
  ALL_CAPABILITY_KEYS,
  capabilityForDynamicTable,
  capabilityForWriteTarget,
  computeCapabilityMatrix,
  createBlockedCapabilityMatrix,
  isCapabilityAllowed,
} from "../../shared/capabilities";
export type {
  CapabilityBlockedReason,
  CapabilityKey,
  CapabilityMatrix,
  CapabilityState,
  ComputeCapabilityMatrixInput,
  WriteCapabilityTarget,
} from "../../shared/capabilities";

import type { AppErrorCode } from "../../shared/rpc.types";
import type { CapabilityKey, CapabilityMatrix, CapabilityState } from "../../shared/capabilities";
import { ServiceError } from "./errors";

export function assertCapabilityAllowed(matrix: CapabilityMatrix, capability: CapabilityKey): void {
  const state = matrix[capability];
  if (state.allowed) return;
  throw new ServiceError(
    errorCodeForBlockedCapability(state),
    messageForBlockedCapability(capability, state),
  );
}

function errorCodeForBlockedCapability(state: Extract<CapabilityState, { allowed: false }>): AppErrorCode {
  return state.blockedBy === "not-authenticated" ? "NOT_AUTHENTICATED" : "OFFLINE_READ_ONLY";
}

function messageForBlockedCapability(
  capability: CapabilityKey,
  state: Extract<CapabilityState, { allowed: false }>,
): string {
  if (state.blockedBy === "not-authenticated") return "请先登录";
  return `当前离线，无法执行 ${capability} 写操作`;
}
