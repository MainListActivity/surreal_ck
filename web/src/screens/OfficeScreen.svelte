<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    Activity,
    Briefcase,
    CircleAlert,
    Check,
    FileText,
    Inbox,
    MessageSquare,
    Pause,
    Play,
    RefreshCw,
    UserMinus,
    Users,
  } from "@lucide/svelte";
  import RiskNotificationInbox from "../components/RiskNotificationInbox.svelte";
  import { getSurreal } from "../lib/surreal";
  import {
    openOfficeRuntime,
    type OfficeDataRuntime,
    type OfficeLifecycleAction,
    type OfficeSnapshot,
  } from "../lib/office-runtime";
  import { createOfficeLifecycleClient } from "../lib/office-lifecycle";
  import { isWorkspaceAdmin } from "../lib/permissions.svelte";
  import {
    notificationPurposeLabel,
    taskStatusLabel,
    type OfficeActivityItem,
    type OfficeEmployee,
  } from "../lib/office-data";

  // 办公室页面（VO04）：花名册 + 活动流 + 任务/报告钻取 + 现有通知收件箱。
  // 数据全部来自 OfficeDataRuntime（深模块）；本组件只消费 snapshot 与动作入口，
  // 快照/LIVE 竞态、重连、workspace 切换清理都封装在 runtime 内。
  let { slug }: { slug: string } = $props();

  let snap = $state<OfficeSnapshot | null>(null);
  let openError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let selectedId = $state<string | null>(null);
  let busyKey = $state<string | null>(null);
  let runtime: OfficeDataRuntime | null = null;

  const isAdmin = $derived(isWorkspaceAdmin());
  const selected = $derived(
    snap?.activity.find((item) => item.id === selectedId) ?? null,
  );
  const virtualEmployees = $derived(snap?.employees.filter((member) => member.isVirtual) ?? []);
  const humanMembers = $derived(snap?.employees.filter((member) => !member.isVirtual) ?? []);
  const pendingNotifications = $derived(snap?.notifications.filter((item) => !item.resolvedAt) ?? []);

  const CONNECTION_LABELS: Record<OfficeSnapshot["connection"], string> = {
    connected: "实时",
    connecting: "连接中",
    reconnecting: "重连中",
    disconnected: "已断开",
  };

  // slug 变化（workspace 切换）或组件卸载时，cleanup 幂等关闭旧 runtime：
  // 旧 database 的迟到事件从此被丢弃，新 workspace 建立全新订阅。
  $effect(() => {
    const targetSlug = slug;
    let disposed = false;
    let local: OfficeDataRuntime | null = null;
    openError = null;
    actionError = null;
    selectedId = null;
    snap = null;
    void (async () => {
      try {
        const created = await openOfficeRuntime({
          conn: getSurreal(),
          slug: targetSlug,
          lifecycle: createOfficeLifecycleClient(),
          onChange: (next) => {
            if (!disposed) snap = next;
          },
        });
        if (disposed) {
          await created.close();
          return;
        }
        local = created;
        runtime = created;
        snap = created.snapshot;
      } catch (cause) {
        if (!disposed) openError = cause instanceof Error ? cause.message : String(cause);
      }
    })();
    return () => {
      disposed = true;
      runtime = null;
      void local?.close();
    };
  });

  onDestroy(() => {
    // $effect cleanup 是主清理路径；这里兜底组件销毁时 effect 未运行完成的场景。
    void runtime?.close();
    runtime = null;
  });

  function nameOf(id: string | null): string {
    if (!id) return "未知";
    return snap?.employees.find((member) => member.id === id)?.displayName ?? id;
  }

  function formatTime(value: string | null): string {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
  }

  const EMPLOYEE_STATUS_LABELS: Record<OfficeEmployee["status"], string> = {
    provisioning: "开岗中",
    active: "在岗",
    paused: "已暂停",
    retired: "已退休",
  };

  /** 能力提示：只有管理员看到动作按钮；规则由后端生命周期权威执行。 */
  function availableActions(employee: OfficeEmployee): OfficeLifecycleAction[] {
    if (!isAdmin) return [];
    switch (employee.status) {
      case "active":
        return ["pause", "retire"];
      case "paused":
        return ["resume", "retire"];
      case "provisioning":
        return ["retire"];
      default:
        return [];
    }
  }

  async function runLifecycle(employee: OfficeEmployee, action: OfficeLifecycleAction) {
    if (!runtime) return;
    if (action === "retire"
      && !window.confirm(`确认退休员工「${employee.displayName}」？退休后不可恢复，历史记录保留。`)) {
      return;
    }
    busyKey = `${employee.id}:${action}`;
    actionError = null;
    const outcome = await runtime.lifecycleAction(employee.id, action);
    busyKey = null;
    if (!outcome.ok) actionError = outcome.message;
  }

  async function resolveSelectedNotification(id: string) {
    if (!runtime) return;
    const resolution = window.prompt("填写处理结果（提交后不可修改）");
    if (!resolution?.trim()) return;
    busyKey = `notify:${id}`;
    actionError = null;
    const outcome = await runtime.resolveNotification(id, resolution);
    busyKey = null;
    if (!outcome.ok) actionError = outcome.message;
  }

  function retry() {
    void runtime?.refresh();
  }

  const KIND_META = {
    task: { label: "任务", icon: Briefcase },
    message: { label: "消息", icon: MessageSquare },
    report: { label: "报告", icon: FileText },
    notification: { label: "通知", icon: Inbox },
  } as const;
