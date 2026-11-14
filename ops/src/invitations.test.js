import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ACTIVATION_URL_PLACEHOLDER,
  DEFAULT_ALLOWANCE_LABEL,
  buildInvitationPayload,
  collectGate,
  defaultAllowanceExpiryInput,
  extractActivationUrl,
  generateIdempotencyKey,
  invitationsMarkup,
  pollInvitation,
  redactActivationUrl,
  renderInvitationSummaryHtml,
  renderProvisionStatusHtml,
  rotateGate,
  safeActivationUrl,
  setupInvitations,
  validIdempotencyKey,
  validProvisionToken,
} from "./invitations.js";

const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const now = new Date("2026-11-13T09:00:00Z");
const DAY = 24 * 3600_000;
const URL_1 = "https://auth.example.com/activate?token=abc_DEF-123&tenant=ck";
const TOKEN = "A".repeat(20) + "b_c-" + "9".repeat(20);

const baseFields = {
  email: "  yyx6953119+jiji1113@gmail.com ",
  displayName: "吉吉测试",
  workspaceSlug: "signal-test-1113",
  workspaceName: "信令验证-1113",
  planKey: "",
  productPlanRevisionId: "",
  quotaPlanRevisionId: "",
  allowanceAmount: "50",
  allowanceExpiresAt: new Date(now.getTime() + 30 * DAY).toISOString(),
  allowanceLabel: "",
  reason: "原生客户端信令联调测试账号",
  idempotencyKey: "ops-invite-20261113T090000Z-abcd1234",
};

describe("幂等键", () => {
  test("生成格式稳定且满足 8–200 字符", () => {
    const key = generateIdempotencyKey(now, () => 0.5);
    expect(key).toBe("ops-invite-20261113T090000Z-iiiiiiii");
    expect(validIdempotencyKey(key)).toBe(true);
    expect(generateIdempotencyKey()).not.toBe(generateIdempotencyKey());
    expect(validIdempotencyKey("short")).toBe(false);
    expect(validIdempotencyKey("x".repeat(201))).toBe(false);
  });
});

describe("开通请求体（对齐 createOpsInvitationSchema）", () => {
  test("合法输入：trim、缺省 planKey=pro、缺省额度标签、ISO 到期、只含 schema 字段", () => {
    const { payload, error } = buildInvitationPayload(baseFields, now);
    expect(error).toBeUndefined();
    expect(payload).toEqual({
      email: "yyx6953119+jiji1113@gmail.com",
      displayName: "吉吉测试",
      workspaceSlug: "signal-test-1113",
      workspaceName: "信令验证-1113",
      planKey: "pro",
      aiAllowance: { amount: 50, expiresAt: new Date(now.getTime() + 30 * DAY).toISOString(), label: DEFAULT_ALLOWANCE_LABEL },
      reason: "原生客户端信令联调测试账号",
      idempotencyKey: "ops-invite-20261113T090000Z-abcd1234",
    });
  });

  test("可选字段只在填写时携带；trial + trial_v2", () => {
    const { payload } = buildInvitationPayload({
      ...baseFields,
      workspaceName: "",
      planKey: "trial",
      quotaPlanRevisionId: "quota_plan_revision:trial_v2",
      productPlanRevisionId: "product_plan_revision:x",
      allowanceLabel: "自定义",
    }, now);
    expect(payload.workspaceName).toBeUndefined();
    expect(payload.planKey).toBe("trial");
    expect(payload.quotaPlanRevisionId).toBe("quota_plan_revision:trial_v2");
    expect(payload.productPlanRevisionId).toBe("product_plan_revision:x");
    expect(payload.aiAllowance.label).toBe("自定义");
  });

  test("逐项拒绝非法输入（中文 slug、前缀、额度、过期、理由、幂等键）", () => {
    const bad = (patch) => buildInvitationPayload({ ...baseFields, ...patch }, now).error;
    expect(bad({ email: "nope" })).toContain("邮箱");
    expect(bad({ displayName: "" })).toContain("显示名");
    expect(bad({ workspaceSlug: "信令验证-1113" })).toContain("slug");
    expect(bad({ workspaceSlug: "-x" })).toContain("slug");
    expect(bad({ workspaceSlug: "Upper" })).toContain("slug");
    expect(bad({ planKey: "Pro" })).toContain("planKey");
    expect(bad({ productPlanRevisionId: "rev:1" })).toContain("product_plan_revision:");
    expect(bad({ quotaPlanRevisionId: "trial_v2" })).toContain("quota_plan_revision:");
    expect(bad({ allowanceAmount: "0" })).toContain("正整数");
    expect(bad({ allowanceAmount: "1.5" })).toContain("正整数");
    expect(bad({ allowanceAmount: "" })).toContain("正整数");
    expect(bad({ allowanceExpiresAt: new Date(now.getTime() - DAY).toISOString() })).toContain("晚于现在");
    expect(bad({ allowanceExpiresAt: "x" })).toContain("无效");
    expect(bad({ reason: " " })).toContain("理由");
    expect(bad({ idempotencyKey: "abc" })).toContain("幂等键");
  });

  test("默认额度到期为 30 天后", () => {
    const ms = Date.parse(defaultAllowanceExpiryInput(now)) - now.getTime();
    expect(ms).toBeGreaterThan(30 * DAY - 60_000);
    expect(ms).toBeLessThanOrEqual(30 * DAY);
  });
});

