<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "../../components/Icon.svelte";

  let {
    title,
    subtitle = "",
    onEdit,
    onRemove,
    children,
  }: {
    title: string;
    subtitle?: string;
    onEdit?: () => void;
    onRemove?: () => void;
    children?: Snippet;
  } = $props();
</script>

<section class="frame">
  <header class="frame-head">
    <div>
      <strong>{title}</strong>
      {#if subtitle}
        <span>{subtitle}</span>
      {/if}
    </div>
    <div class="actions">
      {#if onEdit}
        <button class="ghost" title="编辑视图" onclick={onEdit}>
          <Icon name="edit" size={14} />
        </button>
      {/if}
      {#if onRemove}
        <button class="ghost" title="移除组件" onclick={onRemove}>
          <Icon name="trash" size={14} />
        </button>
      {/if}
    </div>
  </header>
  <div class="frame-body">
    {@render children?.()}
  </div>
</section>

<style>
  .frame {
    display: flex;
    min-height: 0;
    flex-direction: column;
    border: 1px solid rgba(219, 226, 236, .95);
    border-radius: 18px;
    background: rgba(255, 255, 255, .98);
    box-shadow: 0 16px 38px rgba(15, 23, 42, .08);
    overflow: hidden;
  }

  .frame-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 18px 10px;
    border-bottom: 1px solid rgba(229, 230, 235, .8);
  }

  .frame-head strong {
    display: block;
    color: var(--text-1);
    font-size: 14px;
  }

  .frame-head span {
    color: var(--text-3);
    font-size: 11px;
  }

  .frame-body {
    min-height: 0;
    flex: 1;
    padding: 16px 18px 18px;
  }

  .actions {
    display: flex;
    gap: 4px;
  }

  .ghost {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }

  .ghost:hover {
    background: var(--soft);
    color: var(--text-1);
  }
</style>
