<script lang="ts">
  import EmptyState from "../components/EmptyState.svelte";

  // 通用「功能待迁移」占位页：保证 legacy 可见入口不静默消失。
  // 这些页（模板 / 仪表盘 / 工作区设置 / 个人设置 / 回收站 / 公开表单）原依赖已废弃的
  // legacy appApi / desktop RPC，新架构尚未补；入口保留并给出明确占位与后续归属。
  let {
    icon = "info",
    title,
    desc,
    actionLabel = "返回首页",
    onaction,
  }: {
    icon?: string;
    title: string;
    desc: string;
    actionLabel?: string;
    onaction?: () => void;
  } = $props();
</script>

<section class="placeholder">
  <EmptyState {icon} {title} {desc} action={actionLabel} onAction={() => onaction?.()} />
</section>

<style>
  .placeholder {
    display: flex;
    flex: 1;
    background: var(--bg);
  }
</style>
