import { describe, expect, test } from "bun:test";
import { canWriteEntityData, canWriteSharedStructure, isWorkspaceAdmin } from "./permissions";

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