describe("一次性激活链接", () => {
  test("只接受 http(s)，拒绝 javascript: 等", () => {
    expect(safeActivationUrl(URL_1)).toBe(URL_1);
    expect(safeActivationUrl("javascript:alert(1)")).toBeNull();
    expect(safeActivationUrl("relative/path")).toBeNull();
    expect(safeActivationUrl(null)).toBeNull();
  });
  test("从 InviteResult 与 InviteCollect 两种形状提取", () => {
    expect(extractActivationUrl({ delivery: { activationUrl: URL_1 } })).toBe(URL_1);
    expect(extractActivationUrl({ activationUrl: URL_1 })).toBe(URL_1);
    expect(extractActivationUrl({ delivery: { activationUrl: null } })).toBeNull();
    expect(extractActivationUrl(null)).toBeNull();
  });
  test("原始响应中的链接被替换为占位符（含 JSON 转义形态）", () => {
    const raw = JSON.stringify({ delivery: { activationUrl: "https://a.example/x?t=1&u=/p" } });
    const redacted = redactActivationUrl(raw, "https://a.example/x?t=1&u=/p");
    expect(redacted).not.toContain("a.example");
    expect(redacted).toContain(ACTIVATION_URL_PLACEHOLDER);
    expect(redactActivationUrl("abc", null)).toBe("abc");
  });
});

describe("前置门", () => {
  test("collect 需幂等键 + 勾选一次性确认", () => {
    expect(collectGate("", true).allowed).toBe(false);
    expect(collectGate("ops-invite-1", false).allowed).toBe(false);
    expect(collectGate("ops-invite-1", true).allowed).toBe(true);
  });
  test("rotate 需合法 token + 勾选确认", () => {
    expect(validProvisionToken(TOKEN)).toBe(true);
    expect(validProvisionToken("short")).toBe(false);
    expect(validProvisionToken(`${TOKEN}!`)).toBe(false);
    expect(rotateGate(TOKEN, false).allowed).toBe(false);
    expect(rotateGate("x", true).allowed).toBe(false);
    expect(rotateGate(TOKEN, true).allowed).toBe(true);
  });
});

