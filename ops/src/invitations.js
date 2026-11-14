// 「邀请开通」：运营代办开通（G2）+ IdP provision token 状态/免部署轮换。
// 端点：POST/GET /api/ops/invitations[/:key]、POST .../collect-delivery、POST .../resend、
// GET /api/ops/idp-provision-token/status、POST /api/ops/idp-provision-token/rotate。
// 复用控制台既有运营 token（由 main.js 注入 fetchRaw），不新建 OIDC client、不读取 token 内容。
// 服务端结果/错误按 HTTP 状态 + 原始响应体逐字显示；唯一例外是一次性激活链接——
// 它从原始响应中替换为占位符，只在专用只读框内出现一次，不写 console、不进地址栏/历史。

import { toLocalInputValue } from "./test-accounts.js";

export const DEFAULT_ALLOWANCE_DAYS = 30;
export const DEFAULT_ALLOWANCE_LABEL = "邀请试点 AI 额度";
export const DEFAULT_PLAN_KEY = "pro";
export const TRIAL_PLAN_KEY = "trial";
export const TRIAL_QUOTA_REVISION = "quota_plan_revision:trial_v2";
export const POLL_INTERVAL_MS = 5_000;
export const POLL_MAX_ATTEMPTS = 60;
export const ACTIVATION_URL_PLACEHOLDER = "«一次性激活链接：已移至下方激活链接框»";

const DAY_MS = 24 * 60 * 60 * 1000;
// 与 shared/src/ops-invitation.ts（createOpsInvitationSchema）逐条一致。
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const PLAN_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// 与 shared/src/ops-provision-token.ts（rotateIdpProvisionTokenSchema）一致。
const PROVISION_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/u;

/** ops-invite-<UTC 时间戳>-<随机 8 位>，满足服务端 8–200 字符要求。 */
export function generateIdempotencyKey(now = new Date(), random = Math.random) {
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  let suffix = "";
  for (let i = 0; i < 8; i += 1) suffix += Math.floor(random() * 36).toString(36);
  return `ops-invite-${stamp}-${suffix}`;
}

export function validIdempotencyKey(key) {
  const value = String(key ?? "");
  return value.length >= 8 && value.length <= 200;
}

export function defaultAllowanceExpiryInput(now = new Date()) {
  return toLocalInputValue(new Date(now.getTime() + DEFAULT_ALLOWANCE_DAYS * DAY_MS));
}

export function validProvisionToken(token) {
  return PROVISION_TOKEN_RE.test(String(token ?? ""));
}

function text(fields, name) {
  const value = typeof fields.get === "function" ? fields.get(name) : fields[name];
  return String(value ?? "").trim();
}

/**
 * 把表单字段组装成 createOpsInvitationSchema 接受的请求体（strict，不带多余字段）。
 * 前端校验只为尽早给出可读提示；服务端会重新校验并以 400 invite-invalid-request 拒绝。
 */
