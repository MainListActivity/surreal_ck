// 「测试账号」：登记到期测试主体、预检后果、代开测试工作区。
// 复用控制台既有运营 token（由 main.js 注入 fetcher），不新建 OIDC client、不读取 token 内容。
// 所有服务端结果/错误按 HTTP 状态 + 原始响应体逐字显示。

export const DEFAULT_TEST_TTL_DAYS = 30;
export const MAX_TEST_TTL_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;

function pad(value) {
  return String(value).padStart(2, "0");
}

/** datetime-local 输入值（本地时区，分钟精度）。 */
export function toLocalInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function defaultExpiryInput(now = new Date()) {
  return toLocalInputValue(new Date(now.getTime() + DEFAULT_TEST_TTL_DAYS * DAY_MS));
}

export function maxExpiryInput(now = new Date()) {
  return toLocalInputValue(new Date(now.getTime() + MAX_TEST_TTL_DAYS * DAY_MS - 60_000));
}

/** 把 datetime-local 值转成 ISO；超出 (now, now+31d] 返回错误文本。 */
export function expiryToIso(value, now = new Date()) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return { error: "到期时间无效" };
  if (ms <= now.getTime()) return { error: "到期时间必须晚于现在" };
  if (ms > now.getTime() + MAX_TEST_TTL_DAYS * DAY_MS) return { error: `到期时间最多 ${MAX_TEST_TTL_DAYS} 天后` };
  return { iso: new Date(ms).toISOString() };
}

export function validSlug(slug) {
  return SLUG_RE.test(String(slug || ""));
}

/**
 * 是否允许点击「登记」：必须已对同一 subject 做过预检、没有硬拒绝，
 * 需要确认时确认短语逐字一致。服务端会重新计算并同样拒绝。
 */
export function registrationGate(preflight, subject, confirmText) {
  if (!preflight || preflight.subject !== subject) return { allowed: false, reason: "请先对该 subject 运行预检" };
  if ((preflight.blockers || []).length > 0) return { allowed: false, reason: "预检存在硬拒绝，不能登记" };
  if (preflight.requiresConfirmation && confirmText !== preflight.confirmationPhrase) {
    return { allowed: false, reason: `需逐字填写确认短语：${preflight.confirmationPhrase}` };
  }
  return { allowed: true, reason: "" };
}

function verbatim(escapeHtml, result) {
  return `<pre class="raw-result ${result.ok ? "" : "error"}">HTTP ${escapeHtml(result.status)}\n${escapeHtml(result.text)}</pre>`;
}

function yesNo(value) {
  return value ? "是" : "否";
}

