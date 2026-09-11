import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import "./style.css";

const config = {
  issuer: import.meta.env.VITE_OPS_OIDC_ISSUER || "",
  clientId: import.meta.env.VITE_OPS_OIDC_CLIENT_ID || "",
  audience: import.meta.env.VITE_OPS_OIDC_AUDIENCE || "",
  apiBase: import.meta.env.VITE_OPS_API_BASE_URL || "/api",
};

const app = document.querySelector("#app");
let userManager;
let user = null;
let selectedWorkspace = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setupUserManager() {
  if (!config.issuer || !config.clientId) return null;
  return new UserManager({
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: `${window.location.origin}/auth/callback.html`,
    post_logout_redirect_uri: window.location.origin,
    response_type: "code",
    scope: "openid",
    filterProtocolClaims: true,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    extraQueryParams: config.audience ? { resource: config.audience } : undefined,
  });
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
      <main class="layout">
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
      <footer class="footer muted">运营访问使用独立 OIDC audience；工作区成员和客户 token 不会获得此控制面。</footer>
    </div>`;
  document.querySelector("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void search(document.querySelector("#search-input").value);
  });
  document.querySelector("#refresh").addEventListener("click", () => void search(document.querySelector("#search-input").value));
}

function renderAuth() {
  const slot = document.querySelector("#auth-slot");
  if (user) {
    slot.innerHTML = `<div class="identity"><span>${escapeHtml(user.profile?.email || user.profile?.sub || "运营账号")}</span><button id="logout" class="ghost">退出</button></div>`;
    document.querySelector("#logout").addEventListener("click", () => void userManager?.signoutRedirect());
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

async function init() {
  renderShell();
  userManager = setupUserManager();
  if (userManager) {
    user = await userManager.getUser();
    if (user?.expired) user = null;
  }
  renderAuth();
  if (user) await search();
}

void init();