export function buildInvitationPayload(fields, now = new Date()) {
  const email = text(fields, "email");
  const displayName = text(fields, "displayName");
  const workspaceSlug = text(fields, "workspaceSlug");
  const workspaceName = text(fields, "workspaceName");
  const planKey = text(fields, "planKey") || DEFAULT_PLAN_KEY;
  const productPlanRevisionId = text(fields, "productPlanRevisionId");
  const quotaPlanRevisionId = text(fields, "quotaPlanRevisionId");
  const amountText = text(fields, "allowanceAmount");
  const expiresText = text(fields, "allowanceExpiresAt");
  const label = text(fields, "allowanceLabel") || DEFAULT_ALLOWANCE_LABEL;
  const reason = text(fields, "reason");
  const idempotencyKey = text(fields, "idempotencyKey");

  if (!EMAIL_RE.test(email) || email.length > 200) return { error: "邮箱无效" };
  if (!displayName || displayName.length > 80) return { error: "显示名必填，最多 80 字" };
  if (!SLUG_RE.test(workspaceSlug)) return { error: "workspace slug 须为小写字母/数字/连字符，1–40 位，首尾非连字符（中文名请填在「工作区名称」）" };
  if (workspaceName.length > 80) return { error: "工作区名称最多 80 字" };
  if (!PLAN_KEY_RE.test(planKey)) return { error: "planKey 须为小写字母开头的 2–64 位 [a-z0-9_]" };
  if (productPlanRevisionId && !productPlanRevisionId.startsWith("product_plan_revision:")) {
    return { error: "产品版本须以 product_plan_revision: 开头（留空则用 pro_trial_configuration 默认）" };
  }
  if (quotaPlanRevisionId && !quotaPlanRevisionId.startsWith("quota_plan_revision:")) {
    return { error: "容量修订须以 quota_plan_revision: 开头（留空则用该套餐 active_revision）" };
  }
  const amount = Number(amountText);
  if (!amountText || !Number.isInteger(amount) || amount <= 0) return { error: "AI 额度须为正整数" };
  const expiresMs = Date.parse(expiresText);
  if (!Number.isFinite(expiresMs)) return { error: "AI 额度到期时间无效" };
  if (expiresMs <= now.getTime()) return { error: "AI 额度到期时间必须晚于现在" };
  if (label.length > 80) return { error: "额度标签最多 80 字" };
  if (!reason || reason.length > 500) return { error: "开通理由必填，最多 500 字（写入审计）" };
  if (!validIdempotencyKey(idempotencyKey)) return { error: "幂等键须为 8–200 个字符（可点「生成」）" };

  const payload = {
    email,
    displayName,
    workspaceSlug,
    ...(workspaceName ? { workspaceName } : {}),
    planKey,
    ...(productPlanRevisionId ? { productPlanRevisionId } : {}),
    ...(quotaPlanRevisionId ? { quotaPlanRevisionId } : {}),
    aiAllowance: { amount, expiresAt: new Date(expiresMs).toISOString(), label },
    reason,
    idempotencyKey,
  };
  return { payload };
}

/** 按 name 读表单当前值（真实 DOM 与测试替身通用）。 */
export function formFields(form) {
  return { get: (name) => form.elements.namedItem(name)?.value ?? "" };
}

export function parseJson(result) {
  try { return JSON.parse(result.text); } catch { return null; }
}

