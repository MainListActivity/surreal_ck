<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import { editorStore } from "../../../lib/editor.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";

  let confirming = $state(false);

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

<div class="modal-backdrop" role="presentation" onmousedown={cancel}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="未保存草稿确认"
    tabindex="-1"
    onmousedown={(event) => event.stopPropagation()}
  >
    <header>
      <span class="warn">
        <Icon name="alertCircle" size={16} />
      </span>
      <strong>有未保存的草稿</strong>
    </header>
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
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    z-index: 200;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, .32);
  }

  .modal {
    width: min(420px, calc(100vw - 32px));
    overflow: hidden;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 16px 48px rgba(0, 0, 0, .18);
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 18px 20px 6px;
  }

  header strong {
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
    margin: 4px 20px 18px;
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
    margin: -6px 20px 14px;
    color: var(--error);
    font-size: 12px;
    line-height: 1.5;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
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
