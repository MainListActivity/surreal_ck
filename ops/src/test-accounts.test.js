import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  defaultExpiryInput,
  expiryToIso,
  maxExpiryInput,
  registrationGate,
  renderPreflightHtml,
  testAccountsMarkup,
  validSlug,
} from "./test-accounts.js";

const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const now = new Date("2026-11-13T09:00:00Z");
const DAY = 24 * 3600_000;

describe("测试账号到期时间", () => {
  test("默认 30 天、上限 31 天、过去或超限拒绝", () => {
    expect(Date.parse(defaultExpiryInput(now)) - now.getTime()).toBeGreaterThan(30 * DAY - 60_000);
    expect(Date.parse(defaultExpiryInput(now)) - now.getTime()).toBeLessThanOrEqual(30 * DAY);
    expect(Date.parse(maxExpiryInput(now)) - now.getTime()).toBeLessThanOrEqual(31 * DAY);
    expect(expiryToIso(defaultExpiryInput(now), now).iso).toBeDefined();
    expect(expiryToIso(new Date(now.getTime() + 32 * DAY).toISOString(), now).error).toContain("31");
    expect(expiryToIso(new Date(now.getTime() - DAY).toISOString(), now).error).toBeDefined();
    expect(expiryToIso("", now).error).toBeDefined();
  });

  test("slug 校验与服务端一致", () => {
    expect(validSlug("member-chat-test")).toBe(true);
    expect(validSlug("Member")).toBe(false);
    expect(validSlug("-x")).toBe(false);
  });
});

describe("登记门", () => {
  const base = { subject: "s1", blockers: [], requiresConfirmation: false, confirmationPhrase: "确认到期清理 s1", warnings: [], workspaces: [] };
  test("必须先对同一 subject 预检", () => {
    expect(registrationGate(null, "s1", "").allowed).toBe(false);
    expect(registrationGate(base, "s2", "").allowed).toBe(false);
    expect(registrationGate(base, "s1", "").allowed).toBe(true);
  });
  test("硬拒绝不可被确认短语绕过", () => {
    const blocked = { ...base, blockers: [{ code: "active-platform-operator", message: "x" }], requiresConfirmation: true };
    expect(registrationGate(blocked, "s1", "确认到期清理 s1").allowed).toBe(false);
  });
  test("需确认时短语必须逐字一致", () => {
    const needs = { ...base, requiresConfirmation: true, warnings: ["w"] };
    expect(registrationGate(needs, "s1", "确认到期清理").allowed).toBe(false);
    expect(registrationGate(needs, "s1", "确认到期清理 s1").allowed).toBe(true);
  });
});

describe("预检展示", () => {
  test("列出工作区、成员数、是否标记，并转义", () => {
    const html = renderPreflightHtml(escapeHtml, {
      subject: "<s1>",
      testSubject: null,
      platformOperator: null,
      personalBillingAccount: { exists: false, subscriptionCount: 0 },
      workspaces: [
        { id: "workspace:a", slug: "solo", name: "Solo", role: "admin", isOwner: true, memberCount: 1, testExpiresAt: null, wouldBeMarked: true, newlyMarked: true, membershipRemovedOnExpiry: false },
        { id: "workspace:b", slug: "team", name: "Team", role: "participant", isOwner: false, memberCount: 3, testExpiresAt: null, wouldBeMarked: false, newlyMarked: false, membershipRemovedOnExpiry: true },
      ],
      blockers: [],
      warnings: ["工作区 solo 只有该 subject 一个成员"],
      requiresConfirmation: true,
      confirmationPhrase: "确认到期清理 <s1>",
    });
    expect(html).toContain("&lt;s1&gt;");
    expect(html).not.toContain("<s1>");
    expect(html).toContain("登记后标记到期删除");
    expect(html).toContain("是（新标记）");
    expect(html).toContain("<td>3</td>");
    expect(html).toContain("需确认的后果");
  });

  test("表单字段与按钮", () => {
    const markup = testAccountsMarkup();
    for (const text of ["按邮箱查找 subject", "预检", "登记测试主体", "新建测试工作区", 'name="expiresAt"', 'name="confirm"', 'name="slug"']) {
      expect(markup).toContain(text);
    }
  });

  test("main.js 挂载测试账号页并复用既有运营 token", () => {
    const main = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    expect(main).toContain('data-view="testaccounts"');
    expect(main).toContain("setupTestAccounts({ fetchRaw: apiRaw");
    expect(main).toContain("user?.access_token");
    const module = readFileSync(new URL("./test-accounts.js", import.meta.url), "utf8");
    expect(module).not.toContain("UserManager");
    expect(module).not.toContain("access_token");
    expect(module).not.toContain("sessionStorage");
  });
});