/** 仅接受 http(s) 绝对地址作为可展示的激活链接。 */
export function safeActivationUrl(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** 邀请结果（InviteResult）或收取结果（InviteCollect）中的一次性激活链接。 */
export function extractActivationUrl(body) {
  if (!body || typeof body !== "object") return null;
  return safeActivationUrl(body.delivery?.activationUrl ?? body.activationUrl ?? null);
}

/** 原始响应体去掉一次性激活链接（替换为占位符），其余逐字保留。 */
export function redactActivationUrl(rawText, url) {
  if (!url) return String(rawText ?? "");
  const raw = String(rawText ?? "");
  const jsonEscaped = JSON.stringify(url).slice(1, -1);
  return raw.split(jsonEscaped).join(ACTIVATION_URL_PLACEHOLDER).split(url).join(ACTIVATION_URL_PLACEHOLDER);
}

export function isProcessing(body) {
  return Boolean(body && body.status === "processing");
}

/**
 * 有界轮询：每 intervalMs 调一次 fetchStatus，直至非 processing、HTTP 失败、
 * 被取消或达到 maxAttempts。返回 { reason, result, body, attempts }。
 */
export async function pollInvitation({ fetchStatus, sleep, onUpdate = () => undefined, isCancelled = () => false, intervalMs = POLL_INTERVAL_MS, maxAttempts = POLL_MAX_ATTEMPTS }) {
  let last = { reason: "exhausted", result: null, body: null, attempts: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await sleep(intervalMs);
    if (isCancelled()) return { ...last, reason: "cancelled" };
    const result = await fetchStatus();
    const body = result.ok ? parseJson(result) : null;
    last = { reason: "exhausted", result, body, attempts: attempt };
    onUpdate(last);
    if (isCancelled()) return { ...last, reason: "cancelled" };
    if (!result.ok || !body) return { ...last, reason: "error" };
    if (!isProcessing(body)) return { ...last, reason: "settled" };
  }
  return last;
}

function verbatim(escapeHtml, result, url = null) {
  return `<pre class="raw-result ${result.ok ? "" : "error"}">HTTP ${escapeHtml(result.status)}\n${escapeHtml(redactActivationUrl(result.text, url))}</pre>`;
}

const STATUS_LABEL = { processing: "进行中", completed: "已完成", failed: "失败" };
const OUTCOME_LABEL = { created: "新建", reused: "复用" };

/** 邀请结果摘要：只展示服务端实际返回的字段，全部转义。 */
export function renderInvitationSummaryHtml(escapeHtml, body) {
  if (!body || typeof body !== "object") return "";
  const rows = [];
  const add = (label, value) => rows.push(`<dt>${label}</dt><dd>${value}</dd>`);
  if (body.idempotencyKey !== undefined) add("幂等键", `<code>${escapeHtml(body.idempotencyKey)}</code>`);
  if (body.status !== undefined) add("状态", `<span class="invite-status invite-status-${escapeHtml(body.status)}">${escapeHtml(STATUS_LABEL[body.status] || body.status)}</span>${body.replayed ? "（重放既有结果）" : ""}`);
  if (body.user) {
    add("IdP 用户（subject）", `<code>${escapeHtml(body.user.id)}</code>`);
    add("用户", `${escapeHtml(body.user.email)} · ${escapeHtml(body.user.status)} · ${escapeHtml(OUTCOME_LABEL[body.user.outcome] || body.user.outcome)}`);
  }
  if (body.workspace) {
    add("工作区", `${escapeHtml(body.workspace.slug)} · <code>${escapeHtml(body.workspace.dbName)}</code> · ${escapeHtml(OUTCOME_LABEL[body.workspace.outcome] || body.workspace.outcome)}`);
  }
  if (body.entitlement) {
    add("套餐 / 产品版本", `${escapeHtml(body.entitlement.planKey)} · <code>${escapeHtml(body.entitlement.productPlanRevisionId)}</code>`);
    add("计费账户", `<code>${escapeHtml(body.entitlement.billingAccountKey)}</code>`);
  }
  if (body.aiAllowance) {
    add("AI 额度", `${escapeHtml(body.aiAllowance.amount)} · 到期 ${escapeHtml(body.aiAllowance.expiresAt)} · <code>${escapeHtml(body.aiAllowance.periodKey)}</code>`);
  }
  if (body.delivery) {
    add("交付", `${escapeHtml(body.delivery.channel)}${body.delivery.pendingCollect ? " · <strong>激活链接待收取</strong>" : ""}`);
    if (body.delivery.note) add("说明", escapeHtml(body.delivery.note));
  }
  if (body.deliveredAt !== undefined) add("收取时间", escapeHtml(body.deliveredAt || "从未收取"));
  if (body.errorCode) add("错误", `<span class="error">${escapeHtml(body.errorCode)}：${escapeHtml(body.errorMessage || "")}</span>`);
  return rows.length ? `<dl class="preflight-meta">${rows.join("")}</dl>` : "";
}

/** provision token 状态：只展示 GET /api/ops/idp-provision-token/status 实际返回的字段。 */
export function renderProvisionStatusHtml(escapeHtml, body) {
  if (!body || typeof body !== "object") return "";
  const yes = (value) => (value ? "是" : "否");
  const entry = body.store?.entry;
  const idp = body.idp || {};
  const idpText = idp.reachable
    ? `<span class="status-accepted">可达</span>`
    : `<span class="error">不可达${idp.status ? `（HTTP ${escapeHtml(idp.status)}）` : ""}${idp.error ? ` · ${escapeHtml(idp.error)}` : ""}</span>`;
  return `
    <dl class="preflight-meta">
      <dt>已配置</dt><dd>${body.configured ? `<span class="status-accepted">是</span>` : `<span class="error">否（邀请将返回 503 invite-idp-not-configured）</span>`}</dd>
      <dt>现行来源</dt><dd>${escapeHtml(body.source || "无")}</dd>
      <dt>env 兜底（IDP_PROVISION_TOKEN）</dt><dd>${yes(body.env?.configured)}</dd>
      <dt>密封仓主密钥（PLATFORM_SECRET_KEY）</dt><dd>${yes(body.store?.sealKeyConfigured)}</dd>
      <dt>密封行</dt><dd>${entry ? `更新于 ${escapeHtml(entry.updatedAt)} · ${escapeHtml(entry.updatedBy)}${entry.purpose ? `<br><span class="muted">${escapeHtml(entry.purpose)}</span>` : ""}` : "无"}</dd>
      ${body.store?.unsealError ? `<dt>解封错误</dt><dd class="error">${escapeHtml(body.store.unsealError)}</dd>` : ""}
      <dt>IdP 只读探测</dt><dd>${body.configured ? idpText : "未探测（无 token）"}</dd>
    </dl>`;
}

/** collect-delivery 前置门：必须有合法幂等键，且运营勾选「一次性」确认。 */
export function collectGate(key, acknowledged) {
  if (!validIdempotencyKey(key)) return { allowed: false, reason: "请先填写或查询幂等键" };
  if (!acknowledged) return { allowed: false, reason: "请先勾选确认：激活链接只返回一次" };
  return { allowed: true, reason: "" };
}

/** rotate 前置门：token 格式合法且运营勾选确认。 */
export function rotateGate(token, acknowledged) {
  if (!validProvisionToken(token)) return { allowed: false, reason: "token 须为 32–128 位 [A-Za-z0-9_-]" };
  if (!acknowledged) return { allowed: false, reason: "请先勾选确认轮换" };
  return { allowed: true, reason: "" };
}

export function invitationsMarkup() {
  return `
      <main id="invitations-view" class="activation-layout" hidden>
        <section class="panel activation-panel">
          <div class="panel-heading"><div><h2>代办开通邀请</h2><p class="muted activation-help">需要 subscription.manage。一条链路完成：IdP 建用户（已存在则复用）→ 建工作区（manual 套餐分配，不产生付费）→ 绑定产品版本 → 授予 AI 额度。同幂等键同参数重放返回既有结果；参数不同报 409 invite-conflict。</p></div></div>
          <form id="inv-form" class="source-form" autocomplete="off">
            <label>邮箱<input name="email" type="email" required maxlength="200" placeholder="member@example.com" autocomplete="off" /></label>
            <label>显示名<input name="displayName" required maxlength="80" autocomplete="off" /></label>
            <label>工作区 slug（小写字母/数字/连字符）<input name="workspaceSlug" required maxlength="40" placeholder="signal-test-1113" autocomplete="off" /></label>
            <label>工作区名称（可选，缺省用显示名；可填中文）<input name="workspaceName" maxlength="80" autocomplete="off" /></label>
            <label>套餐 planKey（缺省 pro）<input name="planKey" maxlength="64" list="inv-plan-keys" placeholder="pro" autocomplete="off" /><datalist id="inv-plan-keys"><option value="pro"></option><option value="trial"></option></datalist></label>
            <label>容量修订 quotaPlanRevisionId（可选）<input name="quotaPlanRevisionId" maxlength="200" placeholder="quota_plan_revision:trial_v2" autocomplete="off" /></label>
            <div class="form-actions wide"><button type="button" class="ghost" id="inv-use-trial">使用 trial + trial_v2 容量</button><span class="muted inv-hint">pro（2 表/6 字段/4 记录）装不下 bankruptcy-claims 模板；trial 必须显式指定修订。不存在的套餐/修订会被明确拒绝。</span></div>
            <label class="wide">产品版本 productPlanRevisionId（可选，缺省用 pro_trial_configuration 批准的版本）<input name="productPlanRevisionId" maxlength="200" placeholder="product_plan_revision:…" autocomplete="off" /></label>
            <label>AI 额度（正整数）<input name="allowanceAmount" type="number" min="1" step="1" required autocomplete="off" /></label>
            <label>AI 额度到期（默认 30 天后）<input name="allowanceExpiresAt" type="datetime-local" required /></label>
            <label class="wide">额度标签<input name="allowanceLabel" maxlength="80" placeholder="${DEFAULT_ALLOWANCE_LABEL}" autocomplete="off" /></label>
            <label class="wide">开通理由（写入审计）<textarea name="reason" required maxlength="500" rows="2"></textarea></label>
            <label class="wide">幂等键 idempotencyKey（8–200 字符；同键可查询/重试）<input name="idempotencyKey" required minlength="8" maxlength="200" autocomplete="off" /></label>
            <div class="form-actions wide"><button type="button" class="ghost" id="inv-gen-key">生成新幂等键</button><button type="submit" id="inv-submit">提交开通</button><span id="inv-submit-status" class="status muted"></span></div>
          </form>
          <div id="inv-submit-result"></div>
        </section>
        <section class="panel activation-panel">
          <div class="panel-heading"><div><h2>开通状态与激活链接</h2><p class="muted activation-help">POST 在同步窗内完成返回 201（激活链接随响应一次性下发）；超时返回 202 processing，任务在后台继续——按幂等键轮询至完成，再一次性收取激活链接。</p></div></div>
          <form id="inv-query-form" class="source-form" autocomplete="off">
            <label class="wide">幂等键<input name="idempotencyKey" required minlength="8" maxlength="200" autocomplete="off" /></label>
            <div class="form-actions wide"><button type="submit">刷新状态</button><button type="button" class="ghost" id="inv-poll-stop" hidden>停止自动轮询</button><span id="inv-poll-status" class="status muted"></span></div>
          </form>
          <div id="inv-status-summary"></div>
          <div id="inv-status-raw"></div>
          <div class="inv-subject-actions" id="inv-subject-actions" hidden><button type="button" class="ghost" id="inv-use-subject">填入「测试账号」登记表单</button><span class="muted inv-hint">开通完成后再到「测试账号」做预检与登记。</span></div>
          <div class="inv-delivery">
            <h4>一次性激活链接</h4>
            <p class="muted activation-help">collect-delivery 只在首次成功收取时返回链接，随即从服务端清除；再次收取只得到空链接。链接请直接复制转交用户，不要在本浏览器打开。</p>
            <label class="inv-ack"><input type="checkbox" id="inv-collect-ack" /> 我已了解：激活链接只返回一次，收取后需立即复制转交</label>
            <div class="form-actions"><button type="button" id="inv-collect" disabled>收取激活链接</button><button type="button" class="ghost" id="inv-resend">重新签发激活链接</button><span id="inv-delivery-status" class="status muted"></span></div>
            <div id="inv-link-box" class="inv-link-box" hidden>
              <input id="inv-link" type="text" readonly autocomplete="off" spellcheck="false" />
              <button type="button" id="inv-link-copy">复制链接</button>
              <button type="button" class="ghost" id="inv-link-clear">清除显示</button>
            </div>
            <div id="inv-delivery-result"></div>
          </div>
        </section>
        <section class="panel activation-panel">
          <div class="panel-heading"><div><h2>IdP provision token</h2><p class="muted activation-help">状态需要 quota.read；轮换需要 subscription.manage。来源优先级：密封仓（store）→ env 兜底（IDP_PROVISION_TOKEN）→ 未配置。不显示 token 本身。</p></div><button id="inv-token-refresh" class="ghost">刷新</button></div>
          <div id="inv-token-status" class="status muted">切换到本页时自动加载。</div>
          <div id="inv-token-summary"></div>
          <div id="inv-token-raw"></div>
          <form id="inv-rotate-form" class="source-form" autocomplete="off">
            <p class="muted activation-help wide">常规轮换优先用 ops broker 的 <code>ops_idp_provision_rotate</code>；仅在 broker 不可用时手工粘贴新 token。服务端先向 IdP 只读探测，通过后才密封写入，下一次邀请即生效、无需重新部署。需 PLATFORM_SECRET_KEY 已配置，否则 503。</p>
            <label class="wide">新 provision token（不回显、提交后立即清空）<input name="token" type="password" required minlength="32" maxlength="128" autocomplete="new-password" spellcheck="false" /></label>
            <label class="wide inv-ack"><input type="checkbox" name="ack" /> 确认用该 token 替换现行 IdP provision token（旧 principal 需另行吊销）</label>
            <div class="form-actions wide"><button type="submit" id="inv-rotate">轮换 token</button><span id="inv-rotate-status" class="status muted"></span></div>
          </form>
          <div id="inv-rotate-result"></div>
        </section>
      </main>`;
}

/**
 * 绑定事件。fetchRaw(path, options) 由 main.js 提供：带当前运营 token 请求
 * `${apiBase}${path}`，返回 { ok, status, text }（不抛出 HTTP 错误）。
 * onUseSubject(subject) 可选：把开通得到的 subject 交给「测试账号」页。
 */
export function setupInvitations({ fetchRaw, escapeHtml, isSignedIn, onUseSubject, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const $ = (selector) => document.querySelector(selector);
  const form = $("#inv-form");
  const queryForm = $("#inv-query-form");
  const rotateForm = $("#inv-rotate-form");
  const state = { pollToken: 0, subject: null };

  form.elements.namedItem("allowanceExpiresAt").value = defaultAllowanceExpiryInput();
  form.elements.namedItem("idempotencyKey").value = generateIdempotencyKey();

  const currentKey = () => queryForm.elements.namedItem("idempotencyKey").value.trim();
  const keyPath = (key) => `/ops/invitations/${encodeURIComponent(key)}`;

  // quiet：只更新按钮可用性，不覆盖刚写入的收取/签发结果提示。
  const updateCollectGate = ({ quiet = false } = {}) => {
    const gate = collectGate(currentKey(), $("#inv-collect-ack").checked);
    $("#inv-collect").disabled = !gate.allowed;
    if (quiet) return;
    if (!gate.allowed) $("#inv-delivery-status").textContent = gate.reason;
    else if ($("#inv-delivery-status").textContent.startsWith("请先")) $("#inv-delivery-status").textContent = "";
  };

  function showLink(url) {
    $("#inv-link").value = url;
    $("#inv-link-box").hidden = false;
  }

  function clearLink() {
    $("#inv-link").value = "";
    $("#inv-link-box").hidden = true;
  }

  function showStatus(result, body) {
    $("#inv-status-summary").innerHTML = renderInvitationSummaryHtml(escapeHtml, body);
    $("#inv-status-raw").innerHTML = verbatim(escapeHtml, result);
    state.subject = body?.user?.id || null;
    $("#inv-subject-actions").hidden = !state.subject || typeof onUseSubject !== "function";
  }

  function stopPolling(message = "") {
    state.pollToken += 1;
    $("#inv-poll-stop").hidden = true;
    $("#inv-poll-status").textContent = message;
  }

  async function startPolling(key) {
    state.pollToken += 1;
    const token = state.pollToken;
    $("#inv-poll-stop").hidden = false;
    $("#inv-poll-status").textContent = "开通进行中，自动轮询……";
    const outcome = await pollInvitation({
      fetchStatus: () => fetchRaw(keyPath(key)),
      sleep,
      isCancelled: () => token !== state.pollToken,
      onUpdate: ({ result, body, attempts }) => {
        if (token !== state.pollToken) return;
        showStatus(result, body);
        $("#inv-poll-status").textContent = `开通进行中，自动轮询第 ${attempts}/${POLL_MAX_ATTEMPTS} 次……`;
      },
    });
    if (token !== state.pollToken) return;
    const messages = {
      settled: outcome.body?.status === "completed" ? "开通已完成。" : `开通结束：${outcome.body?.status ?? "未知"}`,
      error: "查询失败，见原始响应；可手动刷新。",
      exhausted: "已达自动轮询上限，任务可能仍在进行，请手动刷新状态。",
    };
    stopPolling(messages[outcome.reason] || "");
  }

  async function queryStatus(key) {
    stopPolling("查询中……");
    const result = await fetchRaw(keyPath(key));
    const body = result.ok ? parseJson(result) : null;
    showStatus(result, body);
    $("#inv-poll-status").textContent = "";
    if (body && isProcessing(body)) void startPolling(key);
  }

  async function loadTokenStatus() {
    if (!isSignedIn()) return;
    $("#inv-token-status").textContent = "加载中……";
    const result = await fetchRaw("/ops/idp-provision-token/status");
    const body = result.ok ? parseJson(result) : null;
    $("#inv-token-status").textContent = "";
    $("#inv-token-summary").innerHTML = renderProvisionStatusHtml(escapeHtml, body);
    $("#inv-token-raw").innerHTML = verbatim(escapeHtml, result);
  }

  $("#inv-gen-key").addEventListener("click", () => {
    form.elements.namedItem("idempotencyKey").value = generateIdempotencyKey();
  });

  $("#inv-use-trial").addEventListener("click", () => {
    form.elements.namedItem("planKey").value = TRIAL_PLAN_KEY;
    form.elements.namedItem("quotaPlanRevisionId").value = TRIAL_QUOTA_REVISION;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const built = buildInvitationPayload(formFields(form));
    if (built.error) { $("#inv-submit-status").textContent = built.error; return; }
    const key = built.payload.idempotencyKey;
    $("#inv-submit").disabled = true;
    $("#inv-submit-status").textContent = "开通中（最长约 60 秒同步窗口）……";
    stopPolling("");
    clearLink();
    const result = await fetchRaw("/ops/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(built.payload),
    });
    $("#inv-submit").disabled = false;
    const body = parseJson(result);
    const url = result.ok ? extractActivationUrl(body) : null;
    $("#inv-submit-status").textContent = result.status === 202
      ? "已受理（202），任务在后台继续，正在轮询。"
      : result.ok ? "" : "开通请求被拒绝，见原始响应。";
    $("#inv-submit-result").innerHTML = verbatim(escapeHtml, result, url);
    if (url) {
      showLink(url);
      $("#inv-delivery-status").textContent = "激活链接已随本次响应一次性下发（服务端已标记为已收取），请立即复制转交。";
    }
    if (result.ok && body) {
      queryForm.elements.namedItem("idempotencyKey").value = key;
      showStatus({ ...result, text: redactActivationUrl(result.text, url) }, body);
      updateCollectGate({ quiet: Boolean(url) });
      if (isProcessing(body)) void startPolling(key);
    }
  });

  queryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const key = currentKey();
    if (!validIdempotencyKey(key)) { $("#inv-poll-status").textContent = "幂等键须为 8–200 个字符"; return; }
    void queryStatus(key);
  });
  queryForm.elements.namedItem("idempotencyKey").addEventListener("input", () => updateCollectGate());
  $("#inv-poll-stop").addEventListener("click", () => stopPolling("已停止自动轮询，可手动刷新。"));

  $("#inv-use-subject").addEventListener("click", () => {
    if (state.subject && typeof onUseSubject === "function") onUseSubject(state.subject);
  });

  $("#inv-collect-ack").addEventListener("change", () => updateCollectGate());
  $("#inv-collect").addEventListener("click", async () => {
    const key = currentKey();
    const gate = collectGate(key, $("#inv-collect-ack").checked);
    if (!gate.allowed) { $("#inv-delivery-status").textContent = gate.reason; return; }
    $("#inv-collect").disabled = true;
    $("#inv-collect-ack").checked = false;
    $("#inv-delivery-status").textContent = "收取中……";
    const result = await fetchRaw(`${keyPath(key)}/collect-delivery`, { method: "POST" });
    const body = result.ok ? parseJson(result) : null;
    const url = extractActivationUrl(body);
    $("#inv-delivery-result").innerHTML = `${renderInvitationSummaryHtml(escapeHtml, body)}${verbatim(escapeHtml, result, url)}`;
    if (url) {
      showLink(url);
      $("#inv-delivery-status").textContent = "已收取。链接不会再次返回，请立即复制转交。";
    } else if (body?.status === "processing") {
      $("#inv-delivery-status").textContent = "开通仍在进行，暂无可收取链接；请先轮询至完成。";
    } else if (body) {
      $("#inv-delivery-status").textContent = body.deliveredAt ? `链接已于 ${body.deliveredAt} 被收取过；需要新链接请「重新签发」。` : "没有可收取的激活链接。";
    } else {
      $("#inv-delivery-status").textContent = "收取失败，见原始响应。";
    }
    updateCollectGate({ quiet: true });
  });

  $("#inv-resend").addEventListener("click", async () => {
    const key = currentKey();
    if (!validIdempotencyKey(key)) { $("#inv-delivery-status").textContent = "请先填写或查询幂等键"; return; }
    $("#inv-resend").disabled = true;
    $("#inv-delivery-status").textContent = "重新签发中……";
    const result = await fetchRaw(`${keyPath(key)}/resend`, { method: "POST" });
    $("#inv-resend").disabled = false;
    const body = result.ok ? parseJson(result) : null;
    $("#inv-delivery-result").innerHTML = `${renderInvitationSummaryHtml(escapeHtml, body)}${verbatim(escapeHtml, result)}`;
    $("#inv-delivery-status").textContent = body?.delivery?.pendingCollect
      ? "新激活链接已暂存：勾选确认后点「收取激活链接」一次性取回（IdP 已作废旧链接）。"
      : result.ok ? "未签发新链接，见说明。" : "重新签发被拒绝，见原始响应。";
  });

  $("#inv-link-copy").addEventListener("click", async () => {
    const value = $("#inv-link").value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      $("#inv-delivery-status").textContent = "已复制到剪贴板。";
    } catch {
      $("#inv-link").select();
      $("#inv-delivery-status").textContent = "无法写剪贴板，已选中链接，请手动复制。";
    }
  });
  $("#inv-link-clear").addEventListener("click", clearLink);

  $("#inv-token-refresh").addEventListener("click", () => void loadTokenStatus());

  rotateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const tokenInput = rotateForm.elements.namedItem("token");
    const ackInput = rotateForm.elements.namedItem("ack");
    const token = tokenInput.value.trim();
    const gate = rotateGate(token, ackInput.checked);
    // 无论是否放行都立即清空明文输入。
    tokenInput.value = "";
    ackInput.checked = false;
    if (!gate.allowed) { $("#inv-rotate-status").textContent = `${gate.reason}（已清空输入）`; return; }
    $("#inv-rotate").disabled = true;
    $("#inv-rotate-status").textContent = "向 IdP 探测并轮换中……";
    const result = await fetchRaw("/ops/idp-provision-token/rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    $("#inv-rotate").disabled = false;
    $("#inv-rotate-status").textContent = result.ok ? "已轮换。" : "轮换被拒绝，见原始响应。";
    $("#inv-rotate-result").innerHTML = verbatim(escapeHtml, result);
    if (result.ok) void loadTokenStatus();
  });

  updateCollectGate();
  return { loadTokenStatus, stopPolling };
}
