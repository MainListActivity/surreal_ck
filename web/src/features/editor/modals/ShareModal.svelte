<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import SelectMenu from "../../../components/SelectMenu.svelte";
  import { editorUi } from "../lib/editor-ui.svelte";

  // 分享后端 endpoint 已废弃（CLAUDE.md：不新增后端分享代理）。
  // 本弹窗为纯前端 stub：展示一个本地链接占位 + 权限选择，不发起任何网络请求。
  let { workbookId }: { workbookId?: string } = $props();
  let permission = $state("member_edit");

  const permissionOptions = [
    { value: "member_edit", label: "工作区成员可编辑" },
    { value: "member_read", label: "工作区成员只读" },
    { value: "invite_only", label: "仅指定成员可访问" },
  ];

  // 可见性由 editorUi.showShare 单向驱动到本地 open；用户关闭回流到 store。
  let open = $state(false);
  $effect(() => {
    open = editorUi.showShare;
  });

  function handleOpenChange(next: boolean) {
    editorUi.showShare = next;
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="share">
    <Dialog.Header>
      <Dialog.Title>分享工作簿</Dialog.Title>
    </Dialog.Header>
    <div class="share-body">
      <label>
        <span>链接权限</span>
        <SelectMenu value={permission} options={permissionOptions} ariaLabel="链接权限" onChange={(next) => (permission = next)} />
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
      <button class="secondary-btn" onclick={() => (editorUi.showShare = false)}>关闭</button>
    </footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  :global(.share) {
    width: min(540px, calc(100vw - 32px));
    max-width: min(540px, calc(100vw - 32px));
  }

  .share-body {
    display: grid;
    gap: 16px;
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

  input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 7px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
