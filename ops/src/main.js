import "./style.css";
import { authConfig as config, createOpsUserManager } from "./auth.js";

const app = document.querySelector("#app");
let userManager;
let user = null;
let selectedWorkspace = null;
let activeView = "quota";
const contentState = {
  sources: [],
  batches: [],
  batchesCursor: null,
  audit: [],
  auditCursor: null,
  selectedBatch: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setupUserManager() {
  return createOpsUserManager();
}

function renderShell() {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">SURREAL CK / PLATFORM OPS</p>
          <h1>运营控制台</h1>
          <p class="muted">统一查看工作区、订阅配额和平台内容维护状态。</p>
        </div>
        <div id="auth-slot"></div>
      </header>
      <nav class="section-tabs" aria-label="运营模块">
        <button class="section-tab active" data-view="quota">配额运营</button>
        <button class="section-tab" data-view="content">内容维护</button>
      </nav>
      <main id="quota-view" class="layout">
        <section class="panel search-panel">
          <div class="panel-heading"><h2>工作区目录</h2><button id="refresh" class="ghost">刷新</button></div>
          <form id="search-form" class="search-form">
            <input id="search-input" type="search" placeholder="搜索工作区、账单账户或运营主体" autocomplete="off" />
            <button type="submit">搜索</button>
          </form>
          <div id="search-status" class="status muted">登录后加载工作区。</div>
          <div id="results" class="results"></div>
        </section>
        <section class="panel detail-panel">
          <div class="panel-heading"><h2>工作区详情</h2><span id="detail-badge" class="badge">未选择</span></div>
          <div id="detail" class="empty-state">从左侧选择一个工作区查看计划、资源使用和操作时间线。</div>
        </section>
      </main>
      <main id="content-view" class="content-layout" hidden>
        <section class="panel content-panel">
          <div class="panel-heading"><h2>来源登记与许可</h2><button id="content-refresh" class="ghost">刷新</button></div>
          <p class="muted content-help">来源的许可修订独立留痕；采集包不能自行改变许可。保存新许可会产生下一版修订。</p>
          <form id="source-form" class="source-form">
            <label>来源标识<input name="sourceKey" required maxlength="256" placeholder="司法公开网.cn" /></label>
            <label>显示名称<input name="label" required maxlength="512" placeholder="最高人民法院公开文书" /></label>
            <label>辖区<input name="jurisdiction" maxlength="128" placeholder="中国大陆" /></label>
            <label>基础 URL<input name="baseUrl" type="url" required placeholder="https://example.gov.cn" /></label>
            <label>状态<select name="status"><option value="active">active · 可采集</option><option value="inactive">inactive · 暂停</option></select></label>
            <label>来源动作<input name="allowedActions" value="submit,publish" required placeholder="submit,publish" /></label>
            <label>许可类型<input name="licenseKind" value="public" required maxlength="128" /></label>
            <label>许可生效时间<input name="effectiveFrom" type="datetime-local" required /></label>
            <label>许可动作<input name="licenseAllowedActions" value="submit,publish" required placeholder="submit,publish" /></label>
            <label>许可证据 URL<input name="evidenceUrl" type="url" placeholder="https://example.gov.cn/license" /></label>
            <label class="wide">许可说明<textarea name="evidenceText" maxlength="4096" rows="2" placeholder="记录许可范围、转载条件和核验备注"></textarea></label>
            <div class="form-actions wide"><button type="submit">登记 / 修订来源</button><span id="source-status" class="status muted"></span></div>
          </form>
          <div id="source-list" class="source-list"></div>
        </section>
        <section class="panel content-panel">
          <div class="panel-heading"><h2>成品批次</h2><div class="heading-actions"><select id="batch-filter"><option value="">全部状态</option><option value="ready">ready</option><option value="partially_validated">部分通过</option><option value="rejected">rejected</option><option value="published">published</option></select><button id="batch-refresh" class="ghost">刷新</button></div></div>
          <div id="batch-status" class="status muted"></div>
          <div id="batch-list" class="batch-list"></div>
          <button id="batch-next" class="ghost more-button" hidden>加载更多批次</button>
          <div class="subpanel-heading"><h3>批次详情</h3><span id="batch-detail-status" class="muted">选择左侧批次</span></div>
          <div id="batch-detail" class="batch-detail empty-state">批次详情会显示校验结果、来源许可快照和失败原因。</div>
        </section>
        <section class="panel content-panel audit-panel">
          <div class="panel-heading"><h2>审计查询</h2><button id="audit-refresh" class="ghost">刷新</button></div>
          <form id="audit-form" class="search-form"><input id="audit-kind" placeholder="事件类型（可选）" /><input id="audit-batch" placeholder="批次 ID（可选）" /><button type="submit">查询</button></form>
          <div id="audit-status" class="status muted"></div>
          <ul id="audit-list" class="audit-list"></ul>
          <button id="audit-next" class="ghost more-button" hidden>加载更多审计</button>
        </section>
      </main>
      <footer class="footer muted">运营访问使用独立 OIDC audience；工作区成员和客户 token 不会获得此控制面。</footer>
    </div>`;
  document.querySelector("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void search(document.querySelector("#search-input").value);
  });
  document.querySelector("#refresh").addEventListener("click", () => void search(document.querySelector("#search-input").value));
  document.querySelectorAll(".section-tab").forEach((button) => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view === "content" ? "content" : "quota";
      document.querySelectorAll(".section-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
      document.querySelector("#quota-view").hidden = activeView !== "quota";
      document.querySelector("#content-view").hidden = activeView !== "content";
      if (activeView === "content" && user) void loadContent();
    });
  });
  document.querySelector("#content-refresh").addEventListener("click", () => void loadContent());
  document.querySelector("#batch-refresh").addEventListener("click", () => void loadBatches());
  document.querySelector("#batch-filter").addEventListener("change", () => void loadBatches());
  document.querySelector("#batch-next").addEventListener("click", () => void loadBatches(true));
  document.querySelector("#audit-refresh").addEventListener("click", () => void loadAudit());
  document.querySelector("#audit-next").addEventListener("click", () => void loadAudit(true));
  document.querySelector("#audit-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void loadAudit();
  });
  document.querySelector("#source-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void registerSource(new FormData(event.currentTarget));
  });
}

function renderAuth() {
  const slot = document.querySelector("#auth-slot");
  if (user) {
    slot.innerHTML = `<div class="identity"><span>${escapeHtml(user.profile?.email || user.profile?.sub || "运营账号")}</span><button id="logout" class="ghost">退出</button></div>`;
    document.querySelector("#logout").addEventListener("click", () => void userManager?.removeUser().then(() => window.location.replace("/")));
    return;
  }
  const label = config.issuer && config.clientId ? "运营登录" : "未配置 OIDC";
  slot.innerHTML = `<button id="login" class="primary" ${config.issuer && config.clientId ? "" : "disabled"}>${label}</button>`;
  document.querySelector("#login").addEventListener("click", () => void userManager?.signinRedirect());
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (user?.access_token) headers.set("authorization", `Bearer ${user.access_token}`);
  headers.set("accept", "application/json");
  const response = await fetch(`${config.apiBase}${path}`, { ...options, headers });
  if (!response.ok) {
    let detail = "请求失败";
    try {
      const body = await response.json();
      detail = body?.error?.message || body?.error?.code || detail;
    } catch {
      // 保留通用错误。
    }
    throw new Error(`${response.status}: ${detail}`);
  }
  return response.json();
}

function renderResults(results) {
  const container = document.querySelector("#results");
  if (!results.length) {
    container.innerHTML = `<div class="empty-state">没有找到匹配项。</div>`;
    return;
  }
  container.innerHTML = results.map((result, index) => {
    const isWorkspace = result.kind === "workspace";
    const title = isWorkspace ? result.workspace.name : result.kind === "billing_account" ? result.billing_account.name : result.subject;
    const subtitle = isWorkspace
      ? `${result.workspace.slug} · ${result.applied_plan_name || "无 applied 计划"}`
      : result.kind === "billing_account"
        ? `${result.billing_account.account_key} · ${result.workspace_count} 个工作区`
        : `${result.workspace_slugs?.length || 0} 个工作区`;
    const slug = isWorkspace ? result.workspace.slug : result.workspace_slugs?.[0];
    return `<button class="result" data-index="${index}" data-slug="${escapeHtml(slug || "")}">
      <span class="result-kind">${escapeHtml(result.kind)}</span><strong>${escapeHtml(title)}</strong><span class="muted">${escapeHtml(subtitle)}</span>
    </button>`;
  }).join("");
  container.querySelectorAll(".result").forEach((button) => {
    button.addEventListener("click", () => {
      const slug = button.dataset.slug;
      if (slug) void loadWorkspace(slug);
    });
  });
}

async function search(query = "") {
  const status = document.querySelector("#search-status");
  status.textContent = "正在查询……";
  status.className = "status muted";
  try {
    const result = await api(`/ops/quota/search?q=${encodeURIComponent(query.trim())}&limit=100`);
    renderResults(result.results || []);
    status.textContent = `共 ${result.results?.length || 0} 个结果`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "查询失败";
    status.className = "status error";
    renderResults([]);
  }
}

function valueOrDash(value) {
  return value === null || value === undefined || value === "" ? "—" : escapeHtml(value);
}

function renderDetail(view, timeline) {
  selectedWorkspace = view;
  document.querySelector("#detail-badge").textContent = view.workspace.slug;
  const resources = (view.resources || []).map((resource) => `
    <div class="resource-row"><span>${escapeHtml(resource.label || resource.resource || "资源")}</span><strong>${valueOrDash(resource.used)} / ${valueOrDash(resource.limit)}</strong></div>`).join("");
  const events = (timeline?.items || []).slice(0, 8).map((item) => `
    <li><time>${valueOrDash(item.occurred_at || item.created_at)}</time><span>${escapeHtml(item.event_kind || item.kind || "操作")}</span></li>`).join("");
  document.querySelector("#detail").innerHTML = `
    <div class="detail-head"><div><p class="eyebrow">${escapeHtml(view.workspace.slug)}</p><h3>${escapeHtml(view.workspace.name)}</h3></div><span class="badge">${escapeHtml(view.view)}</span></div>
    <div class="metric-grid"><div><span class="muted">当前计划</span><strong>${valueOrDash(view.operator?.applied_plan_name)}</strong></div><div><span class="muted">配额状态</span><strong>${valueOrDash(view.statuses?.[0]?.capacity_state || "normal")}</strong></div><div><span class="muted">工作区 ID</span><strong class="mono">${valueOrDash(view.operator?.workspace_record)}</strong></div></div>
    <h4>资源使用</h4><div class="resource-list">${resources || `<div class="empty-state">暂无资源观测。</div>`}</div>
    <h4>最近操作</h4><ul class="timeline">${events || `<li class="muted">暂无时间线。</li>`}</ul>`;
}

async function loadWorkspace(slug) {
  const detail = document.querySelector("#detail");
  detail.innerHTML = `<div class="loading">正在加载 ${escapeHtml(slug)}……</div>`;
  try {
    const [view, timeline] = await Promise.all([
      api(`/ops/quota/workspaces/${encodeURIComponent(slug)}`),
      api(`/ops/quota/workspaces/${encodeURIComponent(slug)}/timeline?limit=20`),
    ]);
    renderDetail(view, timeline);
  } catch (error) {
    detail.innerHTML = `<div class="empty-state error">${escapeHtml(error instanceof Error ? error.message : "加载失败")}</div>`;
  }
}

function commaValues(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderSources() {
  const container = document.querySelector("#source-list");
  if (!contentState.sources.length) {
    container.innerHTML = `<div class="empty-state compact">还没有登记来源。</div>`;
    return;
  }
  container.innerHTML = contentState.sources.map((source) => {
    const license = source.license;
    return `<article class="source-card">
      <div class="source-card-head"><div><strong>${escapeHtml(source.label)}</strong><span class="mono">${escapeHtml(source.sourceKey)}</span></div><span class="badge ${source.status === "active" ? "success" : "muted-badge"}">${escapeHtml(source.status)}</span></div>
      <div class="source-meta"><span>${escapeHtml(source.jurisdiction || "未指定辖区")}</span><span>${escapeHtml(source.baseUrl || "无基础 URL")}</span><span>来源动作：${escapeHtml((source.allowedActions || []).join(", ") || "—")}</span></div>
      <div class="license-line"><span>许可 ${license ? `v${escapeHtml(license.revision)} · ${escapeHtml(license.licenseKind)}` : "尚无修订"}</span><span>${escapeHtml(license?.effectiveFrom || "")}</span></div>
    </article>`;
  }).join("");
}

function renderBatches() {
  const container = document.querySelector("#batch-list");
  if (!contentState.batches.length) {
    container.innerHTML = `<div class="empty-state compact">没有匹配的批次。</div>`;
  } else {
    container.innerHTML = contentState.batches.map((batch) => `<button class="batch-row" data-batch-id="${escapeHtml(batch.batchId)}">
      <span class="batch-main"><strong>${escapeHtml(batch.batchId)}</strong><span class="muted">${escapeHtml(batch.actorSubject)} · ${escapeHtml(batch.receivedAt)}</span></span>
      <span class="batch-counts">${batch.entryCount} 项 · <em class="status-${escapeHtml(batch.status)}">${escapeHtml(batch.status)}</em><small>拒绝 ${batch.rejectedCount} · 已发布 ${batch.publishedCount}</small></span>
    </button>`).join("");
    container.querySelectorAll(".batch-row").forEach((row) => row.addEventListener("click", () => void loadBatchDetail(row.dataset.batchId)));
  }
  document.querySelector("#batch-next").hidden = !contentState.batchesCursor;
}

function renderBatchDetail(detail) {
  const batch = detail?.batch;
  const summary = detail?.summary;
  const container = document.querySelector("#batch-detail");
  if (!batch || !summary) {
    container.className = "batch-detail empty-state";
    container.textContent = "批次详情会显示校验结果、来源许可快照和失败原因。";
    return;
  }
  const payloadByKey = new Map((batch.request?.items || []).map((item) => [item.entryKey, item]));
  const entries = (batch.entries || []).map((entry) => {
    const requestEntry = payloadByKey.get(entry.entryKey);
    const title = requestEntry?.operation === "upsert" ? requestEntry.payload?.document?.title : `${requestEntry?.operation || "操作"} · ${requestEntry?.payload?.target?.itemId || ""}`;
    const sourceKey = requestEntry?.operation === "upsert" ? requestEntry.payload?.source?.sourceKey : "";
    const issues = (entry.issues || []).map((item) => `<li class="${item.retryable ? "warning" : "error"}">${escapeHtml(item.code)}：${escapeHtml(item.message)}</li>`).join("");
    return `<li class="entry-card"><div class="entry-head"><strong>${escapeHtml(entry.entryKey)}</strong><span class="status-${escapeHtml(entry.status)}">${escapeHtml(entry.status)}</span></div><div>${escapeHtml(title || "无标题")}</div><span class="muted">${escapeHtml(sourceKey)}</span>${issues ? `<ul class="entry-issues">${issues}</ul>` : ""}</li>`;
  }).join("");
  const licenses = Object.entries(batch.sourceLicenseSnapshot || {}).map(([key, license]) => `<li><span>${escapeHtml(key)}</span><span>v${escapeHtml(license.revision)} · ${escapeHtml(license.licenseKind)}</span></li>`).join("");
  container.className = "batch-detail";
  document.querySelector("#batch-detail-status").textContent = `${summary.entryCount} 项 · ${summary.status}`;
  container.innerHTML = `<div class="detail-grid"><div><span class="muted">提交 actor</span><strong>${escapeHtml(summary.actorSubject)}</strong></div><div><span class="muted">校验修订</span><strong>v${escapeHtml(summary.validationRevision)}</strong></div><div><span class="muted">请求摘要</span><strong class="mono">${escapeHtml(summary.requestDigest)}</strong></div></div>
    <h4>条目与失败原因</h4><ul class="entry-list">${entries || `<li class="muted">无条目</li>`}</ul>
    <h4>校验时许可快照</h4><ul class="license-snapshot">${licenses || `<li class="muted">该批次提交时来源尚无许可修订记录。</li>`}</ul>`;
}

function renderAudit() {
  const container = document.querySelector("#audit-list");
  if (!contentState.audit.length) {
    container.innerHTML = `<li class="empty-state compact">没有匹配的审计事件。</li>`;
  } else {
    container.innerHTML = contentState.audit.map((event) => `<li><div><strong>${escapeHtml(event.kind)}</strong><span class="muted">${escapeHtml(event.actorSubject)}</span></div><time>${escapeHtml(event.occurredAt)}</time><span>${escapeHtml(event.batchId || "来源/系统操作")}</span><code>${escapeHtml(JSON.stringify(event.details || {}))}</code></li>`).join("");
  }
  document.querySelector("#audit-next").hidden = !contentState.auditCursor;
}

async function loadContent() {
  const status = document.querySelector("#batch-status");
  status.textContent = "正在加载内容维护数据……";
  status.className = "status muted";
  try {
    const [contract, sources] = await Promise.all([
      api("/content/contract"),
      api("/content/sources"),
    ]);
    contentState.sources = sources || [];
    renderSources();
    await Promise.all([loadBatches(), loadAudit()]);
    status.textContent = `契约 v${contract.contractVersion} · ${contentState.sources.length} 个来源`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "内容维护数据加载失败";
    status.className = "status error";
    renderSources();
    renderBatches();
    renderAudit();
  }
}

async function registerSource(formData) {
  const status = document.querySelector("#source-status");
  status.textContent = "正在保存……";
  status.className = "status muted";
  const effectiveFrom = formData.get("effectiveFrom") || new Date().toISOString();
  try {
    const source = await api("/content/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceKey: formData.get("sourceKey"),
        label: formData.get("label"),
        jurisdiction: formData.get("jurisdiction") || null,
        baseUrl: formData.get("baseUrl"),
        status: formData.get("status"),
        allowedActions: commaValues(formData.get("allowedActions")),
        license: {
          licenseKind: formData.get("licenseKind"),
          allowedActions: commaValues(formData.get("licenseAllowedActions")),
          effectiveFrom: new Date(effectiveFrom).toISOString(),
          evidenceUrl: formData.get("evidenceUrl") || null,
          evidenceText: formData.get("evidenceText") || null,
        },
      }),
    });
    contentState.sources = [source, ...contentState.sources.filter((item) => item.sourceKey !== source.sourceKey)].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
    renderSources();
    status.textContent = `已保存 ${source.sourceKey} · 许可 v${source.license?.revision || "?"}`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "来源保存失败";
    status.className = "status error";
  }
}

async function loadBatches(append = false) {
  const filter = document.querySelector("#batch-filter").value;
  const cursor = append ? contentState.batchesCursor : null;
  try {
    const result = await api(`/content/batches?limit=25${filter ? `&status=${encodeURIComponent(filter)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    contentState.batches = append ? [...contentState.batches, ...(result.items || [])] : (result.items || []);
    contentState.batchesCursor = result.nextCursor || null;
    renderBatches();
    document.querySelector("#batch-status").textContent = `已加载 ${contentState.batches.length} 个批次`;
  } catch (error) {
    document.querySelector("#batch-status").textContent = error instanceof Error ? error.message : "批次加载失败";
    document.querySelector("#batch-status").className = "status error";
  }
}

async function loadBatchDetail(batchId) {
  if (!batchId) return;
  document.querySelector("#batch-detail-status").textContent = "正在加载……";
  try {
    const detail = await api(`/content/batches/${encodeURIComponent(batchId)}/detail`);
    contentState.selectedBatch = detail;
    renderBatchDetail(detail);
  } catch (error) {
    document.querySelector("#batch-detail").className = "batch-detail empty-state error";
    document.querySelector("#batch-detail").textContent = error instanceof Error ? error.message : "批次详情加载失败";
  }
}

async function loadAudit(append = false) {
  const kind = document.querySelector("#audit-kind").value.trim();
  const batchId = document.querySelector("#audit-batch").value.trim();
  const cursor = append ? contentState.auditCursor : null;
  const params = new URLSearchParams({ limit: "25" });
  if (kind) params.set("kind", kind);
  if (batchId) params.set("batchId", batchId);
  if (cursor) params.set("cursor", cursor);
  try {
    const result = await api(`/content/audit?${params}`);
    contentState.audit = append ? [...contentState.audit, ...(result.items || [])] : (result.items || []);
    contentState.auditCursor = result.nextCursor || null;
    renderAudit();
    document.querySelector("#audit-status").textContent = `已加载 ${contentState.audit.length} 条审计事件`;
  } catch (error) {
    document.querySelector("#audit-status").textContent = error instanceof Error ? error.message : "审计加载失败";
    document.querySelector("#audit-status").className = "status error";
  }
}

async function init() {
  renderShell();
  userManager = setupUserManager();
  if (userManager) {
    user = await userManager.getUser();
    if (user?.expired) user = null;
  }
  renderAuth();
  if (user) {
    await search();
    if (activeView === "content") await loadContent();
  }
}

void init();