export function renderPreflightHtml(escapeHtml, preflight) {
  const workspaces = preflight.workspaces || [];
  const rows = workspaces.length === 0
    ? `<tr><td colspan="7" class="muted">该 subject 当前没有任何工作区成员关系。</td></tr>`
    : workspaces.map((ws) => `<tr class="${ws.newlyMarked ? "warn-row" : ""}">
        <td>${escapeHtml(ws.slug || ws.id)}<br><span class="muted">${escapeHtml(ws.name || "")}</span></td>
        <td>${escapeHtml(ws.role || (ws.isOwner ? "owner（无索引）" : "—"))}${ws.isOwner ? " · owner" : ""}</td>
        <td>${escapeHtml(ws.memberCount)}</td>
        <td>${yesNo(ws.wouldBeMarked)}${ws.newlyMarked ? "（新标记）" : ""}</td>
        <td>${escapeHtml(ws.testExpiresAt || "—")}</td>
        <td>${yesNo(ws.membershipRemovedOnExpiry)}</td>
      </tr>`).join("");
  const blockers = (preflight.blockers || []).map((b) => `<li class="error">${escapeHtml(b.code)}：${escapeHtml(b.message)}</li>`).join("");
  const warnings = (preflight.warnings || []).map((w) => `<li class="warning">${escapeHtml(w)}</li>`).join("");
  const operator = preflight.platformOperator
    ? `${escapeHtml(preflight.platformOperator.kind || "?")} / ${escapeHtml(preflight.platformOperator.status || "?")}`
    : "否";
  const testSubject = preflight.testSubject
    ? `已登记，到期 ${escapeHtml(preflight.testSubject.expiresAt || "?")}${preflight.testSubject.email ? ` · ${escapeHtml(preflight.testSubject.email)}` : ""}`
    : "未登记";
  return `
    <dl class="preflight-meta">
      <dt>subject</dt><dd><code>${escapeHtml(preflight.subject)}</code></dd>
      <dt>测试主体</dt><dd>${testSubject}</dd>
      <dt>平台运营主体</dt><dd>${operator}</dd>
      <dt>个人计费账户</dt><dd>${preflight.personalBillingAccount?.exists ? `存在（${escapeHtml(preflight.personalBillingAccount.subscriptionCount)} 个订阅）` : "无"}</dd>
    </dl>
    <table class="preflight-table">
      <thead><tr><th>工作区</th><th>角色</th><th>成员数</th><th>登记后标记到期删除</th><th>现有 test_expires_at</th><th>到期删除成员索引</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${blockers ? `<p><strong>硬拒绝（不可确认绕过）</strong></p><ul>${blockers}</ul>` : ""}
    ${warnings ? `<p><strong>需确认的后果</strong></p><ul>${warnings}</ul>` : ""}
    ${!blockers && !warnings ? `<p class="status-accepted">无硬拒绝、无需确认的后果。</p>` : ""}
    ${preflight.requiresConfirmation ? `<p>确认短语：<code>${escapeHtml(preflight.confirmationPhrase)}</code></p>` : ""}`;
}

export function testAccountsMarkup() {
  return `
      <main id="testaccounts-view" class="activation-layout" hidden>
        <section class="panel activation-panel">
          <div class="panel-heading"><div><h2>测试主体</h2><p class="muted activation-help">需要 test.manage 能力。到期后由清理任务删除单成员测试工作区及该主体的成员索引、个人计费账户。</p></div><button id="ta-refresh" class="ghost">刷新</button></div>
          <div id="ta-list" class="activation-list"><div class="empty-state">登录后加载。</div></div>
          <div id="ta-list-raw"></div>
          <form id="ta-lookup-form" class="source-form">
            <label class="wide">按邮箱查找 subject（只读，查工作区成员索引与测试主体登记）<input name="email" type="email" required placeholder="member@example.com" autocomplete="off" /></label>
            <div class="form-actions wide"><button type="submit">查找</button></div>
          </form>
          <div id="ta-lookup-result"></div>
        </section>
        <section class="panel activation-panel">
          <div class="panel-heading"><div><h2>登记测试主体</h2><p class="muted activation-help">先预检；有硬拒绝时不能登记，有需确认的后果时必须逐字填写确认短语。</p></div></div>
          <form id="ta-register-form" class="source-form">
            <label class="wide">Subject<input name="subject" required maxlength="256" placeholder="OIDC sub（UUID）" autocomplete="off" /></label>
            <label>邮箱（可选）<input name="email" type="email" autocomplete="off" /></label>
            <label>到期时间（默认 30 天，最长 31 天）<input name="expiresAt" type="datetime-local" required /></label>
            <label class="wide">来源备注 origin（可选）<input name="origin" maxlength="128" placeholder="native-chat-test" /></label>
            <div class="form-actions wide"><button type="button" id="ta-preflight">预检</button><span id="ta-preflight-status" class="status muted"></span></div>
            <div id="ta-preflight-result" class="wide"></div>
            <label class="wide" id="ta-confirm-label" hidden>确认短语<input name="confirm" autocomplete="off" /></label>
            <div class="form-actions wide"><button type="submit" id="ta-register" disabled>登记测试主体</button><span id="ta-register-status" class="status muted"></span></div>
          </form>
          <div id="ta-register-result"></div>
        </section>
        <section class="panel activation-panel">
          <div class="panel-heading"><div><h2>新建测试工作区</h2><p class="muted activation-help">为未到期测试主体代开工作区（trial 容量），继承该主体的到期时间。同 subject 同 slug 重复提交返回已有工作区。</p></div></div>
          <form id="ta-workspace-form" class="source-form">
            <label class="wide">Subject<input name="subject" required maxlength="256" autocomplete="off" /></label>
            <label>工作区 slug<input name="slug" required maxlength="40" placeholder="member-chat-test" autocomplete="off" /></label>
            <label>工作区名称<input name="name" required maxlength="80" /></label>
            <div class="form-actions wide"><button type="submit">新建测试工作区</button><span id="ta-workspace-status" class="status muted"></span></div>
          </form>
          <div id="ta-workspace-result"></div>
        </section>
      </main>`;
}

