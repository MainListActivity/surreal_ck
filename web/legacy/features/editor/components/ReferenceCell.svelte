<script lang="ts">
  import { onDestroy } from "svelte";
  import { mount, unmount } from "svelte";
  import { referenceCache } from "../../../lib/reference-cache.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";
  import ReferenceCard from "../../../components/ReferenceCard.svelte";
  import type { RecordIdString } from "../../../../shared/rpc.types";

  /**
   * 表格单元格内的引用展示：逗号分隔的可点击徽章。
   * - hover 600ms 后展示 ReferenceCard 浮窗
   * - 点击徽章打开右侧引用详情侧栏
   */
  let {
    ids,
  }: {
    ids: RecordIdString[];
  } = $props();

  $effect(() => {
    referenceCache.ensure(ids);
  });

  const previews = $derived(
    ids.map((id) => referenceCache.get(id) ?? null),
  );

  let hoverId = $state<RecordIdString | null>(null);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let cardApp: ReturnType<typeof mount> | null = null;

  function showCard(id: RecordIdString, x: number, y: number) {
    disposeCard();
    cardApp = mount(ReferenceCard, {
      target: document.body,
      props: { id, x, y },
    });
  }

  function disposeCard() {
    if (cardApp) {
      unmount(cardApp);
      cardApp = null;
    }
  }

  function onEnter(event: MouseEvent, id: RecordIdString) {
    if (hoverTimer) clearTimeout(hoverTimer);
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    hoverTimer = setTimeout(() => {
      hoverId = id;
      let left = rect.left;
      let top = rect.bottom + 6;
      if (left + 300 > window.innerWidth) left = window.innerWidth - 308;
      if (top + 180 > window.innerHeight) top = rect.top - 186;
      showCard(id, Math.max(8, left), Math.max(8, top));
    }, 600);
  }

  function onLeave() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverId = null;
    disposeCard();
  }

  function onClick(event: MouseEvent, id: RecordIdString) {
    event.stopPropagation();
    event.preventDefault();
    onLeave();
    editorUi.openReferencePanel(id);
    editorUi.openPanel("detail");
  }

  onDestroy(() => {
    if (hoverTimer) clearTimeout(hoverTimer);
    disposeCard();
  });
</script>

<span class="ref-cell">
  {#each ids as id, idx (id)}
    {#if idx > 0}<span class="sep">,</span>{/if}
    {@const item = previews[idx]}
    <button
      type="button"
      class="badge"
      class:missing={item?.missing}
      class:loading={item == null}
      onmouseenter={(e) => onEnter(e, id)}
      onmouseleave={onLeave}
      onclick={(e) => onClick(e, id)}
    >
      {item?.primaryLabel ?? id}
    </button>
  {/each}
</span>

<style>
  .ref-cell {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    width: 100%;
    min-width: 0;
    padding: 2px 0;
  }

  .sep {
    color: var(--text-3);
    font-size: 11px;
  }

  .badge {
    max-width: 100%;
    overflow: hidden;
    padding: 2px 8px;
    border: 0;
    border-radius: 999px;
    background: #eef2ff;
    color: var(--primary, #2563eb);
    font-size: 11px;
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .badge:hover {
    background: #dbe5ff;
  }

  .badge.missing {
    background: #fdecec;
    color: var(--error, #e54848);
  }

  .badge.loading {
    background: #f1f3f7;
    color: var(--text-3);
  }
</style>
