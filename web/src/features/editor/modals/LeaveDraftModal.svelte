<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import { editorStore } from "../../../lib/editor-store.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";

  let confirming = $state(false);

  // 可见性由 editorUi.leaveConfirm.open 单向驱动到本地 open；
  // 用户关闭（Escape / 外点）回流到 store。AlertDialog 默认不点遮罩关闭，
  // 但 Escape 仍可触发——交给 cancel()（处理中时阻止）。
  let open = $state(false);
  $effect(() => {
    open = editorUi.leaveConfirm.open;
  });

  function handleOpenChange(next: boolean) {
    if (next) return;
    if (confirming) {
      // 处理中不允许关闭，强制保持打开。
      open = true;
      return;
    }
    editorUi.closeLeaveConfirm();
  }

  function cancel() {
    if (confirming) return;
    editorUi.closeLeaveConfirm();
  }

  async function confirm() {
    if (confirming) return;
    confirming = true;
    try {
      await editorUi.leaveConfirm.confirm?.();
    } finally {
      confirming = false;
    }
  }
</script>

<AlertDialog.Root bind:open onOpenChange={handleOpenChange}>
  <AlertDialog.Content class="leave-draft">
    <AlertDialog.Header>
      <AlertDialog.Title>
        <span class="title-row">
          <span class="warn">
            <Icon name="alertCircle" size={16} />
          </span>
          有未保存的草稿
        </span>
      </AlertDialog.Title>
    </AlertDialog.Header>
    <p class="body">
      当前工作簿中还有 <strong>{editorUi.leaveConfirm.draftCount}</strong> 条尚未填写完整的草稿记录。
      离开前会先保存已经填写完整的草稿，仍不完整的草稿将被丢弃。
    </p>
    {#if editorStore.saveError}
      <p class="error">{editorStore.saveError}</p>
    {/if}
    <footer>
      <button class="secondary-btn" onclick={cancel} disabled={confirming}>留在工作簿</button>
      <button class="danger-btn" onclick={confirm} disabled={confirming}>
        {confirming ? "处理中…" : "保存完整草稿并离开"}
      </button>
    </footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<style>
  :global(.leave-draft) {
    width: min(420px, calc(100vw - 32px));
    max-width: min(420px, calc(100vw - 32px));
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    color: var(--text-1);
  }

  .warn {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--warning-bg);
    color: var(--warning);
  }

  .body {
    margin: 0;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.6;
  }

  .body strong {
    color: var(--warning);
    font-weight: 700;
    margin: 0 2px;
  }

  .error {
    margin: 0;
    color: var(--error);
    font-size: 12px;
    line-height: 1.5;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  footer button {
    height: 32px;
    padding: 0 16px;
  }

  .danger-btn {
    border: 0;
    border-radius: 7px;
    background: var(--error);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
  }

  .danger-btn:hover {
    background: #dd2e2e;
  }

  footer button:disabled {
    opacity: .6;
    cursor: wait;
  }
</style>
