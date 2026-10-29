import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../hono-types";
import {
  createOpsPlatformOperatorsRoutes,
  type PlatformOperatorsListAudit,
} from "./ops-platform-operators";
import {
  platformOperatorSubjectHash,
  toPlatformOperatorsView,
  type PlatformOperatorListPort,
  type PlatformOperatorSnapshotEntry,
} from "../ops/platform-operators";

const CURRENT = "26dba3a6-4392-4840-a856-264d6f07fbee";
const OTHER = "8a41f4e7-41db-4784-a5e9-28b061124647";

const snapshot = (): PlatformOperatorSnapshotEntry[] => [
  {
    subject: CURRENT,
    kind: "human",
    status: "active",
    capabilities: ["quota.read", "subscription.manage"],
  },
  {
    subject: OTHER,
    kind: null,
    status: "disabled",
    capabilities: [],
  },
];

function allowAs(subject: string): () => MiddlewareHandler<AppBindings> {
  return () => async (c, next) => {
    c.set("platformOperator", { subject, capabilities: ["quota.read"] });
    await next();
  };
}

function deny(): MiddlewareHandler<AppBindings> {
  return async (c) => c.json({ error: "forbidden" }, 403);
}

function fakeList(entries: PlatformOperatorSnapshotEntry[]) {
  const calls = { list: 0 };
  const port: PlatformOperatorListPort = {
    async list() {
      calls.list += 1;
      return entries;
    },
  };
  return { port, calls };
}

describe("GET /api/ops/platform-operators", () => {
  test("返回主体与能力：形状稳定、能力排序、isCurrent 只标记当前会话主体", async () => {
    const { port } = fakeList(snapshot());
    const audits: PlatformOperatorsListAudit[] = [];
    const app = createOpsPlatformOperatorsRoutes({
      list: port,
      requireOperator: allowAs(CURRENT),
      audit: (entry) => audits.push(entry),
    });

    const res = await app.request("/api/ops/platform-operators");
    expect(res.status).toBe(200);

    const body = await res.json() as {
      format_version: number;
      operators: Array<{
        subject_hash: string; kind: string | null; status: string;
        capabilities: string[]; isCurrent: boolean;
      }>;
    };
    expect(body.format_version).toBe(1);
    expect(body.operators).toHaveLength(2);

    const [first, second] = body.operators;
    expect(first).toEqual({
      subject_hash: platformOperatorSubjectHash(CURRENT),
      kind: "human",
      status: "active",
      capabilities: ["quota.read", "subscription.manage"],
      isCurrent: true,
    });
    expect(second).toEqual({
      subject_hash: platformOperatorSubjectHash(OTHER),
      kind: null,
      status: "disabled",
      capabilities: [],
      isCurrent: false,
    });

    // 每次调用写一条审计：只有调用者哈希与数量，不含主体明文。
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      event: "platform-operators.list",
      actorHash: platformOperatorSubjectHash(CURRENT),
      operatorCount: 2,
    });
  });

  test("PII 不泄露：响应里没有原始 subject、邮箱或 display_name", async () => {
    const { port } = fakeList([
      { subject: CURRENT, kind: "human", status: "active", capabilities: ["quota.read"] },
    ]);
    const app = createOpsPlatformOperatorsRoutes({
      list: port,
      requireOperator: allowAs(CURRENT),
      audit: () => {},
    });
    const res = await app.request("/api/ops/platform-operators");
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain(CURRENT);
    expect(raw).not.toContain(OTHER);
    expect(raw).not.toMatch(/@/);
    expect(raw).not.toMatch(/display_name|email|subject"/);
    // 只以 sha256 前缀出现，且长度可控。
    expect(raw).toContain(platformOperatorSubjectHash(CURRENT));
  });

  test("非运营会话被拒（403），且不读库、不写审计", async () => {
    const { port, calls } = fakeList(snapshot());
    const audits: PlatformOperatorsListAudit[] = [];
    const app = createOpsPlatformOperatorsRoutes({
      list: port,
      requireOperator: () => deny(),
      audit: (entry) => audits.push(entry),
    });
    const res = await app.request("/api/ops/platform-operators");
    expect(res.status).toBe(403);
    expect(calls.list).toBe(0);
    expect(audits).toHaveLength(0);
  });

  test("只读：该路径只接受 GET，非 GET 一律 404，读库次数不增加", async () => {
    const { port, calls } = fakeList(snapshot());
    const app = createOpsPlatformOperatorsRoutes({
      list: port,
      requireOperator: allowAs(CURRENT),
      audit: () => {},
    });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.request("/api/ops/platform-operators", { method });
      expect(res.status, method).toBe(404);
    }
    expect(calls.list).toBe(0);

    expect((await app.request("/api/ops/platform-operators")).status).toBe(200);
    expect(calls.list).toBe(1);
  });

  test("空名单返回空数组而不是报错", async () => {
    const { port } = fakeList([]);
    const app = createOpsPlatformOperatorsRoutes({
      list: port,
      requireOperator: allowAs(CURRENT),
      audit: () => {},
    });
    const res = await app.request("/api/ops/platform-operators");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ format_version: 1, operators: [] });
  });
});

describe("toPlatformOperatorsView / platformOperatorSubjectHash", () => {
  test("哈希前缀确定、可对齐且互不相同", () => {
    expect(platformOperatorSubjectHash(CURRENT)).toBe(platformOperatorSubjectHash(CURRENT));
    expect(platformOperatorSubjectHash(CURRENT)).not.toBe(platformOperatorSubjectHash(OTHER));
    expect(platformOperatorSubjectHash(CURRENT)).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  test("能力按字母序输出，且不修改入参", () => {
    const entries: PlatformOperatorSnapshotEntry[] = [{
      subject: CURRENT, kind: "agent", status: "active",
      capabilities: ["subscription.manage", "content.read", "quota.read"],
    }];
    const view = toPlatformOperatorsView(entries, CURRENT);
    expect(view.operators[0]!.capabilities).toEqual([
      "content.read", "quota.read", "subscription.manage",
    ]);
    expect(entries[0]!.capabilities).toEqual([
      "subscription.manage", "content.read", "quota.read",
    ]);
  });
});
