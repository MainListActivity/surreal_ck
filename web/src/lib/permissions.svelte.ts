import { getCurrentWorkspace } from "./workspace-store.svelte";
import {
  canWriteEntityData as canWriteEntityDataFor,
  canWriteSharedStructure as canWriteSharedStructureFor,
  editorAccessLevel as editorAccessLevelFor,
  isWorkspaceAdmin as isWorkspaceAdminFor,
  type EditorAccessLevel,
} from "./permissions";

/** 当前签入工作区的 role（admin / participant / employee），来自 workspace-store 的 runes 状态。 */
function currentRole(): string | null {
  return getCurrentWorkspace()?.role ?? null;
}

export function isWorkspaceAdmin(): boolean {
  return isWorkspaceAdminFor(currentRole());
}

export function canWriteEntityData(): boolean {
  return canWriteEntityDataFor(currentRole());
}

export function canWriteSharedStructure(): boolean {
  return canWriteSharedStructureFor(currentRole());
}

export function editorAccessLevel(): EditorAccessLevel {
  return editorAccessLevelFor(currentRole());
}