</script>

<div class="office-screen">
  <header class="office-header">
    <div class="office-title">
      <Users size={18} />
      <h2>办公室</h2>
      {#if snap?.meta?.goal}
        <span class="office-goal" title={snap.meta.goal}>{snap.meta.goal}</span>
      {/if}
    </div>
    <div class="office-toolbar">
      {#if snap}
        <span
          class="connection-badge"
          class:degraded={snap.connection !== "connected"}
          title="数据库连接状态"
        >{CONNECTION_LABELS[snap.connection]}</span>
        <button type="button" class="ghost-btn" onclick={retry} disabled={snap.refreshing}>
          <RefreshCw size={13} />{snap.refreshing ? "刷新中…" : "刷新"}
        </button>
      {/if}
    </div>
  </header>

  {#if openError}
    <div class="state error">
      <CircleAlert size={20} />
      <span>办公室数据加载失败：{openError}</span>
    </div>
  {:else if !snap}
    <div class="state"><Activity size={20} /><span>正在连接办公室…</span></div>
  {:else if snap.status === "error"}
    <div class="state error">
      <CircleAlert size={20} />
      <span>{snap.error?.message ?? "办公室数据加载失败"}</span>
      <button type="button" class="secondary-btn" onclick={retry}>重试</button>
    </div>
  {:else if snap.status === "closed"}
    <div class="state"><span>办公室已关闭。</span></div>
  {:else}
    <div class="office-grid">
      <!-- 左：花名册 -->
      <section class="panel" aria-label="员工花名册">
        <h3><Users size={14} />花名册</h3>
        {#if virtualEmployees.length === 0}
          <div class="empty">还没有虚拟员工。保存办公室目标并完成引导后，项目经理会自动开岗。</div>
        {:else}
          {#each virtualEmployees as employee (employee.id)}
            <article class="employee">
              <div class="employee-main">
                <strong>{employee.displayName}</strong>
                <span class="role">{employee.roleKey ?? "未设岗位"}</span>
              </div>
              <span class="status status-{employee.status}">{EMPLOYEE_STATUS_LABELS[employee.status]}</span>
              {#if availableActions(employee).length > 0}
                <div class="employee-actions">
                  {#each availableActions(employee) as action (action)}
                    <button
                      type="button"
                      class="action-btn"
                      disabled={busyKey !== null}
                      onclick={() => void runLifecycle(employee, action)}
                    >
                      {#if action === "pause"}<Pause size={11} />暂停
                      {:else if action === "resume"}<Play size={11} />恢复
                      {:else}<UserMinus size={11} />退休{/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </article>
          {/each}
        {/if}
        {#if humanMembers.length > 0}
          <h4>真人成员</h4>
          {#each humanMembers as member (member.id)}
            <article class="employee human">
              <div class="employee-main">
                <strong>{member.displayName}</strong>
                {#if member.isAdmin}<span class="role">管理员</span>{/if}
              </div>
            </article>
          {/each}
        {/if}
        {#if actionError}
          <div class="action-error">{actionError}</div>
        {/if}
      </section>

      <!-- 中：活动流 + 钻取 -->
      <section class="panel" aria-label="活动流">
        <h3><Activity size={14} />活动流</h3>
        {#if snap.activity.length === 0}
          <div class="empty">办公室还没有活动。</div>
        {:else}
          <div class="activity-list">
            {#each snap.activity as item (item.id)}
              <article class="activity-card" class:selected={item.id === selectedId}>
                <button type="button" class="activity-summary" onclick={() => (selectedId = selectedId === item.id ? null : item.id)}>
                  <span class="kind kind-{item.kind}"><span aria-hidden="true">{KIND_META[item.kind].label}</span></span>
                  <span class="activity-title">{item.title}</span>
                  <time>{formatTime(item.at)}</time>
                </button>

                {#if item.id === selectedId && selected}
                  <div class="drilldown">
                    {#if selected.kind === "task" && selected.taskId}
                      {@const task = snap.tasks.find((candidate) => candidate.id === selected.taskId)}
                      {#if task}
                        <dl>
                          <div><dt>状态</dt><dd>{taskStatusLabel(task.status)}</dd></div>
                          <div><dt>目标</dt><dd>{task.goal}</dd></div>
                          <div><dt>委派</dt><dd>{nameOf(task.assignerId)} → {nameOf(task.assigneeId)}</dd></div>
                          <div><dt>层级</dt><dd>深度 {task.depth}{task.parentId ? `（父任务 ${task.parentId}）` : ""}</dd></div>
                          <div><dt>截止</dt><dd>{formatTime(task.dueAt)}</dd></div>
                          {#if task.resultSummary}<div><dt>结果</dt><dd>{task.resultSummary}</dd></div>{/if}
                        </dl>
                        {#if snap.messages.some((message) => message.taskId === task.id)}
                          <h5>相关消息</h5>
                          {#each snap.messages.filter((message) => message.taskId === task.id) as message (message.id)}
                            <p class="thread"><strong>{nameOf(message.authorId)}</strong>{message.body}</p>
                          {/each}
                        {/if}
                        {#if snap.reports.some((report) => report.taskId === task.id)}
                          <h5>相关报告</h5>
                          {#each snap.reports.filter((report) => report.taskId === task.id) as report (report.id)}
                            <button type="button" class="thread-link" onclick={() => (selectedId = report.id)}>
                              {report.summary}（{formatTime(report.createdAt)}）
                            </button>
                          {/each}
                        {/if}
                      {:else}
                        <p class="thread">任务详情暂不可用。</p>
                      {/if}
                    {:else if selected.kind === "report"}
                      {@const report = snap.reports.find((candidate) => candidate.id === selected.id)}
                      {#if report}
                        <dl>
                          <div><dt>摘要</dt><dd>{report.summary}</dd></div>
                          {#if report.nextSteps.length}<div><dt>下一步</dt><dd>{report.nextSteps.join("；")}</dd></div>{/if}
                          {#if report.blockedBy}<div><dt>受阻原因</dt><dd>{report.blockedBy}</dd></div>{/if}
                          <div><dt>作者</dt><dd>{nameOf(report.authorId)}</dd></div>
                          <div><dt>收件人</dt><dd>{nameOf(report.toId)}</dd></div>
                        </dl>
                        {#if report.taskId}
                          <button type="button" class="thread-link" onclick={() => (selectedId = report.taskId)}>
                            查看关联任务 {report.taskId}
                          </button>
                        {/if}
                      {/if}
                    {:else if selected.kind === "message"}
                      {@const message = snap.messages.find((candidate) => candidate.id === selected.id)}
                      {#if message}
                        <p class="thread">{message.body}</p>
                        <dl>
                          <div><dt>作者</dt><dd>{nameOf(message.authorId)}</dd></div>
                          {#if message.toId}<div><dt>收件人</dt><dd>{nameOf(message.toId)}</dd></div>{/if}
                        </dl>
                        {#if message.taskId}
                          <button type="button" class="thread-link" onclick={() => (selectedId = message.taskId)}>
                            查看关联任务 {message.taskId}
                          </button>
                        {/if}
                      {/if}
                    {:else if selected.kind === "notification"}
                      {@const notification = snap.notifications.find((candidate) => candidate.id === selected.id)}
                      {#if notification}
                        <dl>
                          <div><dt>类型</dt><dd>{notificationPurposeLabel(notification.purpose)}</dd></div>
                          <div><dt>内容</dt><dd>{notification.body || notification.title}</dd></div>
                          {#if notification.fromEmployeeId}<div><dt>请求者</dt><dd>{nameOf(notification.fromEmployeeId)}</dd></div>{/if}
                          {#if notification.resolvedAt}
                            <div><dt>已解决</dt><dd>{formatTime(notification.resolvedAt)}：{notification.resolution}</dd></div>
                          {/if}
                          {#each Object.entries(notification.payload) as [key, value]}
                            <div><dt>{key}</dt><dd>{String(value)}</dd></div>
                          {/each}
                        </dl>
                        {#if !notification.resolvedAt}
                          <button
                            type="button"
                            class="secondary-btn"
                            disabled={busyKey !== null}
                            onclick={() => void resolveSelectedNotification(notification.id)}
                          ><Check size={12} />标记已处理</button>
                        {/if}
                        {#if notification.taskId}
                          <button type="button" class="thread-link" onclick={() => (selectedId = notification.taskId)}>
                            查看关联任务 {notification.taskId}
                          </button>
                        {/if}
                      {/if}
                    {/if}
                  </div>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <!-- 右：现有通知收件箱 -->
      <section class="panel" aria-label="通知收件箱">
        <h3><Inbox size={14} />通知收件箱</h3>
        {#if pendingNotifications.length > 0}
          <p class="inbox-hint">{pendingNotifications.length} 条待处理：员工请求会在这里等待回答，处理结果会唤醒请求者。</p>
        {/if}
        <RiskNotificationInbox />
      </section>
    </div>
  {/if}
</div>

<style>
  .office-screen {
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    gap: 12px;
    padding: 18px 22px;
    overflow-y: auto;
  }

  .office-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
  }

  .office-title {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
    color: var(--text-1);
  }

  .office-title h2 {
    margin: 0;
    font-size: 16px;
  }

  .office-goal {
    overflow: hidden;
    max-width: 480px;
    color: var(--text-2);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .office-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .connection-badge {
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--success-bg);
    color: var(--success);
    font-size: 11px;
  }

  .connection-badge.degraded {
    background: var(--warning-bg);
    color: var(--warning);
  }

  .office-grid {
    display: grid;
    flex: 1;
    min-height: 0;
    grid-template-columns: minmax(230px, 300px) minmax(0, 1fr) minmax(250px, 320px);
    gap: 14px;
    align-items: start;
  }

  .panel {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 9px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-2);
  }

  .panel h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--text-1);
    font-size: 13px;
  }

  .panel h4 {
    margin: 10px 0 2px;
    color: var(--text-3);
    font-size: 11px;
  }

  .panel h5 {
    margin: 8px 0 4px;
    color: var(--text-2);
    font-size: 11px;
  }

  .employee {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
  }

  .employee-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .employee-main strong {
    font-size: 12.5px;
  }

  .role {
    overflow: hidden;
    color: var(--text-3);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    align-self: flex-start;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10.5px;
  }

  .status-active { background: var(--success-bg); color: var(--success); }
  .status-paused { background: var(--warning-bg); color: var(--warning); }
  .status-retired { background: var(--soft); color: var(--text-3); }
  .status-provisioning { background: var(--soft); color: var(--text-3); }

  .employee-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 4px 7px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 10.5px;
    cursor: pointer;
  }

  .action-btn:hover:not(:disabled) {
    border-color: var(--primary);
    color: var(--primary);
  }

  .action-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .action-error {
    padding: 7px 9px;
    border-radius: 7px;
    background: var(--error-bg);
    color: var(--error);
    font-size: 11px;
  }

  .activity-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .activity-card {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
  }

  .activity-card.selected {
    border-color: var(--primary);
  }

  .activity-summary {
    display: grid;
    width: 100%;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: center;
    padding: 8px 10px;
    border: 0;
    background: transparent;
    color: var(--text-1);
    text-align: left;
    cursor: pointer;
  }

  .kind {
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--soft);
    color: var(--text-2);
    font-size: 10px;
  }

  .kind-task { background: var(--primary-light); color: var(--brand-strong); }
  .kind-report { background: var(--purple-bg); color: var(--purple); }
  .kind-notification { background: var(--warning-bg); color: var(--warning); }

  .activity-title {
    overflow: hidden;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity-summary time {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-3);
    font-size: 10.5px;
  }

  .drilldown {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 12px 11px 12px;
    border-top: 1px dashed var(--border);
    color: var(--text-2);
    font-size: 11.5px;
  }

  .drilldown dl {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 6px 0 0;
  }

  .drilldown dl div {
    display: grid;
    grid-template-columns: 58px 1fr;
    gap: 6px;
  }

  .drilldown dt { color: var(--text-3); }
  .drilldown dd { margin: 0; overflow-wrap: anywhere; }

  .thread {
    margin: 2px 0;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .thread-link {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--primary);
    font-size: 11px;
    cursor: pointer;
    text-decoration: underline;
  }

  .inbox-hint {
    margin: 0;
    color: var(--text-2);
    font-size: 11.5px;
  }

  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 60px 16px;
    color: var(--text-3);
    font-size: 13px;
    text-align: center;
  }

  .state.error { color: var(--error); }

  .empty {
    padding: 14px 4px;
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.6;
  }

  @media (max-width: 1100px) {
    .office-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
