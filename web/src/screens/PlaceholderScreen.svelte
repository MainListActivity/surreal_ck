<script lang="ts">
  import type { Component } from "svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { Info } from "@lucide/svelte";

  // 通用「功能待迁移」占位页：保证 legacy 可见入口不静默消失。
  let {
    icon: iconProp = Info,
    title,
    desc,
    actionLabel = "返回首页",
    onaction,
  }: {
    icon?: Component;
    title: string;
    desc: string;
    actionLabel?: string;
    onaction?: () => void;
  } = $props();
</script>

<section class="placeholder">
  <EmptyState icon={iconProp} {title} {desc} action={actionLabel} onAction={() => onaction?.()} />
</section>

<style>
  .placeholder {
    display: flex;
    flex: 1;
    background: var(--bg);
  }
</style>
