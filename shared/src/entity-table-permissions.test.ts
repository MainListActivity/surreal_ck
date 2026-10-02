import { describe, expect, test } from "bun:test";
import {
  buildEntityTableMemberPermissionsAlter,
  ENTITY_TABLE_MEMBER_PERMISSIONS,
} from "./entity-table-permissions";

describe("entity table member permissions", () => {
  test("clause grants member DML through the active-user contract, never FULL", () => {
    expect(ENTITY_TABLE_MEMBER_PERMISSIONS).toBe(
      "PERMISSIONS FOR select, create, update, delete WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE",
    );
    expect(ENTITY_TABLE_MEMBER_PERMISSIONS).not.toContain("FULL");
  });

  test("alter statement targets the table and carries the same clause", () => {
    expect(buildEntityTableMemberPermissionsAlter("ent_cv06_claims")).toBe(
      `ALTER TABLE ent_cv06_claims ${ENTITY_TABLE_MEMBER_PERMISSIONS};`,
    );
  });

  test("rejects unsafe table identifiers instead of interpolating them", () => {
    expect(() => buildEntityTableMemberPermissionsAlter("ent_x; DROP TABLE user")).toThrow();
    expect(() => buildEntityTableMemberPermissionsAlter("ent x")).toThrow();
    expect(() => buildEntityTableMemberPermissionsAlter("")).toThrow();
  });
});
