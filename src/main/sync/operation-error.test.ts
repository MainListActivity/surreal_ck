import { describe, expect, test } from "bun:test";
import { syncErrorLogDetails, syncErrorMessage } from "./operation-error";

describe("sync operation errors", () => {
  test("syncErrorMessage keeps the user-facing message concise", () => {
    const err = Object.assign(new Error("There was a problem with authentication"), {
      kind: "NotAllowed",
      code: -32002,
      details: {
        details: {
          kind: "InvalidAuth",
          message: "AUTHENTICATE returned invalid record",
        },
        kind: "Auth",
      },
    });

    expect(syncErrorMessage(err)).toBe("There was a problem with authentication");
  });

  test("syncErrorLogDetails expands nested SDK error details", () => {
    const err = Object.assign(new Error("There was a problem with authentication"), {
      kind: "NotAllowed",
      code: -32002,
      details: {
        details: {
          kind: "InvalidAuth",
          message: "AUTHENTICATE returned invalid record",
        },
        kind: "Auth",
      },
    });

    const formatted = syncErrorLogDetails(err);

    expect(formatted).toContain("There was a problem with authentication");
    expect(formatted).toContain("NotAllowed");
    expect(formatted).toContain("-32002");
    expect(formatted).toContain("InvalidAuth");
    expect(formatted).toContain("AUTHENTICATE returned invalid record");
    expect(formatted).not.toContain("[Object");
  });
});