describe("渲染（全部转义，只展示后端字段）", () => {
  test("邀请摘要", () => {
    const html = renderInvitationSummaryHtml(escapeHtml, {
      idempotencyKey: "<k>",
      status: "completed",
      replayed: true,
      user: { id: "sub-<1>", email: "a@b.c", status: "pending", outcome: "created" },
      workspace: { slug: "ws", dbName: "ws_db", outcome: "created" },
      entitlement: { planKey: "pro", productPlanRevisionId: "product_plan_revision:x", billingAccountKey: "personal:sub" },
      aiAllowance: { amount: 50, expiresAt: "2026-12-13T00:00:00.000Z", periodKey: "invite:k" },
      delivery: { channel: "activation_url", activationUrl: null, pendingCollect: true, note: "<img src=x>" },
    });
    expect(html).toContain("&lt;k&gt;");
    expect(html).toContain("sub-&lt;1&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("激活链接待收取");
    expect(html).toContain("重放既有结果");
    expect(renderInvitationSummaryHtml(escapeHtml, null)).toBe("");
  });

  test("provision token 状态", () => {
    const html = renderProvisionStatusHtml(escapeHtml, {
      configured: true,
      source: "store",
      env: { configured: true },
      store: { sealKeyConfigured: true, entry: { updatedAt: "2026-11-13T00:00:00Z", updatedBy: "<ops>", purpose: "p" }, unsealError: null },
      idp: { reachable: false, status: 401, error: "idp-admin-unauthorized" },
    });
    expect(html).toContain("store");
    expect(html).toContain("&lt;ops&gt;");
    expect(html).toContain("HTTP 401");
    expect(html).toContain("idp-admin-unauthorized");
    const missing = renderProvisionStatusHtml(escapeHtml, { configured: false, source: null, env: { configured: false }, store: { sealKeyConfigured: false, entry: null, unsealError: "secret-unseal-failed" }, idp: { reachable: false, status: null, error: null } });
    expect(missing).toContain("invite-idp-not-configured");
    expect(missing).toContain("secret-unseal-failed");
  });
});

describe("有界轮询", () => {
  const ok = (body) => ({ ok: true, status: 200, text: JSON.stringify(body) });
  test("processing → completed 即停", async () => {
    const queue = [ok({ status: "processing" }), ok({ status: "processing" }), ok({ status: "completed" })];
    const sleeps = [];
    const updates = [];
    const out = await pollInvitation({ fetchStatus: async () => queue.shift(), sleep: async (ms) => { sleeps.push(ms); }, onUpdate: (u) => updates.push(u.attempts), intervalMs: 7, maxAttempts: 10 });
    expect(out.reason).toBe("settled");
    expect(out.attempts).toBe(3);
    expect(sleeps).toEqual([7, 7, 7]);
    expect(updates).toEqual([1, 2, 3]);
  });
  test("HTTP 失败即停、达上限、取消", async () => {
    const err = await pollInvitation({ fetchStatus: async () => ({ ok: false, status: 404, text: "{}" }), sleep: async () => undefined });
    expect(err.reason).toBe("error");
    const exhausted = await pollInvitation({ fetchStatus: async () => ok({ status: "processing" }), sleep: async () => undefined, maxAttempts: 3 });
    expect(exhausted.reason).toBe("exhausted");
    expect(exhausted.attempts).toBe(3);
    let calls = 0;
    const cancelled = await pollInvitation({ fetchStatus: async () => { calls += 1; return ok({ status: "processing" }); }, sleep: async () => undefined, isCancelled: () => true });
    expect(cancelled.reason).toBe("cancelled");
    expect(calls).toBe(0);
  });
});

describe("页面结构", () => {
  test("覆盖 schema 全部字段、token 为密码框、链接只读且不提供跳转", () => {
    const markup = invitationsMarkup();
    for (const name of ["email", "displayName", "workspaceSlug", "workspaceName", "planKey", "productPlanRevisionId", "quotaPlanRevisionId", "allowanceAmount", "allowanceExpiresAt", "allowanceLabel", "reason", "idempotencyKey"]) {
      expect(markup).toContain(`name="${name}"`);
    }
    expect(markup).toContain('id="invitations-view"');
    expect(markup).toContain('name="token" type="password"');
    expect(markup).toContain('id="inv-link" type="text" readonly');
    expect(markup).toContain("复制链接");
    expect(markup).toContain("重新签发激活链接");
    expect(markup).toContain("刷新状态");
    expect(markup).toContain("激活链接只返回一次");
    expect(markup).not.toMatch(/<a\s/u);
  });

  test("源码不打印到 console、不跳转", () => {
    const source = readFileSync(new URL("./invitations.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/console\./u);
    expect(source).not.toMatch(/location\.(href|assign|replace)|window\.open|history\./u);
  });
});

// ---- 交互流程：最小 DOM 替身 ----

function makeElement(id) {
  const listeners = {};
  const named = {};
  return {
    id,
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    selected: false,
    listeners,
    elements: { namedItem: (name) => (named[name] ??= makeElement(`${id}:${name}`)) },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    select() { this.selected = true; },
    async fire(type, extra = {}) {
      for (const fn of listeners[type] || []) await fn({ preventDefault() {}, currentTarget: this, ...extra });
    },
  };
}

function installDom() {
  const ids = [...invitationsMarkup().matchAll(/id="([^"]+)"/gu)].map((m) => m[1]);
  const map = Object.fromEntries(ids.map((id) => [id, makeElement(id)]));
  globalThis.document = { querySelector: (sel) => (sel.startsWith("#") ? map[sel.slice(1)] : null) };
  return map;
}

function fakeFetch(routes) {
  const calls = [];
  const fetchRaw = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body });
    const handler = routes[`${options.method || "GET"} ${path}`];
    if (!handler) return { ok: false, status: 404, text: JSON.stringify({ error: "invite-not-found" }) };
    const [status, body] = typeof handler === "function" ? handler() : handler;
    return { ok: status >= 200 && status < 300, status, text: JSON.stringify(body) };
  };
  return { fetchRaw, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("交互流程", () => {
  let dom;
  const consoleCalls = [];
  const original = {};
  beforeEach(() => {
    dom = installDom();
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      original[level] = console[level];
      console[level] = (...args) => consoleCalls.push(args);
    }
    globalThis.navigator = { clipboard: { writeText: async (v) => { globalThis.__copied = v; } } };
  });
  afterEach(() => {
    for (const level of Object.keys(original)) console[level] = original[level];
    delete globalThis.document;
  });

  function fillForm(key) {
    const form = dom["inv-form"];
    for (const [name, value] of Object.entries({ ...baseFields, allowanceExpiresAt: new Date(Date.now() + 30 * DAY).toISOString(), idempotencyKey: key })) {
      form.elements.namedItem(name).value = value;
    }
  }

  test("初始化：预填幂等键与 30 天额度到期；切页加载 token 状态", async () => {
    const { fetchRaw, calls } = fakeFetch({ "GET /ops/idp-provision-token/status": [200, { configured: true, source: "env", env: { configured: true }, store: { sealKeyConfigured: false, entry: null, unsealError: null }, idp: { reachable: true, status: null, error: null } }] });
    const api = setupInvitations({ fetchRaw, escapeHtml, isSignedIn: () => true, sleep: async () => undefined });
    expect(dom["inv-form"].elements.namedItem("idempotencyKey").value).toStartWith("ops-invite-");
    expect(dom["inv-form"].elements.namedItem("allowanceExpiresAt").value).not.toBe("");
    expect(dom["inv-collect"].disabled).toBe(true);
    await api.loadTokenStatus();
    expect(calls.map((c) => c.path)).toEqual(["/ops/idp-provision-token/status"]);
    expect(dom["inv-token-summary"].innerHTML).toContain("env");
    expect(dom["inv-token-raw"].innerHTML).toContain("HTTP 200");
  });

  test("同步 201：链接只进只读框，原始响应中被替换；状态区填入幂等键与 subject", async () => {
    const key = "ops-invite-sync-0001";
    const result = { idempotencyKey: key, status: "completed", replayed: false, user: { id: "sub-1", email: "a@b.c", status: "pending", outcome: "created" }, workspace: { slug: "signal-test-1113", dbName: "db1", outcome: "created" }, entitlement: null, aiAllowance: null, delivery: { channel: "activation_url", activationUrl: URL_1, pendingCollect: false, note: "n" } };
    const { fetchRaw, calls } = fakeFetch({ "POST /ops/invitations": [201, result] });
    let used = null;
    setupInvitations({ fetchRaw, escapeHtml, isSignedIn: () => true, onUseSubject: (s) => { used = s; }, sleep: async () => undefined });
    fillForm(key);
    await dom["inv-form"].fire("submit");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body).workspaceSlug).toBe("signal-test-1113");
    expect(dom["inv-link"].value).toBe(URL_1);
    expect(dom["inv-link-box"].hidden).toBe(false);
    expect(dom["inv-submit-result"].innerHTML).toContain("HTTP 201");
    expect(dom["inv-delivery-status"].textContent).toContain("一次性下发");
    expect(dom["inv-submit-result"].innerHTML).not.toContain("auth.example.com");
    expect(dom["inv-status-raw"].innerHTML).not.toContain("auth.example.com");
    expect(dom["inv-query-form"].elements.namedItem("idempotencyKey").value).toBe(key);
    expect(dom["inv-subject-actions"].hidden).toBe(false);
    await dom["inv-use-subject"].fire("click");
    expect(used).toBe("sub-1");
    await dom["inv-link-copy"].fire("click");
    expect(globalThis.__copied).toBe(URL_1);
    await dom["inv-link-clear"].fire("click");
    expect(dom["inv-link"].value).toBe("");
    expect(dom["inv-link-box"].hidden).toBe(true);
    expect(consoleCalls).toEqual([]);
  });

  test("202 → 自动轮询至完成 → 勾选确认后一次性收取 → 再收取为空", async () => {
    const key = "ops-invite-async-0001";
    const processing = { idempotencyKey: key, status: "processing", replayed: false, user: null, workspace: null, entitlement: null, aiAllowance: null, delivery: { channel: "none", activationUrl: null, pendingCollect: false, note: "开通仍在进行" } };
    const completed = { ...processing, status: "completed", replayed: true, user: { id: "sub-2", email: "a@b.c", status: "pending", outcome: "created" }, delivery: { channel: "activation_url", activationUrl: null, pendingCollect: true, note: "待收取" } };
    const polls = [[200, processing], [200, completed]];
    let collected = false;
    const { fetchRaw, calls } = fakeFetch({
      "POST /ops/invitations": [202, processing],
      [`GET /ops/invitations/${key}`]: () => polls.shift() ?? [200, completed],
      [`POST /ops/invitations/${key}/collect-delivery`]: () => {
        const first = !collected;
        collected = true;
        return [200, { idempotencyKey: key, status: "completed", activationUrl: first ? URL_1 : null, deliveredAt: "2026-11-13T10:00:00Z", errorCode: null, errorMessage: null }];
      },
    });
    setupInvitations({ fetchRaw, escapeHtml, isSignedIn: () => true, sleep: async () => undefined });
    fillForm(key);
    await dom["inv-form"].fire("submit");
    expect(dom["inv-submit-status"].textContent).toContain("202");
    for (let i = 0; i < 10; i += 1) await settle();
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
    expect(dom["inv-poll-status"].textContent).toContain("已完成");
    expect(dom["inv-status-summary"].innerHTML).toContain("激活链接待收取");
    expect(dom["inv-link-box"].hidden).toBe(true); // 尚未收取：链接框保持隐藏且为空
    expect(dom["inv-link"].value).toBe("");
    // 未勾选确认不可收取
    expect(dom["inv-collect"].disabled).toBe(true);
    await dom["inv-collect"].fire("click");
    expect(calls.some((c) => c.path.endsWith("/collect-delivery"))).toBe(false);
    dom["inv-collect-ack"].checked = true;
    await dom["inv-collect-ack"].fire("change");
    expect(dom["inv-collect"].disabled).toBe(false);
    await dom["inv-collect"].fire("click");
    expect(dom["inv-link"].value).toBe(URL_1);
    expect(dom["inv-delivery-result"].innerHTML).not.toContain("auth.example.com");
    expect(dom["inv-collect-ack"].checked).toBe(false);
    expect(dom["inv-collect"].disabled).toBe(true);
    dom["inv-collect-ack"].checked = true;
    await dom["inv-collect-ack"].fire("change");
    await dom["inv-collect"].fire("click");
    expect(dom["inv-delivery-status"].textContent).toContain("被收取过");
    expect(calls.filter((c) => c.path.endsWith("/collect-delivery")).length).toBe(2);
    expect(consoleCalls).toEqual([]);
  });

  test("手动按幂等键查询；resend 走 POST .../resend 并提示收取", async () => {
    const key = "existing-key-123";
    const { fetchRaw, calls } = fakeFetch({
      [`GET /ops/invitations/${key}`]: [200, { idempotencyKey: key, status: "failed", replayed: true, user: null, workspace: null, entitlement: null, aiAllowance: null, delivery: { channel: "none", activationUrl: null, pendingCollect: false, note: "重放返回既有失败结果" } }],
      [`POST /ops/invitations/${key}/resend`]: [200, { idempotencyKey: key, status: "completed", replayed: true, user: null, workspace: null, entitlement: null, aiAllowance: null, delivery: { channel: "activation_url", activationUrl: null, pendingCollect: true, note: "激活链接已重签发" } }],
    });
    setupInvitations({ fetchRaw, escapeHtml, isSignedIn: () => true, sleep: async () => undefined });
    dom["inv-query-form"].elements.namedItem("idempotencyKey").value = key;
    await dom["inv-query-form"].fire("submit");
    await settle();
    expect(calls[0]).toMatchObject({ path: `/ops/invitations/${key}`, method: "GET" });
    expect(dom["inv-status-summary"].innerHTML).toContain("失败");
    await dom["inv-resend"].fire("click");
    expect(calls[1]).toMatchObject({ path: `/ops/invitations/${key}/resend`, method: "POST" });
    expect(dom["inv-delivery-status"].textContent).toContain("收取激活链接");
  });

  test("409/503 错误逐字显示", async () => {
    const key = "ops-invite-conflict-01";
    const { fetchRaw } = fakeFetch({ "POST /ops/invitations": [503, { error: "invite-idp-not-configured", message: "IdP provision token 未配置" }] });
    setupInvitations({ fetchRaw, escapeHtml, isSignedIn: () => true, sleep: async () => undefined });
    fillForm(key);
    await dom["inv-form"].fire("submit");
    expect(dom["inv-submit-result"].innerHTML).toContain("HTTP 503");
    expect(dom["inv-submit-result"].innerHTML).toContain("invite-idp-not-configured");
    expect(dom["inv-submit-result"].innerHTML).toContain("raw-result error");
  });

  test("rotate：非法/未确认也立即清空输入；合法提交后清空并刷新状态", async () => {
    const { fetchRaw, calls } = fakeFetch({
      "POST /ops/idp-provision-token/rotate": [200, { rotated: true, secretName: "idp_provision_token", source: "store", updatedAt: "t", updatedBy: "ops" }],
      "GET /ops/idp-provision-token/status": [200, { configured: true, source: "store", env: { configured: true }, store: { sealKeyConfigured: true, entry: null, unsealError: null }, idp: { reachable: true } }],
    });
    setupInvitations({ fetchRaw, escapeHtml, isSignedIn: () => true, sleep: async () => undefined });
    const form = dom["inv-rotate-form"];
    form.elements.namedItem("token").value = TOKEN;
    await form.fire("submit");
    expect(form.elements.namedItem("token").value).toBe("");
    expect(calls.length).toBe(0);
    expect(dom["inv-rotate-status"].textContent).toContain("勾选");
    form.elements.namedItem("token").value = TOKEN;
    form.elements.namedItem("ack").checked = true;
    await form.fire("submit");
    expect(form.elements.namedItem("token").value).toBe("");
    expect(form.elements.namedItem("ack").checked).toBe(false);
    expect(calls[0]).toMatchObject({ path: "/ops/idp-provision-token/rotate", method: "POST" });
    expect(JSON.parse(calls[0].body)).toEqual({ token: TOKEN });
    await settle();
    expect(calls[1]).toMatchObject({ path: "/ops/idp-provision-token/status", method: "GET" });
    expect(dom["inv-rotate-result"].innerHTML).not.toContain(TOKEN);
    expect(consoleCalls).toEqual([]);
  });
});
