import { describe, expect, test } from "bun:test";
import {
  canWriteEntityData,
  canWriteSharedStructure,
  editorAccessLevel,
  isWorkspaceAdmin,
} from "./permissions";

describe("isWorkspaceAdmin", () => {
  test("仅 admin 为真", () => {
    expect(isWorkspaceAdmin("admin")).toBe(true);
    expect(isWorkspaceAdmin("participant")).toBe(false);
    expect(isWorkspaceAdmin("employee")).toBe(false);
    expect(isWorkspaceAdmin(null)).toBe(false);
    expect(isWorkspaceAdmin(undefined)).toBe(false);
  });
});

describe("canWriteEntityData", () => {
  test("admin / participant 可写，employee / 未签入不可", () => {
    expect(canWriteEntityData("admin")).toBe(true);
    expect(canWriteEntityData("participant")).toBe(true);
    expect(canWriteEntityData("employee")).toBe(false);
    expect(canWriteEntityData(null)).toBe(false);
  });
});

describe("canWriteSharedStructure", () => {
  test("仅 admin 可改结构", () => {
    expect(canWriteSharedStructure("admin")).toBe(true);
    expect(canWriteSharedStructure("participant")).toBe(false);
    expect(canWriteSharedStructure(null)).toBe(false);
  });
});

describe("editorAccessLevel — 顶栏徽标权限源", () => {
  test("admin 为 editable（结构+数据可写）", () => {
    expect(editorAccessLevel("admin")).toBe("editable");
  });

  test("participant 为 structure-readonly（数据可写、结构只读），不得归为只读", () => {
    expect(editorAccessLevel("participant")).toBe("structure-readonly");
  });

  test("employee 与未签入为 readonly", () => {
    expect(editorAccessLevel("employee")).toBe("readonly");
    expect(editorAccessLevel(null)).toBe("readonly");
    expect(editorAccessLevel(undefined)).toBe("readonly");
  });
});
