<script lang="ts">
  import { onDestroy } from "svelte";
  import { CircleAlert, FileSpreadsheet, Rocket, SkipForward, UserPlus } from "@lucide/svelte";
  import CsvImportDialog from "./CsvImportDialog.svelte";
  import XlsxImportDialog from "./XlsxImportDialog.svelte";
  import { getSurreal, type SurrealConn } from "../lib/surreal";
  import { parseCsvImport, type ParsedCsvImport } from "../lib/csv-import";
  import { createXlsxParseTask } from "../lib/xlsx-parse-task";
  import type { ParsedXlsxImport } from "../lib/xlsx-import";
  import { api } from "../lib/api";
  import {
    createAssignedTask,
    diagnoseStall,
    dispatchTask,
    loadBootstrapTrigger,
    loadEmployeeStatusByRole,
    loadOnboardingState,
    provisionOfficeEmployee,
    resolveImport,
    saveOnboardingGoal,
    submitBootstrap,
    STALL_CAUSE_LABELS,
    type ApiLike,
    type OnboardingState,
    type StallDiagnosis,
  } from "../lib/office-onboarding";

  /**
   * VO06 onboarding 面板：目标保存 → 导入/skip → 幂等 bootstrap → 进度/首报
   * 监视 → 分析师开岗与分析任务派发。状态完全从 db 推导（loadOnboardingState），
   * 刷新/断线/换 workspace 后回到同一进度；重复提交由稳定幂等键兜底。
   */
  let {
    slug,
    hasReport,
    hasInitialTask,
    analystId,
    isAdmin,
  }: {
    slug: string;
    hasReport: boolean;
    hasInitialTask: boolean;
    analystId: string | null;
    isAdmin: boolean;
  } = $props();

  const conn: SurrealConn = getSurreal();
  const officeApi = api as unknown as ApiLike;

  let onboard = $state<OnboardingState | null>(null);
  let goalDraft = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let stall = $state<StallDiagnosis | null>(null);
  let bootstrappedAt = $state<number | null>(null);
  let csvImport = $state<ParsedCsvImport | null>(null);
  let xlsxImport = $state<ParsedXlsxImport | null>(null);
  let importNotice = $state<string | null>(null);
  let analysisGoal = $state("");
  let analysisTable = $state("");
  let fileInput = $state<HTMLInputElement | null>(null);

  const phase = $derived(onboard?.phase ?? "meta");
  const showOnboarding = $derived(isAdmin && phase !== "active");

  async function refresh(): Promise<void> {
    try {
      onboard = await loadOnboardingState(conn);
      if (onboard.meta?.goal && !goalDraft) goalDraft = onboard.meta.goal;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  $effect(() => {
    void slug;
    goalDraft = "";
    error = null;
    stall = null;
    bootstrappedAt = null;
    importNotice = null;
    void refresh();
  });

  // 进度/报告监视：bootstrap 提交后 30s 无活动 → 诊断停滞根因；
  // 5min 无报告 → 同一诊断通道给"报告超时"分级。快照驱动的 effect 在
  // hasInitialTask / hasReport 变化时自然复位。
  $effect(() => {
    if (phase !== "active" || !isAdmin) return;
    if (hasReport) {
      stall = null;
      return;
    }
    const started = bootstrappedAt ?? Date.now();
    const timers = [
      setTimeout(() => void checkStall(started), 30_000),
      setTimeout(() => void checkStall(started), 300_000),
    ];
    return () => timers.forEach(clearTimeout);
  });

  async function checkStall(since: number): Promise<void> {
    try {
      const [trigger, managerStatus] = await Promise.all([
        loadBootstrapTrigger(conn),
        loadEmployeeStatusByRole(conn, "project-manager"),
      ]);
      stall = diagnoseStall({
        trigger,
        employeeStatus: managerStatus,
        elapsedMs: Date.now() - since,
      });
    } catch {
      stall = { cause: "database", detail: "无法读取运行时状态（连接异常）" };
    }
  }

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = null;
    try {
      await action();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      await refresh();
    }
  }

  const saveGoal = () =>
    run(async () => {
      if (!goalDraft.trim()) {
        error = "请先填写办公室目标";
        return;
      }
      await saveOnboardingGoal(conn, goalDraft);
    });

  const skipImport = () => run(() => resolveImport(conn, "skipped"));

  async function pickImportFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!/\.(?:csv|xls|xlsx)$/iu.test(file.name)) {
      importNotice = "请选择 .csv、.xls 或 .xlsx 文件";
      return;
    }
    importNotice = null;
    try {
      if (/\.(?:xlsx|xls)$/iu.test(file.name)) {
        xlsxImport = await createXlsxParseTask(file).promise;
        return;
      }
      csvImport = parseCsvImport(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()), file.name);
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") return;
      importNotice = `解析失败：${cause instanceof Error ? cause.message : String(cause)}`;
      await resolveImport(conn, "failed");
      await refresh();
    }
  }

  /**
   * 导入对话框关闭后按最新 import_batch 决议：completed/partial_failure →
   * imported（部分成功数据仍可用）；failed → failed（可重试）；processing /
   * 无批 → 保持未决议，不推进门禁也不误显示开岗成功。
   */
  async function settleImport(): Promise<void> {
    const rows = await conn.query<{ status?: unknown }>(
      "SELECT status FROM import_batch ORDER BY created_at DESC LIMIT 1;",
    );
    const status = rows[0]?.status;
    if (status === "completed" || status === "partial_failure") {
      await resolveImport(conn, "imported");
      importNotice = status === "partial_failure" ? "导入部分成功，失败行可稍后重导" : "导入完成";
    } else if (status === "failed" || status === "outcome_unknown") {
      await resolveImport(conn, "failed");
      importNotice = "导入未完成，可重新选择文件或直接跳过";
    }
    await refresh();
  }

  const submitOffice = () =>
    run(async () => {
      const outcome = await submitBootstrap(officeApi, slug);
      if (!outcome.ok) {
        error = outcome.missing?.length
          ? `${outcome.message}（回到上一步补齐后再试）`
          : outcome.message;
        return;
      }
      bootstrappedAt = Date.now();
      stall = null;
    });

  const hireAnalyst = () =>
    run(async () => {
      const outcome = await provisionOfficeEmployee(officeApi, slug, "data-analyst", "数据分析师");
      if (!outcome.ok) error = outcome.message;
    });

  const assignAnalysis = () =>
    run(async () => {
      if (!analystId || !analysisGoal.trim() || !analysisTable.trim()) {
        error = "需要分析目标与数据表名";
        return;
      }
      const taskId = await createAssignedTask(conn, {
        assigneeId: analystId,
        goal: analysisGoal.trim(),
        brief: { analysis: { table: analysisTable.trim() } },
      });
      const dispatched = await dispatchTask(officeApi, slug, taskId);
      if (!dispatched.ok) error = dispatched.message ?? "派发失败";
      analysisGoal = "";
      analysisTable = "";
    });

  onDestroy(() => undefined);
