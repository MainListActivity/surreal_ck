<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import * as Command from "$lib/components/ui/command/index.js";
  import { getSurreal } from "../lib/surreal";
  import { referenceCache } from "../lib/reference-cache.svelte";
  import { searchReferenceCandidates } from "../lib/reference-cache";
  import type { RecordIdString, ReferenceTargetPreview } from "@surreal-ck/shared/rpc.types";

  /**
   * 引用记录选择器：触发按钮 + 浮层搜索列表。
   * - 单选：选中即 onChange + onClose
   * - 多选：选中切换；用户点"完成"或外部点击触发 onClose
   *
   * 交互外壳（浮层定位 / 键盘上下回车 / Escape / 外点关闭 / aria）交给 bits-ui
   * Popover + Command；业务内核（搜索直连、按表分组、displayKey 回退、RecordId 边界）
   * 仍走 {@link searchReferenceCandidates} / {@link referenceCache}，原样保留。
   *
   * 搜索结果由服务端过滤（直连 SurrealDB），所以 Command 关闭内置过滤（shouldFilter=false），
   * 直接渲染服务端返回的候选。选中写回的值是 RecordId，validate 由 field-schema 兜底。
   */
  let {
    value = null,
    table,
    displayKey,
    multiple = false,
    onChange,
    onClose,
    disabled = false,
    placeholder = "选择记录",
    openOnMount = false,
    fullWidth = false,
    ariaLabel,
  }: {
    value?: RecordIdString | RecordIdString[] | null;
    table: string;
    displayKey?: string;
    multiple?: boolean;
    onChange: (next: RecordIdString | RecordIdString[] | null) => void;
    onClose?: () => void;
    disabled?: boolean;
    placeholder?: string;
    openOnMount?: boolean;
    fullWidth?: boolean;
    ariaLabel?: string;
  } = $props();

  const selected = $derived<RecordIdString[]>(
    Array.isArray(value) ? value : value ? [value] : [],
  );
  const selectedPreviews = $derived(
    selected.map((id) => referenceCache.get(id) ?? { id, table, primaryLabel: id, missing: false, preview: [] } satisfies ReferenceTargetPreview),
  );

  let open = $state(untrack(() => openOnMount));
  let query = $state("");
  let candidates = $state<ReferenceTargetPreview[]>([]);
  let loading = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  // 让 cache 知道当前 selected ids 需要 resolve（用于显示徽章 label）
  $effect(() => {
    untrack(() => referenceCache.ensure(selected));
  });

  async function runSearch(q: string) {
    loading = true;
    try {
      candidates = await searchReferenceCandidates(getSurreal(), table, {
        query: q,
        displayKey,
        limit: 30,
      });
    } catch {
      candidates = [];
    } finally {
      loading = false;
    }
  }

  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(query.trim()), 160);
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      query = "";
      runSearch("");
    } else {
      onClose?.();
    }
  }

  function toggleCandidate(item: ReferenceTargetPreview) {
    if (multiple) {
      const has = selected.includes(item.id);
      const next = has ? selected.filter((id) => id !== item.id) : [...selected, item.id];
      onChange(next.length ? next : null);
    } else {
      onChange(item.id);
      open = false;
    }
  }

  function removeOne(id: RecordIdString) {
    if (multiple) {
      const next = selected.filter((s) => s !== id);
      onChange(next.length ? next : null);
    } else {
      onChange(null);
    }
  }

  function clearAll() {
    onChange(null);
  }

  // openOnMount：组件挂载即拉首批候选（Popover 初始 open，bits-ui 不会补发 onOpenChange）。
  $effect(() => {
    if (openOnMount) untrack(() => runSearch(""));
  });

  onDestroy(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });
</script>

