import { describe, test, expect } from "bun:test";
import { decodeTokenClaims } from "./identity";
import { ServiceError } from "./errors";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

describe("decodeTokenClaims", () => {
  test("正常 claims 解码成功", () => {
    const token = makeJwt({ sub: "user-123", email: "a@b.com", name: "Alice", exp: 9999 });
    const claims = decodeTokenClaims(token);
    expect(claims.sub).toBe("user-123");
    expect(claims.email).toBe("a@b.com");
    expect(claims.name).toBe("Alice");
    expect(claims.exp).toBe(9999);
  });

  test("缺少 email/name 等可选字段时返回 undefined", () => {
    const token = makeJwt({ sub: "user-456" });
    const claims = decodeTokenClaims(token);
    expect(claims.sub).toBe("user-456");
    expect(claims.email).toBeUndefined();
    expect(claims.name).toBeUndefined();
  });

  test("缺少 sub 时抛出 VALIDATION_ERROR", () => {
    const token = makeJwt({ email: "a@b.com" });
    try {
      decodeTokenClaims(token);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).code).toBe("VALIDATION_ERROR");
    }
  });

  test("格式无效（非三段式）时抛出 VALIDATION_ERROR", () => {
    try {
      decodeTokenClaims("not.ajwt");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).code).toBe("VALIDATION_ERROR");
    }
  });

  test("payload 不是合法 JSON 时抛出 VALIDATION_ERROR", () => {
    const badToken = `header.${Buffer.from("notjson").toString("base64url")}.sig`;
    try {
      decodeTokenClaims(badToken);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).code).toBe("VALIDATION_ERROR");
    }
  });

  test("preferred_username 字段正确提取", () => {
    const token = makeJwt({ sub: "u1", preferred_username: "alice_work" });
    const claims = decodeTokenClaims(token);
    expect(claims.preferred_username).toBe("alice_work");
  });

  test("picture 字段正确提取", () => {
    const token = makeJwt({ sub: "u1", picture: "https://example.com/avatar.png" });
    const claims = decodeTokenClaims(token);
    expect(claims.picture).toBe("https://example.com/avatar.png");
  });
});
