<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { appApi } from "../lib/app-api";
  import { referenceCache } from "../lib/reference-cache.svelte";
  import type { RecordIdString, ReferenceTargetPreview } from "../../shared/rpc.types";

  /**
   * 引用记录选择器：触发按钮 + 浮层搜索列表。
   * - 单选：选中即 onChange + onClose
   * - 多选：选中切换；用户点"完成"或外部点击触发 onClose
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

  let open = $state(false);
  let query = $state("");
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let popoverEl = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let popoverPos = $state<{ left: number; top: number; width: number }>({ left: 0, top: 0, width: 320 });
  let candidates = $state<ReferenceTargetPreview[]>([]);
  let loading = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  // 让 cache 知道当前 selected ids 需要 resolve（用于显示徽章 label）
  $effect(() => {
    untrack(() => referenceCache.ensure(selected));
  });

  function portal(node: HTMLElement) {
    const preventDefault = (event: Event) => event.preventDefault();
    document.body.appendChild(node);
    node.addEventListener("mouseup", preventDefault);
    node.addEventListener("touchend", preventDefault);
    return {
      destroy() {
        node.removeEventListener("mouseup", preventDefault);
        node.removeEventListener("touchend", preventDefault);
        if (node.parentNode === document.body) document.body.removeChild(node);
      },
    };
  }

  function recalcPosition() {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    popoverPos = {
      left: rect.left,
      top: rect.bottom + 4,
      width: Math.max(rect.width, 320),
    };
  }

  async function runSearch(q: string) {
    loading = true;
    try {
      const res = await appApi.searchReferenceCandidates(table, {
        query: q,
        displayKey,
        limit: 30,
      });
      if (res.ok) {
        candidates = res.data.items;
      } else {
        candidates = [];
      }
    } finally {
      loading = false;
    }
  }

  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(query.trim()), 160);
  }

  function openPopover() {
    if (disabled || open) return;
    open = true;
    recalcPosition();
    queueMicrotask(() => inputEl?.focus());
    runSearch("");
  }

  function closePopover() {
    if (!open) return;
    open = false;
    onClose?.();
  }

  function toggleCandidate(item: ReferenceTargetPreview) {
    if (multiple) {
      const has = selected.includes(item.id);
      const next = has ? selected.filter((id) => id !== item.id) : [...selected, item.id];
      onChange(next.length ? next : null);
    } else {
      onChange(item.id);
      closePopover();
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

  function onDocClick(event: MouseEvent) {
    if (!open) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (popoverEl?.contains(target)) return;
    if (triggerEl?.contains(target)) return;
    closePopover();
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePopover();
    }
  }

  $effect(() => {
    if (openOnMount) openPopover();
  });

  $effect(() => {
    if (!open) return;
    document.addEventListener("mousedown", onDocClick, true);
    window.addEventListener("resize", recalcPosition);
    window.addEventListener("scroll", recalcPosition, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick, true);
      window.removeEventListener("resize", recalcPosition);
      window.removeEventListener("scroll", recalcPosition, true);
    };
  });

  onDestroy(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });
</script>

<div class="record-picker" class:full-width={fullWidth}>
  <div
    bind:this={triggerEl}
    class="trigger"
    class:empty={selected.length === 0}
    class:disabled
    role="button"
    tabindex={disabled ? -1 : 0}
    aria-label={ariaLabel}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-disabled={disabled}
    onclick={openPopover}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPopover();
      } else {
        onKey(e);
      }
    }}
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
  </div>
</div>

{#if open}
  <div
    use:portal
    bind:this={popoverEl}
    class="popover"
    role="dialog"
    tabindex="-1"
    style={`left:${popoverPos.left}px; top:${popoverPos.top}px; width:${popoverPos.width}px;`}
    onkeydown={onKey}
  >
    <div class="search-row">
      <Icon name="search" size={14} />
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        placeholder="搜索…"
        oninput={scheduleSearch}
      />
      {#if selected.length > 0}
        <button class="clear-btn" type="button" onclick={clearAll}>清除</button>
      {/if}
    </div>

    <div class="candidates" role="listbox">
      {#if loading}
        <div class="empty">加载中…</div>
      {:else if candidates.length === 0}
        <div class="empty">无匹配记录</div>
      {:else}
        {#each candidates as item (item.id)}
          {@const isSelected = selected.includes(item.id)}
          <button
            type="button"
            class="candidate"
            class:selected={isSelected}
            role="option"
            aria-selected={isSelected}
            onclick={() => toggleCandidate(item)}
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
          </button>
        {/each}
      {/if}
    </div>

    {#if multiple}
      <div class="footer">
        <span class="muted">已选 {selected.length}</span>
        <button type="button" class="primary-btn" onclick={closePopover}>完成</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .record-picker {
    display: inline-flex;
    min-width: 0;
    width: 100%;
  }

  .record-picker.full-width {
    width: 100%;
  }

  .trigger {
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

  .trigger:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }

  .trigger.disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .trigger.empty .placeholder {
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

  .popover {
    position: fixed;
    z-index: 80;
    display: flex;
    flex-direction: column;
    max-height: 320px;
    border: 1px solid #dfe4ee;
    border-radius: 10px;
    background: rgba(255, 255, 255, .98);
    box-shadow: 0 18px 42px rgba(15, 23, 42, .16);
    backdrop-filter: blur(12px);
  }

  .search-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid #edf1f6;
  }

  .search-row input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #fbfbfc;
    font-size: 12px;
    outline: none;
  }

  .search-row input:focus {
    border-color: var(--primary);
    background: var(--surface);
    box-shadow: 0 0 0 3px var(--primary-light);
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

  .candidates {
    overflow: auto;
    padding: 4px;
  }

  .candidate {
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

  .candidate:hover,
  .candidate.selected {
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

  .empty {
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

  .primary-btn {
    padding: 4px 12px;
    border: 0;
    border-radius: 6px;
    background: var(--primary);
    color: #fff;
    font-size: 12px;
    cursor: pointer;
  }
</style>
