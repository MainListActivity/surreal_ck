import { describe, expect, test } from "bun:test";
import { createRunRegistry, STREAM_TOKEN_TTL_MS } from "./run-registry";

describe("RunRegistry", () => {
  test("register 后可按 runId 取回 owner 与 streamToken", () => {
    const reg = createRunRegistry();
    const { streamToken } = reg.register({ runId: "run-1", ownerSubject: "alice" });

    const record = reg.get("run-1");
    expect(record?.ownerSubject).toBe("alice");
    expect(record?.streamToken).toBe(streamToken);
  });

  test("resolveStreamToken 要求 runId 与 token 同时匹配", () => {
    const reg = createRunRegistry();
    const { streamToken } = reg.register({ runId: "run-1", ownerSubject: "alice" });

    expect(reg.resolveStreamToken({ runId: "run-1", streamToken })?.ownerSubject).toBe("alice");
    expect(reg.resolveStreamToken({ runId: "run-1", streamToken: "nope" })).toBeUndefined();
    expect(reg.resolveStreamToken({ runId: "other", streamToken })).toBeUndefined();
  });

  test("streamToken 超过 TTL 后视为过期：get / resolve 都返回 undefined", () => {
    let now = 1_000_000;
    const reg = createRunRegistry(() => now);
    const { streamToken } = reg.register({ runId: "run-1", ownerSubject: "alice" });

    now += STREAM_TOKEN_TTL_MS - 1;
    expect(reg.get("run-1")).toBeDefined();

    now += 2; // 越过 TTL
    expect(reg.get("run-1")).toBeUndefined();
    expect(reg.resolveStreamToken({ runId: "run-1", streamToken })).toBeUndefined();
  });

  test("同一 runId 再次 register（resume 刷新）会换发新 token 并续 TTL", () => {
    let now = 0;
    const reg = createRunRegistry(() => now);
    const first = reg.register({ runId: "run-1", ownerSubject: "alice" });

    now += STREAM_TOKEN_TTL_MS - 10;
    const second = reg.register({ runId: "run-1", ownerSubject: "alice" });

    expect(second.streamToken).not.toBe(first.streamToken);
    // 旧 token 失效，新 token 生效
    expect(reg.resolveStreamToken({ runId: "run-1", streamToken: first.streamToken })).toBeUndefined();
    expect(reg.resolveStreamToken({ runId: "run-1", streamToken: second.streamToken })?.ownerSubject).toBe("alice");
  });
});
