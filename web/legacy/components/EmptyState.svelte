<script lang="ts">
  import Icon from "./Icon.svelte";

  let {
    icon = "info",
    title,
    desc = "",
    action = "",
    onAction,
  }: {
    icon?: string;
    title: string;
    desc?: string;
    action?: string;
    onAction?: () => void;
  } = $props();
</script>

<div class="empty-state">
  <span class="empty-icon"><Icon name={icon} size={26} color="var(--text-3)" /></span>
  <strong>{title}</strong>
  {#if desc}<p>{desc}</p>{/if}
  {#if action}<button class="primary-btn" onclick={onAction}>{action}</button>{/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 56px 24px;
    text-align: center;
  }

  .empty-icon {
    display: grid;
    width: 56px;
    height: 56px;
    place-items: center;
    border-radius: 16px;
    background: var(--bg);
  }

  strong {
    margin-top: 16px;
    color: var(--text-1);
    font-size: 15px;
  }

  p {
    max-width: 320px;
    margin: 8px 0 0;
    color: var(--text-3);
    font-size: 13px;
    line-height: 1.6;
  }

  button {
    margin-top: 20px;
    padding: 8px 20px;
  }
</style>
