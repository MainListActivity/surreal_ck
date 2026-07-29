<script lang="ts">
  import { onMount } from "svelte";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import {
    Activity,
    AlertTriangle,
    ArrowLeft,
    Building2,
    CheckCircle2,
    ChevronRight,
    Clock3,
    Database,
    Gauge,
    History,
    RefreshCw,
    Search,
    Settings2,
    ShieldCheck,
    UserRound,
    X,
  } from "@lucide/svelte";
  import type {
    ControlPlaneObject,
    QuotaApiOperatorView,
    QuotaOperatorIntentKind,
    QuotaOperatorIntentStatusView,
    QuotaOpsContextView,
    QuotaOpsIntentPreflightView,
    QuotaOpsPlanRevision,
    QuotaOpsSearchResult,
    QuotaOpsTimelineView,
  } from "@surreal-ck/shared/native-quota";
  import {
    loadOperatorWorkspace,
    loadOpsContext,
    loadOpsTimeline,
    loadQuotaIntentStatus,
    preflightQuotaIntent,
    searchQuotaOps,
    submitQuotaIntent,
    type QuotaOpsIntentDraft,
  } from "../lib/quota/client";
  import {
    availableQuotaOpsActions,
    capacityPresentation,
    formatQuotaCount,
    formatQuotaDate,
    isIntentTerminal,
    overrideRuleOptions,
    quotaApiErrorMessage,
    statusCards,
    type QuotaOpsActionDefinition,
  } from "../lib/quota/presentation";

  let {
    onexit,
  }: {
    onexit?: () => void;
  } = $props();

  let context = $state<QuotaOpsContextView | null>(null);
  let query = $state("");
  let searchResults = $state<readonly QuotaOpsSearchResult[]>([]);
  let expandedAccountKey = $state("");
  let searching = $state(false);
  let selectedSlug = $state("");
  let detail = $state<QuotaApiOperatorView | null>(null);
  let timeline = $state<QuotaOpsTimelineView | null>(null);
  let loadingDetail = $state(false);
  let pageError = $state("");
  let actionError = $state("");

  let selectedAction = $state<QuotaOpsActionDefinition | null>(null);
  let effectiveAt = $state(toLocalDateTime(new Date()));
  let customerReason = $state("");
  let operatorReason = $state("");
  let requestId = $state(newRequestId());
  let assignmentSource = $state<"manual" | "contract">("manual");
  let subscriptionEndStatus = $state<"paused" | "canceled" | "expired">("canceled");
  let selectedPlanId = $state("");
  let billingAccount = $state("");
  let overrideRuleKey = $state("");
  let overrideLimit = $state("");
  let overrideUnlimited = $state(false);
  let overrideExpiresAt = $state("");
  let preflight = $state<QuotaOpsIntentPreflightView | null>(null);
  let confirmOpen = $state(false);
  let confirmedRisk = $state(false);
  let submitting = $state(false);
  let intentStatus = $state<QuotaOperatorIntentStatusView | null>(null);

  const actions = $derived(
    detail
      ? availableQuotaOpsActions(detail.operator.capabilities)
      : [],
  );
  const cards = $derived(detail ? statusCards(detail.statuses) : []);
  const selectedPlan = $derived(
    context?.plans.find((plan) => plan.id === selectedPlanId) ?? null,
  );
  const overrideRules = $derived(
    detail ? overrideRuleOptions(detail.resources) : [],
  );
  const requiresPlan = $derived(
    selectedAction?.kind === "subscription_upsert",
  );
  const requiresOverride = $derived(
    selectedAction?.kind === "override_schedule"
      || selectedAction?.kind === "drift_to_override",
  );
  const canPreflight = $derived(Boolean(
    selectedAction
    && customerReason.trim()
    && operatorReason.trim()
    && requestId.trim()
    && (!requiresPlan || (selectedPlanId && billingAccount.trim()))
    && (!requiresOverride || (overrideRuleKey.trim() && (overrideUnlimited || overrideLimit.trim())))
    && (
      selectedAction?.kind !== "subscription_end"
      || detail?.operator.current_subscription
    )
  ));

  function newRequestId(): string {
    return `ops-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  }

  function toLocalDateTime(value: Date): string {
    const offset = value.getTimezoneOffset() * 60_000;
    return new Date(value.valueOf() - offset).toISOString().slice(0, 16);
  }

  function toIso(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf())
      ? new Date().toISOString()
      : parsed.toISOString();
  }

  function resetActionForm(action: QuotaOpsActionDefinition | null) {
    selectedAction = action;
    actionError = "";
    preflight = null;
    confirmedRisk = false;
    intentStatus = null;
    requestId = newRequestId();
    effectiveAt = toLocalDateTime(new Date());
    customerReason = "";
    operatorReason = "";
    assignmentSource = "manual";
    subscriptionEndStatus = "canceled";
    selectedPlanId = context?.plans[0]?.id ?? "";
    billingAccount = detail?.operator.billing_account_record ?? "";
    overrideRuleKey = overrideRules[0]?.key ?? "";
    overrideLimit = "";
    overrideUnlimited = false;
    overrideExpiresAt = "";
  }

  function intentInput(kind: QuotaOperatorIntentKind): ControlPlaneObject {
    const workspace = detail?.operator.workspace_record;
    if (!workspace) return {};
    if (kind === "subscription_upsert") {
      return {
        mode:
          assignmentSource === "contract"
            ? "contract_assignment"
            : "manual_assignment",
        source: assignmentSource,
        workspace,
        billing_account: billingAccount,
        plan_revision: selectedPlanId,
        status: "active",
      };
    }
    if (kind === "subscription_end") {
      return {
        workspace,
        subscription: detail?.operator.current_subscription,
        status: subscriptionEndStatus,
      };
    }
    if (kind === "override_schedule" || kind === "drift_to_override") {
      return {
        workspace,
        patches: [{
          rule_key: overrideRuleKey,
          action: "replace",
          limit: overrideUnlimited
            ? { kind: "unlimited" }
            : { kind: "finite", value: Number(overrideLimit) },
        }],
        ...(overrideExpiresAt ? { expires_at: toIso(overrideExpiresAt) } : {}),
      };
    }
    return { workspace };
  }

  function draft(): QuotaOpsIntentDraft | null {
    if (!detail || !selectedAction) return null;
    return {
      kind: selectedAction.kind,
      workspaceSlug: detail.workspace.slug,
      workspace: detail.operator.workspace_record,
      ...(billingAccount ? { billingAccount } : {}),
      requestId: requestId.trim(),
      customerReason: customerReason.trim(),
      operatorReason: operatorReason.trim(),
      effectiveAt: toIso(effectiveAt),
      input: intentInput(selectedAction.kind),
    };
  }

  async function loadContext() {
    pageError = "";
    try {
      context = await loadOpsContext();
      selectedPlanId = context.plans[0]?.id ?? "";
      await runSearch();
    } catch (cause) {
      pageError = quotaApiErrorMessage(cause);
    }
  }

  async function runSearch() {
    searching = true;
    pageError = "";
    try {
      const result = await searchQuotaOps(query.trim());
      searchResults = result.results;
    } catch (cause) {
      pageError = quotaApiErrorMessage(cause);
    } finally {
      searching = false;
    }
  }

  async function selectWorkspace(slug: string, refresh = false) {
    selectedSlug = slug;
    loadingDetail = true;
    actionError = "";
    resetActionForm(null);
    try {
      const [nextDetail, nextTimeline] = await Promise.all([
        loadOperatorWorkspace(slug, refresh),
        loadOpsTimeline(slug),
      ]);
      detail = nextDetail;
      timeline = nextTimeline;
      billingAccount = nextDetail.operator.billing_account_record ?? "";
      overrideRuleKey = overrideRuleOptions(nextDetail.resources)[0]?.key ?? "";
    } catch (cause) {
      detail = null;
      timeline = null;
      actionError = quotaApiErrorMessage(cause);
    } finally {
      loadingDetail = false;
    }
  }

  function selectResult(result: QuotaOpsSearchResult) {
    if (result.kind === "workspace") {
      void selectWorkspace(result.workspace.slug);
    } else if (result.kind === "billing_account") {
      expandedAccountKey =
        expandedAccountKey === result.billing_account.account_key
          ? ""
          : result.billing_account.account_key;
    } else if (result.workspace_slugs[0]) {
      void selectWorkspace(result.workspace_slugs[0]);
    }
  }

  async function previewAction() {
    const value = draft();
    if (!value || !canPreflight) return;
    actionError = "";
    submitting = true;
    try {
      preflight = await preflightQuotaIntent(value);
      confirmedRisk = selectedAction?.impact !== "high";
      confirmOpen = true;
    } catch (cause) {
      actionError = quotaApiErrorMessage(cause);
    } finally {
      submitting = false;
    }
  }

  async function submitAction() {
    const value = draft();
    if (!value || !preflight || !confirmedRisk) return;
    submitting = true;
    actionError = "";
    try {
      const accepted = await submitQuotaIntent(value);
      confirmOpen = false;
      intentStatus = await loadQuotaIntentStatus(accepted.id);
      await followIntent(accepted.id);
    } catch (cause) {
      actionError = quotaApiErrorMessage(cause);
    } finally {
      submitting = false;
    }
  }

  async function followIntent(id: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (intentStatus && isIntentTerminal(intentStatus.state)) break;
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      intentStatus = await loadQuotaIntentStatus(id);
    }
    if (detail) {
      await selectWorkspace(detail.workspace.slug, false);
    }
  }

  function resultTitle(result: QuotaOpsSearchResult): string {
    if (result.kind === "workspace") return result.workspace.name;
    if (result.kind === "billing_account") return result.billing_account.name;
    return result.subject;
  }

  function resultSubtitle(result: QuotaOpsSearchResult): string {
    if (result.kind === "workspace") {
      return `${result.workspace.slug} · ${result.applied_plan_name ?? "无 applied 计划"}`;
    }
    if (result.kind === "billing_account") {
      return `${result.billing_account.account_key} · ${result.workspace_count} 个工作区`;
    }
    return `${result.workspace_slugs.length} 个工作区 · ${result.billing_account_keys.length} 个账户`;
  }

  onMount(() => {
    void loadContext();
  });
</script>

<div class="ops-page">
  <header class="topbar">
    <button type="button" class="back" onclick={() => onexit?.()}>
      <ArrowLeft size={16} />退出运营台
    </button>
    <div class="brand"><ShieldCheck size={16} /><strong>Native Quota Operations</strong></div>
    <span class="identity">{context?.viewer.subject ?? "正在验证能力"}</span>
  </header>

  <div class="ops-layout">
    <aside class="finder">
      <div class="finder-head">
        <span>全局定位</span>
        <strong>工作区与付款账户</strong>
      </div>
      <form class="search" onsubmit={(event) => { event.preventDefault(); void runSearch(); }}>
        <Search size={14} />
        <input bind:value={query} placeholder="slug、记录 ID、账户或 subject" />
        <button type="submit" disabled={searching} aria-label="搜索">
          {#if searching}<span class="spinning"><RefreshCw size={13} /></span>{:else}<ChevronRight size={14} />{/if}
        </button>
      </form>

      {#if pageError}
        <div class="side-error"><AlertTriangle size={15} />{pageError}</div>
      {:else}
        <div class="results">
          {#each searchResults as result, index (`${result.kind}:${resultTitle(result)}:${index}`)}
            <button
              type="button"
              class:active={result.kind === "workspace" && result.workspace.slug === selectedSlug}
              onclick={() => selectResult(result)}
            >
              <span class="result-icon">
                {#if result.kind === "workspace"}<Database size={14} />
                {:else if result.kind === "billing_account"}<Building2 size={14} />
                {:else}<UserRound size={14} />{/if}
              </span>
              <div>
                <strong>{resultTitle(result)}</strong>
                <small>{resultSubtitle(result)}</small>
              </div>
              <ChevronRight size={13} />
            </button>
            {#if result.kind === "billing_account"
              && expandedAccountKey === result.billing_account.account_key}
              <div class="account-workspaces">
                {#each result.workspace_slugs as slug (slug)}
                  <button type="button" onclick={() => void selectWorkspace(slug)}>
                    <Database size={12} /><span>{slug}</span><ChevronRight size={11} />
                  </button>
                {:else}
                  <small>当前没有 active 或 scheduled 工作区分配。</small>
                {/each}
              </div>
            {/if}
          {:else}
            <p class="empty-results">未找到匹配对象。</p>
          {/each}
        </div>
      {/if}

      {#if context}
        <div class="capabilities">
          <span>当前能力</span>
          <div>
            {#each context.viewer.capabilities as capability}
              <code>{capability}</code>
            {/each}
          </div>
        </div>
      {/if}
    </aside>

    <main class="detail">
      {#if loadingDetail}
        <div class="empty-detail"><span class="spinning"><RefreshCw size={22} /></span><span>读取商业状态与 native INFO…</span></div>
      {:else if !detail}
        <div class="empty-detail">
          <Gauge size={32} />
          <h1>选择一个工作区</h1>
          <p>运营台只返回配额控制面 allowlist；不会读取业务记录、完整 DDL 或 provider payload。</p>
        </div>
      {:else}
        <section class="workspace-head">
          <div>
            <span class="eyebrow">workspace · {detail.workspace.id}</span>
            <h1>{detail.workspace.name}</h1>
            <p>{detail.workspace.slug} · database {detail.operator.database}</p>
          </div>
          <button type="button" class="refresh-detail" onclick={() => void selectWorkspace(selectedSlug, true)}>
            <RefreshCw size={14} />Fresh INFO
          </button>
        </section>

        {#if actionError}
          <div class="inline-error"><AlertTriangle size={15} />{actionError}</div>
        {/if}

        <section class="status-strip">
          {#each cards as card (card.key)}
            <article data-tone={card.tone}>
              <span>{card.title}</span><strong>{card.label}</strong><small>{card.description}</small>
            </article>
          {/each}
        </section>

        <section class="pointers panel">
          <header><div><Settings2 size={15} /><strong>商业与执行四指针</strong></div><span>{formatQuotaDate(detail.commercial_state_at)}</span></header>
          <div class="pointer-grid">
            <div><span>Desired entitlement</span><code>{detail.operator.desired_entitlement ?? "NONE"}</code></div>
            <div><span>Applied entitlement</span><code>{detail.operator.applied_entitlement ?? "NONE"}</code></div>
            <div><span>Desired projection</span><code>{detail.operator.desired_projection ?? "NONE"}</code></div>
            <div><span>Applied projection</span><code>{detail.operator.applied_projection ?? "NONE"}</code></div>
          </div>
          <div class="native-row">
            <span>generation <strong>{detail.operator.native_generation ?? "—"}</strong></span>
            <span>ledger <strong>{detail.statuses.ledger ?? "unknown"}</strong></span>
            <span>usage <strong>{detail.usage_trusted ? "trusted" : "unknown"}</strong></span>
            <span>drift <strong>{detail.operator.drift_error_code ?? "none"}</strong></span>
            <span>auto reconcile <strong>{detail.operator.auto_reconcile ? "on" : "paused"}</strong></span>
          </div>
        </section>

        <div class="columns">
          <section class="resources panel">
            <header>
              <div><Gauge size={15} /><strong>有效用量</strong></div>
              <span>{formatQuotaDate(detail.observed_at)}</span>
            </header>
            <div class="resource-list">
              {#each detail.resources as resource (resource.key)}
                <article>
                  <div>
                    <span>{resource.resource}</span>
                    <strong>{resource.label}</strong>
                    <small>{resource.selector.description}</small>
                  </div>
                  <div class="numbers">
                    <strong>{formatQuotaCount(resource.usage.used)}</strong>
                    <span>/ {resource.usage.kind === "unlimited" ? "不限" : formatQuotaCount(resource.usage.limit)}</span>
                  </div>
                </article>
              {/each}
            </div>
          </section>

          <section class="actions panel">
            <header><div><Activity size={15} /><strong>审计意图</strong></div><span>不直接修改 applied / usage</span></header>
            {#if selectedAction}
              <div class="action-form">
                <button type="button" class="close-action" aria-label="关闭动作" onclick={() => resetActionForm(null)}><X size={14} /></button>
                <h3>{selectedAction.label}</h3>
                <p>{selectedAction.description}</p>

                {#if requiresPlan}
                  <label><span>分配类型</span>
                    <select bind:value={assignmentSource}>
                      <option value="manual">手工赠送</option>
                      <option value="contract">合同计划</option>
                    </select>
                  </label>
                  <label><span>目标计划 revision</span>
                    <select bind:value={selectedPlanId}>
                      {#each context?.plans ?? [] as plan (plan.id)}
                        <option value={plan.id}>{plan.plan_name} · r{plan.revision}</option>
                      {/each}
                    </select>
                  </label>
                  <label><span>Billing account record</span><input bind:value={billingAccount} placeholder="billing_account:…" /></label>
                  {#if selectedPlan}
                    <div class="target-plan">
                      <strong>{selectedPlan.plan_name}</strong>
                      <span>{selectedPlan.rules.length} 条 table/field/record 规则</span>
                    </div>
                  {/if}
                {/if}

                {#if requiresOverride}
                  <label><span>目标 rule key</span>
                    <select bind:value={overrideRuleKey}>
                      {#each overrideRules as rule (rule.key)}
                        <option value={rule.key}>{rule.label} · {rule.key}</option>
                      {/each}
                    </select>
                  </label>
                  <label class="inline-check"><input type="checkbox" bind:checked={overrideUnlimited} /><span>目标设为不限</span></label>
                  {#if !overrideUnlimited}
                    <label><span>目标上限</span><input type="number" min="0" step="1" bind:value={overrideLimit} /></label>
                  {/if}
                  <label><span>到期时间（可选）</span><input type="datetime-local" bind:value={overrideExpiresAt} /></label>
                {/if}

                {#if selectedAction.kind === "subscription_end"}
                  <label><span>结束状态</span>
                    <select bind:value={subscriptionEndStatus}>
                      <option value="canceled">canceled（取消）</option>
                      <option value="paused">paused（暂停）</option>
                      <option value="expired">expired（到期）</option>
                    </select>
                  </label>
                  {#if !detail.operator.current_subscription}
                    <p class="form-warning">当前工作区没有可结束的 subscription。</p>
                  {/if}
                {/if}

                <label><span>生效时间</span><input type="datetime-local" bind:value={effectiveAt} /></label>
                <label><span>客户可见原因</span><textarea bind:value={customerReason} maxlength="500" placeholder="向客户解释为什么有此变更"></textarea></label>
                <label><span>内部原因</span><textarea bind:value={operatorReason} maxlength="2000" placeholder="工单、合同或排障依据"></textarea></label>
                <label><span>幂等 request id</span><input bind:value={requestId} maxlength="128" /></label>
                <button type="button" class="primary" disabled={!canPreflight || submitting} onclick={() => void previewAction()}>
                  {#if submitting}<span class="spinning"><RefreshCw size={14} /></span>{:else}<ShieldCheck size={14} />{/if}
                  Fresh preflight 与影响预览
                </button>
                {#if intentStatus}
                  <div class="intent-status">
                    <strong>{intentStatus.state}</strong>
                    <span>attempt {intentStatus.attempt_count} · {intentStatus.last_error_code ?? "no error"}</span>
                    <code>{intentStatus.id}</code>
                  </div>
                {/if}
              </div>
            {:else}
              <div class="action-list">
                {#each actions as action (action.kind)}
                  <button type="button" onclick={() => resetActionForm(action)}>
                    <div><strong>{action.label}</strong><small>{action.description}</small></div>
                    <code>{action.capability}</code>
                  </button>
                {:else}
                  <p>当前 subject 只有 quota.read，不能提交运营意图。</p>
                {/each}
              </div>
            {/if}
          </section>
        </div>

        <section class="timeline panel">
          <header><div><History size={15} /><strong>Operation / attempt / audit 时间线</strong></div><span>{timeline?.items.length ?? 0} 项</span></header>
          <div class="timeline-list">
            {#each timeline?.items ?? [] as item (item.id)}
              <article>
                <span class="timeline-dot"></span>
                <div>
                  <div><strong>{item.label}</strong><code>{item.kind}</code><span>{item.state}</span></div>
                  <p>{item.id}</p>
                  <small>{formatQuotaDate(item.occurred_at)} · {item.actor_subject ?? "system"} · {item.error_code ?? "no error"}</small>
                </div>
              </article>
            {:else}
              <p class="no-timeline">尚无可见的控制面时间线。</p>
            {/each}
          </div>
        </section>
      {/if}
    </main>
  </div>
</div>

<AlertDialog.Root bind:open={confirmOpen} onOpenChange={(open) => (confirmOpen = open)}>
  <AlertDialog.Content class="quota-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>确认提交审计意图</AlertDialog.Title>
      <AlertDialog.Description>
        HTTP 202 只表示意图已持久化；完成以 operation、native INFO readback 和 applied 指针为准。
      </AlertDialog.Description>
    </AlertDialog.Header>
    {#if preflight}
      <div class="confirm-summary">
        <div><span>工作区</span><strong>{preflight.workspace.name}</strong></div>
        <div><span>生效时间</span><strong>{formatQuotaDate(preflight.effective_at)}</strong></div>
        <div><span>Fresh INFO</span><strong>{formatQuotaDate(preflight.observed_at)}</strong></div>
        <div><span>预计超额项</span><strong class:danger={preflight.overage_count > 0}>{preflight.overage_count}</strong></div>
      </div>
      <div class="diff-list">
        {#each preflight.resources.filter((item) => item.current_limit !== item.target_limit) as item (item.key)}
          <div>
            <span>{item.label}</span>
            <code>{item.current_limit ?? "继承"} → {item.target_limit ?? "继承"}</code>
            <small>used {formatQuotaCount(item.used)} · over {formatQuotaCount(item.projected_over_by)}</small>
          </div>
        {:else}
          <p>此动作不直接改变额度数值，将影响 {preflight.affected_capabilities.join("、")}。</p>
        {/each}
      </div>
      {#if selectedAction?.impact === "high"}
        <label class="risk-confirm">
          <input type="checkbox" bind:checked={confirmedRisk} />
          <span>我确认已核对 current/target、fresh usage、预计 overage 和 effective_at；该动作不会删除客户数据。</span>
        </label>
      {/if}
    {/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={submitting}>返回修改</AlertDialog.Cancel>
      <AlertDialog.Action disabled={!confirmedRisk || submitting} onclick={() => void submitAction()}>
        {submitting ? "提交中…" : "确认提交"}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<style>
  .ops-page { width: 100%; height: 100vh; overflow: hidden; background: #eeece5; color: #211f1a; }
  .topbar {
    display: grid;
    height: 56px;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0 18px;
    border-bottom: 1px solid #ddd8cb;
    background: #1f2822;
    color: #f8f7f2;
  }
  button, input, select, textarea { font: inherit; }
  .back { display: flex; width: max-content; align-items: center; gap: 7px; border: 0; background: transparent; color: #c9cec9; font-size: 11px; cursor: pointer; }
  .brand { display: flex; align-items: center; gap: 8px; color: #dce9d8; font-size: 12px; letter-spacing: .02em; }
  .identity { justify-self: end; max-width: 280px; overflow: hidden; color: #9ba59e; font-family: monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .ops-layout { display: grid; height: calc(100vh - 56px); grid-template-columns: 302px minmax(0, 1fr); }
  .finder { display: flex; min-height: 0; flex-direction: column; border-right: 1px solid #d7d2c6; background: #f7f5ef; }
  .finder-head { display: grid; gap: 3px; padding: 18px 16px 12px; }
  .finder-head span { color: #8e897c; font-size: 9px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
  .finder-head strong { font-size: 13px; }
  .search { display: grid; height: 38px; grid-template-columns: auto 1fr auto; align-items: center; gap: 7px; margin: 0 12px 12px; padding-left: 10px; border: 1px solid #d9d4c8; border-radius: 10px; background: #fff; }
  .search input { min-width: 0; border: 0; outline: 0; font-size: 11px; }
  .search button { display: grid; width: 34px; height: 100%; place-items: center; border: 0; border-left: 1px solid #e4dfd4; background: transparent; color: #4d7658; cursor: pointer; }
  .results { flex: 1; overflow-y: auto; padding: 0 8px; }
  .results > button { display: grid; width: 100%; grid-template-columns: 28px 1fr auto; align-items: center; gap: 8px; padding: 9px; border: 0; border-radius: 9px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .results > button:hover, .results > button.active { background: #e7eee3; }
  .result-icon { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid #ddd8cb; border-radius: 8px; background: #fff; color: #58735e; }
  .results div { display: grid; min-width: 0; gap: 2px; }
  .results strong, .results small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .results strong { font-size: 11px; }
  .results small { color: #8e897c; font-size: 9px; }
  .account-workspaces { gap: 3px !important; margin: 0 8px 6px 22px; padding-left: 10px; border-left: 1px solid #d5dccc; }
  .account-workspaces button { display: grid; grid-template-columns: 16px 1fr 12px; align-items: center; gap: 5px; padding: 6px 7px; border: 0; border-radius: 7px; background: transparent; color: #657063; font-size: 9px; text-align: left; cursor: pointer; }
  .account-workspaces button:hover { background: #e7eee3; color: #314d39; }
  .account-workspaces > small { padding: 5px 7px; white-space: normal; }
  .empty-results, .side-error { padding: 20px 12px; color: #918b7e; font-size: 11px; text-align: center; }
  .side-error { display: flex; gap: 7px; color: #a1473a; text-align: left; }
  .capabilities { padding: 12px; border-top: 1px solid #ddd8cb; }
  .capabilities > span { color: #8e897c; font-size: 9px; font-weight: 700; text-transform: uppercase; }
  .capabilities div { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
  .capabilities code { padding: 3px 5px; border-radius: 5px; background: #e9e5da; color: #5c574b; font-size: 8px; }
  .detail { min-width: 0; overflow-y: auto; padding: 28px 30px 60px; }
  .empty-detail { display: grid; min-height: 70vh; place-content: center; justify-items: center; gap: 10px; color: #8c877a; text-align: center; }
  .empty-detail h1 { margin: 6px 0 0; color: #343129; font-size: 20px; }
  .empty-detail p { max-width: 480px; margin: 0; font-size: 11px; line-height: 1.6; }
  .workspace-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
  .workspace-head h1 { margin: 4px 0; font-size: 27px; letter-spacing: -.03em; }
  .workspace-head p { margin: 0; color: #837e72; font-family: monospace; font-size: 10px; }
  .eyebrow { color: #55755e; font-size: 9px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
  .refresh-detail { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 11px; border: 1px solid #d2ccbf; border-radius: 9px; background: #f9f8f3; color: #59554b; font-size: 10px; font-weight: 650; cursor: pointer; }
  .inline-error { display: flex; gap: 8px; margin-top: 14px; padding: 10px 12px; border: 1px solid #e6c3ba; border-radius: 9px; background: #fff1ed; color: #9f4034; font-size: 10px; }
  .status-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 20px; }
  .status-strip article { min-height: 85px; padding: 12px; border: 1px solid #dcd6c9; border-radius: 11px; background: #f8f7f2; }
  .status-strip span { color: #918b7e; font-size: 8px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  .status-strip strong, .status-strip small { display: block; }
  .status-strip strong { margin-top: 6px; font-size: 12px; }
  .status-strip small { margin-top: 5px; color: #918b7e; font-size: 8.5px; line-height: 1.4; }
  [data-tone="positive"] strong { color: #357149; }
  [data-tone="warning"] strong { color: #a3642d; }
  [data-tone="critical"] strong { color: #a83f35; }
  .panel { margin-top: 12px; border: 1px solid #d9d3c6; border-radius: 12px; background: #f9f8f4; overflow: hidden; }
  .panel > header { display: flex; align-items: center; justify-content: space-between; min-height: 42px; padding: 0 14px; border-bottom: 1px solid #e0dbd0; background: #f3f1ea; }
  .panel > header div { display: flex; align-items: center; gap: 7px; }
  .panel > header strong { font-size: 11px; }
  .panel > header span { color: #908a7d; font-size: 8px; }
  .pointer-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: #e4dfd4; }
  .pointer-grid div { display: grid; gap: 6px; padding: 12px 14px; background: #fff; }
  .pointer-grid span { color: #8b8579; font-size: 8px; text-transform: uppercase; }
  code { font-family: "SFMono-Regular", Consolas, monospace; }
  .pointer-grid code { overflow: hidden; color: #3e5945; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
  .native-row { display: flex; flex-wrap: wrap; gap: 10px 22px; padding: 10px 14px; color: #8a8477; font-size: 8px; text-transform: uppercase; }
  .native-row strong { color: #343129; font-family: monospace; font-weight: 600; text-transform: none; }
  .columns { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr); gap: 12px; }
  .resource-list { max-height: 480px; overflow-y: auto; }
  .resource-list article { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 14px; border-top: 1px solid #ebe7de; background: #fff; }
  .resource-list article:first-child { border-top: 0; }
  .resource-list article > div:first-child { display: grid; min-width: 0; grid-template-columns: auto 1fr; gap: 3px 7px; }
  .resource-list article span:first-child { grid-row: 1 / 3; padding: 3px 5px; border-radius: 4px; background: #e8eee5; color: #4c6e54; font-size: 7px; font-weight: 800; text-transform: uppercase; }
  .resource-list strong { font-size: 10px; }
  .resource-list small { color: #918b7e; font-size: 8px; }
  .numbers { display: flex; flex-shrink: 0; align-items: baseline; gap: 3px; }
  .numbers strong { font-size: 14px; }
  .numbers span { color: #8f897c; font-size: 8px; }
  .action-list { display: grid; max-height: 480px; overflow-y: auto; }
  .action-list > button { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 11px 14px; border: 0; border-top: 1px solid #ebe7de; background: #fff; color: inherit; text-align: left; cursor: pointer; }
  .action-list > button:first-child { border-top: 0; }
  .action-list > button:hover { background: #f4f7f1; }
  .action-list div { display: grid; gap: 3px; }
  .action-list strong { font-size: 10px; }
  .action-list small, .action-list p { color: #908a7d; font-size: 8px; line-height: 1.4; }
  .action-list code { align-self: center; color: #617868; font-size: 7px; }
  .action-form { position: relative; display: grid; gap: 10px; padding: 14px; }
  .close-action { position: absolute; top: 9px; right: 9px; display: grid; width: 25px; height: 25px; place-items: center; border: 0; border-radius: 7px; background: #ece8de; cursor: pointer; }
  .action-form h3 { margin: 0; font-size: 13px; }
  .action-form > p { margin: -5px 28px 2px 0; color: #8b8578; font-size: 8px; }
  .action-form label { display: grid; gap: 4px; }
  .action-form label > span { color: #716c61; font-size: 8px; font-weight: 700; }
  .action-form input, .action-form select, .action-form textarea { width: 100%; padding: 7px 8px; border: 1px solid #d9d3c7; border-radius: 7px; outline: 0; background: #fff; color: #29261f; font-size: 9px; }
  .action-form textarea { min-height: 50px; resize: vertical; }
  .action-form input:focus, .action-form select:focus, .action-form textarea:focus { border-color: #55785e; }
  .inline-check { display: flex !important; align-items: center; grid-template-columns: auto 1fr; }
  .inline-check input { width: auto; }
  .target-plan { display: flex; align-items: center; justify-content: space-between; padding: 8px; border-radius: 7px; background: #eaf0e7; font-size: 8px; }
  .primary { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; border: 0; border-radius: 8px; background: #2f6742; color: #fff; font-size: 9px; font-weight: 700; cursor: pointer; }
  .primary:disabled { opacity: .45; cursor: default; }
  .intent-status { display: grid; gap: 3px; padding: 9px; border: 1px solid #bfd5c4; border-radius: 8px; background: #edf5eb; }
  .intent-status strong { color: #2f6742; font-size: 10px; }
  .intent-status span, .intent-status code { overflow: hidden; color: #728174; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
  .form-warning { margin: -2px 0 0; color: #a14235; font-size: 10px; }
  .timeline-list { padding: 4px 14px 12px; }
  .timeline-list article { display: grid; grid-template-columns: 10px 1fr; gap: 8px; padding: 10px 0; border-bottom: 1px solid #ebe7de; }
  .timeline-dot { width: 7px; height: 7px; margin-top: 4px; border: 2px solid #f9f8f4; border-radius: 50%; background: #5e7d65; box-shadow: 0 0 0 1px #9ab0a0; }
  .timeline-list article > div { min-width: 0; }
  .timeline-list article div div { display: flex; align-items: center; gap: 6px; }
  .timeline-list strong { font-size: 9px; }
  .timeline-list code, .timeline-list article div div span { padding: 2px 4px; border-radius: 4px; background: #ece8df; color: #6e695e; font-size: 7px; }
  .timeline-list p { overflow: hidden; margin: 4px 0; color: #5f5a50; font-family: monospace; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
  .timeline-list small { color: #928c80; font-size: 7.5px; }
  .no-timeline { padding: 18px; color: #8f897d; font-size: 9px; text-align: center; }
  .spinning { display: inline-flex; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  :global(.quota-confirm) { width: min(680px, calc(100vw - 28px)); max-width: 680px; }
  :global(.quota-confirm [data-slot="alert-dialog-title"]) { font-size: 16px; }
  :global(.quota-confirm [data-slot="alert-dialog-description"]) { font-size: 11px; line-height: 1.5; }
  .confirm-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; }
  .confirm-summary div { display: grid; gap: 3px; padding: 9px; border: 1px solid #e2ddd3; border-radius: 8px; }
  .confirm-summary span { color: #8b857a; font-size: 8px; text-transform: uppercase; }
  .confirm-summary strong { font-size: 10px; }
  .confirm-summary strong.danger { color: #a53e34; }
  .diff-list { display: grid; max-height: 260px; overflow-y: auto; border: 1px solid #e1dcd1; border-radius: 9px; }
  .diff-list > div { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; padding: 8px 10px; border-top: 1px solid #ebe7df; }
  .diff-list > div:first-child { border-top: 0; }
  .diff-list span { font-size: 9px; }
  .diff-list code, .diff-list small { color: #716b60; font-size: 8px; }
  .diff-list p { margin: 0; padding: 13px; color: #756f64; font-size: 9px; }
  .risk-confirm { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border: 1px solid #e5c5b8; border-radius: 8px; background: #fff5ef; color: #7f4a37; font-size: 9px; line-height: 1.5; }
  .risk-confirm input { margin-top: 2px; }
  @media (max-width: 980px) {
    .ops-layout { grid-template-columns: 250px minmax(0, 1fr); }
    .columns { grid-template-columns: 1fr; }
    .status-strip { grid-template-columns: repeat(2, 1fr); }
  }
</style>
