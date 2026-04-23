<script lang="ts">
  import EmptyState from "../components/EmptyState.svelte";
  import type { Navigate, ScreenId } from "../lib/types";

  let { kind, navigate }: { kind: ScreenId; navigate: Navigate } = $props();
</script>

<section class="state">
  {#if kind === "state-empty"}
    <EmptyState icon="spreadsheet" title="欢迎使用 surreal_ck" desc="还没有工作簿。创建您的第一个工作簿，开始债权申报管理工作。" action="新建文档" onAction={() => navigate("home")} />
  {:else if kind === "state-offline"}
    <EmptyState icon="wifiOff" title="连接已断开" desc="网络连接已中断，您可以继续查看本地缓存内容。重新连接后数据将自动同步。" action="返回首页" onAction={() => navigate("home")} />
  {:else}
    <EmptyState icon="lock" title="无权限访问" desc="您没有查看此工作簿的权限。如需访问，请联系工作区管理员申请授权。" action="返回首页" onAction={() => navigate("home")} />
  {/if}
</section>

<style>
  .state {
    display: flex;
    flex: 1;
    background: #fafbfc;
  }
</style>
