<script lang="ts">
  import Icon from "../../../components/Icon.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";

  let { workbookId }: { workbookId?: string } = $props();

  function close() {
    editorUi.showShare = false;
  }
</script>

<div class="modal-backdrop" role="presentation" onmousedown={close}>
  <div
    class="modal share"
    role="dialog"
    aria-modal="true"
    aria-label="分享工作簿"
    tabindex="-1"
    onmousedown={(event) => event.stopPropagation()}
  >
    <header>
      <strong>分享工作簿</strong>
      <button class="icon-btn" onclick={close}><Icon name="x" size={16} /></button>
    </header>
    <div class="share-body">
      <label>
        <span>链接权限</span>
        <select>
          <option>工作区成员可编辑</option>
          <option>工作区成员只读</option>
          <option>仅指定成员可访问</option>
        </select>
      </label>
      <label>
        <span>共享链接</span>
        <div class="share-link">
          <input value={`surreal_ck://workbook/${workbookId ?? ""}`} readonly />
          <button class="secondary-btn">复制链接</button>
        </div>
      </label>
    </div>
    <footer>
      <button class="secondary-btn" onclick={close}>关闭</button>
    </footer>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    z-index: 100;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, .32);
  }

  .modal {
    max-height: 90vh;
    overflow: hidden;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 16px 48px rgba(0, 0, 0, .18);
  }

  .share {
    width: min(540px, calc(100vw - 32px));
  }

  .modal header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--border);
  }

  .share-body {
    display: grid;
    gap: 16px;
    padding: 18px 20px;
  }

  .share-body label > span {
    display: block;
    margin-bottom: 6px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 550;
  }

  .share-link {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
  }

  input,
  select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 7px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
  }

  .share footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
  }
</style>
