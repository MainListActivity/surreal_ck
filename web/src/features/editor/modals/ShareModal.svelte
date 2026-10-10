<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { editorUi } from "../lib/editor-ui.svelte";

  // 分享后端 endpoint 已废弃（CLAUDE.md：不新增后端分享代理）。
  // 链接分享能力不存在，这里只如实说明并提供可用的协作路径（邀请成员入工作区），
  // 不展示任何占位链接或权限选项，避免暗示"可以分享"。
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
      <p class="share-note">
        链接分享暂未开放。若要让同事协作此工作簿，请让工作区管理员通过首页「邀请协作者」
        或「工作区设置 › 成员管理」将其加入当前工作区；加入后即可访问工作区内的工作簿。
      </p>
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

  .share-note {
    margin: 0;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.7;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
