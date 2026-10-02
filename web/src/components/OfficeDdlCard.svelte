<script lang="ts">
  import { getSurreal } from "../lib/surreal";
  import { isWorkspaceAdmin } from "../lib/permissions.svelte";
  import { readOfficeDdl, decideOfficeDdl, reconcileOfficeDdl, type OfficeDdlIntent } from "../lib/office-ddl";
  import { DDL_TERMINAL } from "@surreal-ck/shared/office-ddl";

  let { id, onresolved }: { id: string; onresolved?: () => Promise<void> } = $props();
  let intent = $state<OfficeDdlIntent | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let generation = 0;
  const admin = $derived(isWorkspaceAdmin());
  const labels: Record<OfficeDdlIntent["status"], string> = {
    requested: "待管理员确认", approved: "已确认，待执行", executing: "执行中，等待持久结果",
    succeeded: "执行成功", rejected: "已拒绝", failed: "执行失败",
    ambiguous: "结果待核对", reconciled: "已核对，旧执行已封闭",
  };
  // 每个请求绑定打开时的连接；卸载/换 workspace 后迟到结果不更新新界面。
  $effect(() => {
    const target = id;
    generation += 1;
    busy = false;
    const conn = getSurreal();
    let disposed = false;
    let stop: (() => void) | undefined;
    intent = null;
    error = null;
    const refresh = async () => {
      try {
        const next = await readOfficeDdl(conn, target);
        if (!disposed) intent = next;
      } catch (cause) {
        if (!disposed) error = cause instanceof Error ? cause.message : String(cause);
      }
    };
    const connected = conn.subscribe("connected", () => void refresh());
    void conn.liveTable("office_ddl_intent", () => void refresh()).then((unsubscribe) => {
      if (disposed) unsubscribe(); else stop = unsubscribe;
    }).catch((cause: unknown) => {
      if (!disposed) error = cause instanceof Error ? cause.message : String(cause);
    });
    void refresh();
    return () => { disposed = true; stop?.(); connected(); };
  });

  async function act(action: "approve" | "reject" | "reconcile") {
    if (!intent || busy) return;
    if (action === "approve" && !window.confirm("确认按显示的结构变更执行？不会覆盖已有定义。")) return;
    busy = true;
    error = null;
    const target = id;
    const conn = getSurreal();
    const started = generation;
    try {
      const next = action === "reconcile"
        ? await reconcileOfficeDdl(conn, target)
        : await decideOfficeDdl(conn, target, action);
      if (started !== generation || target !== id || conn !== getSurreal()) return;
      intent = next;
      if (DDL_TERMINAL.has(next.status)) await onresolved?.();
    } catch (cause) {
      if (started === generation) error = cause instanceof Error ? cause.message : String(cause);
    } finally { if (started === generation) busy = false; }
  }
</script>

<section aria-label="结构变更审批">
  {#if intent}
    <strong>{labels[intent.status]}</strong>
    <p>理由：{intent.rationale}</p>
    <p>预期影响：{intent.impact}</p>
    <pre aria-label="实际结构变更">{intent.sql}</pre>
    {#if intent.result}<p>持久结果：{String(intent.result.message ?? intent.result.outcome ?? "")}</p>{/if}
    {#if admin && (intent.status === "requested" || intent.status === "approved")}
      <button disabled={busy} onclick={() => void act("approve")}>确认并执行</button>
      <button disabled={busy} onclick={() => void act("reject")}>拒绝变更</button>
    {:else if admin && (intent.status === "executing" || intent.status === "ambiguous")}
      <p>刷新不会重复执行。可核对事务结果并封闭未完成的执行；仍需变更时请分析师提出新请求。</p>
      <button disabled={busy} onclick={() => void act("reconcile")}>核对持久结果</button>
    {:else if !admin}
      <p>仅当前工作区管理员可以确认或执行。</p>
    {/if}
  {:else if !error}<p>正在读取结构变更…</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  section { display: grid; gap: 6px; }
  p { margin: 0; overflow-wrap: anywhere; }
  pre { margin: 0; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--soft); }
  button { padding: 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--text-1); cursor: pointer; }
  [role="alert"] { color: var(--error); }
</style>