/**
 * 绑定事件。fetchRaw(path, options) 由 main.js 提供：带当前运营 token 请求
 * `${apiBase}${path}`，返回 { ok, status, text }（不抛出 HTTP 错误）。
 */
export function setupTestAccounts({ fetchRaw, escapeHtml, isSignedIn }) {
  const $ = (selector) => document.querySelector(selector);
  const state = { preflight: null };
  const register = $("#ta-register-form");
  const expiresInput = register.elements.namedItem("expiresAt");
  expiresInput.value = defaultExpiryInput();
  expiresInput.max = maxExpiryInput();

  const parse = (result) => {
    try { return JSON.parse(result.text); } catch { return null; }
  };

  const updateGate = () => {
    const subject = register.elements.namedItem("subject").value.trim();
    const confirm = register.elements.namedItem("confirm").value;
    const gate = registrationGate(state.preflight, subject, confirm);
    $("#ta-register").disabled = !gate.allowed;
    $("#ta-register-status").textContent = gate.reason;
  };

  async function loadList() {
    if (!isSignedIn()) return;
    const result = await fetchRaw("/ops/test-subjects");
    const body = result.ok ? parse(result) : null;
    if (!body) {
      $("#ta-list").innerHTML = "";
      $("#ta-list-raw").innerHTML = verbatim(escapeHtml, result);
      return;
    }
    $("#ta-list-raw").innerHTML = "";
    const subjects = body.subjects || [];
    $("#ta-list").innerHTML = subjects.length === 0
      ? `<div class="empty-state">暂无测试主体。</div>`
      : subjects.map((s) => `<div class="activation-row"><strong><code>${escapeHtml(s.subject)}</code></strong>
          <span class="muted">${escapeHtml(s.email || "无邮箱")} · 到期 ${escapeHtml(s.expiresAt)}${s.expired ? "（已到期）" : ""} · ${escapeHtml(s.origin || "无来源")}</span>
          <span class="muted">工作区：${escapeHtml((s.workspaces || []).join(", ") || "无")}</span>
          <span><button type="button" class="ghost ta-use" data-subject="${escapeHtml(s.subject)}">填入表单</button></span></div>`).join("");
    bindUseButtons($("#ta-list"));
  }

  function useSubject(subject) {
    register.elements.namedItem("subject").value = subject;
    $("#ta-workspace-form").elements.namedItem("subject").value = subject;
    state.preflight = null;
    $("#ta-preflight-result").innerHTML = "";
    $("#ta-confirm-label").hidden = true;
    updateGate();
  }

  function bindUseButtons(container) {
    container.querySelectorAll(".ta-use").forEach((button) => button.addEventListener("click", () => useSubject(button.dataset.subject)));
  }

  $("#ta-refresh").addEventListener("click", () => void loadList());

  $("#ta-lookup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    const result = await fetchRaw(`/ops/test-subjects/lookup?email=${encodeURIComponent(String(email || "").trim())}`);
    const body = result.ok ? parse(result) : null;
    const matches = body?.subjects || [];
    $("#ta-lookup-result").innerHTML = `${matches.map((m) => `<div class="activation-row"><strong><code>${escapeHtml(m.subject)}</code></strong>
        <span class="muted">${escapeHtml(m.emails.join(", "))}${m.testSubject ? " · 已是测试主体" : ""}</span>
        <span class="muted">${escapeHtml(m.workspaces.map((w) => `${w.slug || "?"}（${w.role || "?"}）`).join(", ") || "无工作区")}</span>
        <span><button type="button" class="ghost ta-use" data-subject="${escapeHtml(m.subject)}">填入表单</button></span></div>`).join("")}${verbatim(escapeHtml, result)}`;
    bindUseButtons($("#ta-lookup-result"));
  });

  register.elements.namedItem("subject").addEventListener("input", () => {
    state.preflight = null;
    $("#ta-preflight-result").innerHTML = "";
    $("#ta-confirm-label").hidden = true;
    updateGate();
  });
  register.elements.namedItem("confirm").addEventListener("input", updateGate);

  $("#ta-preflight").addEventListener("click", async () => {
    const subject = register.elements.namedItem("subject").value.trim();
    if (!subject) { $("#ta-preflight-status").textContent = "请填写 subject"; return; }
    $("#ta-preflight-status").textContent = "预检中……";
    state.preflight = null;
    const result = await fetchRaw(`/ops/test-subjects/${encodeURIComponent(subject)}/preflight`);
    const body = result.ok ? parse(result) : null;
    $("#ta-preflight-status").textContent = "";
    if (!body) {
      $("#ta-preflight-result").innerHTML = verbatim(escapeHtml, result);
    } else {
      state.preflight = body;
      $("#ta-preflight-result").innerHTML = renderPreflightHtml(escapeHtml, body);
      $("#ta-confirm-label").hidden = !body.requiresConfirmation;
    }
    updateGate();
  });

  register.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = new FormData(register);
    const subject = String(fields.get("subject") || "").trim();
    const gate = registrationGate(state.preflight, subject, String(fields.get("confirm") || ""));
    if (!gate.allowed) { $("#ta-register-status").textContent = gate.reason; return; }
    const expiry = expiryToIso(fields.get("expiresAt"));
    if (expiry.error) { $("#ta-register-status").textContent = expiry.error; return; }
    const payload = { expiresAt: expiry.iso };
    const email = String(fields.get("email") || "").trim();
    const origin = String(fields.get("origin") || "").trim();
    if (email) payload.email = email;
    if (origin) payload.origin = origin;
    if (state.preflight.requiresConfirmation) payload.confirm = String(fields.get("confirm") || "");
    $("#ta-register").disabled = true;
    const result = await fetchRaw(`/ops/test-subjects/${encodeURIComponent(subject)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("#ta-register-result").innerHTML = verbatim(escapeHtml, result);
    state.preflight = null;
    updateGate();
    if (result.ok) {
      $("#ta-workspace-form").elements.namedItem("subject").value = subject;
      void loadList();
    }
  });

  $("#ta-workspace-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const subject = String(fields.get("subject") || "").trim();
    const slug = String(fields.get("slug") || "").trim();
    const name = String(fields.get("name") || "").trim();
    if (!validSlug(slug)) { $("#ta-workspace-status").textContent = "slug 须为小写字母/数字/连字符，2–40 位，首尾非连字符"; return; }
    $("#ta-workspace-status").textContent = "创建中……";
    const result = await fetchRaw(`/ops/test-subjects/${encodeURIComponent(subject)}/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, name }),
    });
    $("#ta-workspace-status").textContent = "";
    $("#ta-workspace-result").innerHTML = verbatim(escapeHtml, result);
    if (result.ok) void loadList();
  });

  updateGate();
  return { loadList, useSubject };
}