</script>

{#if showOnboarding}
  <section class="onboarding" data-testid="office-onboarding">
    <header>
      <Rocket size={16} />
      <strong>办公室引导</strong>
      <span class="step">
        {#if phase === "meta"}1/3 目标{:else if phase === "import"}2/3 数据导入{:else}3/3 启动{/if}
      </span>
    </header>

    {#if phase === "meta"}
      <label class="field">
        <span>办公室目标（保存后登记你为第一位联系人）</span>
        <input bind:value={goalDraft} placeholder="例如：按月梳理债权风险清单" disabled={busy} />
      </label>
      <button type="button" class="primary" disabled={busy || !goalDraft.trim()} onclick={() => void saveGoal()}>
        保存目标
      </button>
    {:else if phase === "import"}
      <p class="hint">可先导入现有 Excel/CSV 数据，也可以直接跳过。</p>
      {#if onboard?.meta?.importState === "failed"}
        <p class="warn"><CircleAlert size={14} /> 上次导入失败，可重试或跳过。</p>
      {/if}
      {#if importNotice}<p class="hint">{importNotice}</p>{/if}
      <div class="actions">
        <button type="button" disabled={busy} onclick={() => fileInput?.click()}>
          <FileSpreadsheet size={14} /> 选择文件导入
        </button>
        <button type="button" disabled={busy} onclick={() => void skipImport()}>
          <SkipForward size={14} /> 跳过导入
        </button>
      </div>
      <input
        bind:this={fileInput}
        type="file"
        accept=".csv,.xls,.xlsx"
        hidden
        onchange={(event) => void pickImportFile(event)}
      />
    {:else}
      <p class="hint">目标与导入决议已就绪。启动后项目经理会承接初始任务并产出首份报告。</p>
      <button type="button" class="primary" disabled={busy} onclick={() => void submitOffice()}>
        <Rocket size={14} /> 启动办公室
      </button>
    {/if}

    {#if error}<p class="error">{error}</p>{/if}
  </section>
{/if}

{#if isAdmin && phase === "active" && !hasReport && stall}
  <p class="error stall" data-testid="onboarding-stall">
    等待超时——疑似{STALL_CAUSE_LABELS[stall.cause]}问题：{stall.detail}
  </p>
{/if}

{#if isAdmin && phase === "active" && hasReport}
  <section class="onboarding analyst" data-testid="analyst-continuation">
    <header><UserPlus size={16} /><strong>继续建设</strong></header>
    {#if !analystId}
      <button type="button" disabled={busy} onclick={() => void hireAnalyst()}>
        <UserPlus size={14} /> 开岗数据分析师
      </button>
    {:else}
      <div class="fields">
        <input bind:value={analysisGoal} placeholder="分析任务目标" disabled={busy} />
        <input bind:value={analysisTable} placeholder="数据表名（如 ent_债权清单）" disabled={busy} />
        <button
          type="button"
          class="primary"
          disabled={busy || !analysisGoal.trim() || !analysisTable.trim()}
          onclick={() => void assignAnalysis()}
        >派发分析任务</button>
      </div>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
  </section>
{/if}

{#if csvImport}
  <CsvImportDialog parsed={csvImport} onclose={() => { csvImport = null; void settleImport(); }} />
{/if}
{#if xlsxImport}
  <XlsxImportDialog parsed={xlsxImport} onclose={() => { xlsxImport = null; void settleImport(); }} />
{/if}

<style>
  .onboarding {
    border: 1px solid var(--border, #2a2f3a);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 14px;
    display: grid;
    gap: 10px;
  }
  .onboarding header { display: flex; align-items: center; gap: 8px; }
  .step { margin-left: auto; font-size: 12px; opacity: 0.6; }
  .field { display: grid; gap: 6px; font-size: 13px; }
  .field input, .fields input {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border, #2a2f3a);
    background: transparent;
    color: inherit;
  }
  .actions { display: flex; gap: 10px; }
  .fields { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 8px;
    border: 1px solid var(--border, #2a2f3a);
    background: transparent; color: inherit; cursor: pointer;
  }
  button.primary { background: var(--accent, #4f7cff); border-color: transparent; color: #fff; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .hint { font-size: 13px; opacity: 0.7; margin: 0; }
  .warn { font-size: 13px; color: #e0a33e; margin: 0; display: flex; gap: 6px; align-items: center; }
  .error { font-size: 13px; color: #e06c6c; margin: 0; }
  .stall { padding: 8px 0; }
</style>