<div class="record-picker" class:full-width={fullWidth}>
  <Popover.Root bind:open onOpenChange={handleOpenChange}>
    <Popover.Trigger
      class="trigger"
      data-empty={selected.length === 0 ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      {disabled}
      aria-label={ariaLabel}
    >
      {#if selected.length === 0}
        <span class="placeholder">{placeholder}</span>
      {:else}
        <span class="badges">
          {#each selectedPreviews as item, idx (item.id)}
            {#if idx > 0}<span class="sep">,</span>{/if}
            <span class="badge" class:missing={item.missing}>
              {item.primaryLabel}
              {#if !disabled}
                <span
                  class="badge-x"
                  role="button"
                  tabindex="0"
                  aria-label="移除"
                  onclick={(e) => { e.stopPropagation(); removeOne(item.id); }}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      removeOne(item.id);
                    }
                  }}
                >×</span>
              {/if}
            </span>
          {/each}
        </span>
      {/if}
      <Icon name="chevronDown" size={12} />
    </Popover.Trigger>

    <Popover.Content
      class="record-picker-popover"
      align="start"
      sideOffset={4}
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <Command.Root shouldFilter={false} loop label={ariaLabel}>
        <div class="search-row">
          <Command.Input
            bind:value={query}
            placeholder="搜索…"
            oninput={scheduleSearch}
          />
          {#if selected.length > 0}
            <button class="clear-btn" type="button" onclick={clearAll}>清除</button>
          {/if}
        </div>

        <Command.List class="candidates">
          {#if loading}
            <div class="state">加载中…</div>
          {:else}
            <Command.Empty class="state">无匹配记录</Command.Empty>
            {#each candidates as item (item.id)}
              {@const isSelected = selected.includes(item.id)}
              <Command.Item
                value={item.id}
                class="candidate"
                data-selected-record={isSelected ? "" : undefined}
                onSelect={() => toggleCandidate(item)}
              >
                {#if multiple}
                  <span class="check" class:on={isSelected}>
                    {#if isSelected}<Icon name="check" size={12} />{/if}
                  </span>
                {/if}
                <span class="cand-label">{item.primaryLabel}</span>
                {#if item.preview.length > 0}
                  <span class="cand-sub">{item.preview.slice(0, 2).map((p) => `${p.label}: ${p.value ?? ""}`).join(" · ")}</span>
                {/if}
              </Command.Item>
            {/each}
          {/if}
        </Command.List>
      </Command.Root>

      {#if multiple}
        <div class="footer">
          <span class="muted">已选 {selected.length}</span>
          <Popover.Close class="primary-btn">完成</Popover.Close>
        </div>
      {/if}
    </Popover.Content>
  </Popover.Root>
</div>

<style>
  .record-picker {
    display: inline-flex;
    min-width: 0;
    width: 100%;
  }

  .record-picker.full-width {
    width: 100%;
  }

  :global(.trigger) {
    display: flex;
    width: 100%;
    min-height: 32px;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface, #fff);
    color: var(--text-1);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  :global(.trigger:focus-visible) {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }

  :global(.trigger[data-disabled]) {
    opacity: .55;
    cursor: not-allowed;
  }

  .placeholder {
    color: var(--text-3);
    flex: 1;
  }

  .badges {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .sep {
    color: var(--text-3);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 999px;
    background: #eef2ff;
    color: var(--primary);
    font-size: 11px;
    line-height: 1.4;
  }

  .badge.missing {
    background: #fdecec;
    color: var(--error, #e54848);
  }

  .badge-x {
    display: inline-flex;
    width: 14px;
    height: 14px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 50%;
    background: rgba(255, 255, 255, .6);
    color: inherit;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }

  :global(.record-picker-popover) {
    width: 320px;
    max-height: 320px;
    padding: 0;
    overflow: hidden;
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid #edf1f6;
  }

  .clear-btn {
    border: 0;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
    cursor: pointer;
  }

  .clear-btn:hover {
    color: var(--error, #e54848);
  }

  :global(.candidates) {
    overflow: auto;
    max-height: 240px;
    padding: 4px;
  }

  :global(.candidate) {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-1);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  :global(.candidate:hover),
  :global(.candidate[data-selected]),
  :global(.candidate[data-selected-record]) {
    background: #f5f8ff;
    color: var(--primary);
  }

  .check {
    display: inline-flex;
    width: 14px;
    height: 14px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #fff;
  }

  .check.on {
    border-color: var(--primary);
    background: var(--primary);
    color: #fff;
  }

  .cand-label {
    flex: 0 0 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
  }

  .cand-sub {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-3);
    font-size: 11px;
  }

  .state {
    padding: 16px;
    color: var(--text-3);
    font-size: 12px;
    text-align: center;
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-top: 1px solid #edf1f6;
  }

  .footer .muted {
    color: var(--text-3);
    font-size: 11px;
  }

  :global(.primary-btn) {
    padding: 4px 12px;
    border: 0;
    border-radius: 6px;
    background: var(--primary);
    color: #fff;
    font-size: 12px;
    cursor: pointer;
  }
</style>
