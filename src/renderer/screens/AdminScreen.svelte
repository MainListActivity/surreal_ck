<script lang="ts">
  import Avatar from "../components/Avatar.svelte";
  import Badge from "../components/Badge.svelte";
  import Icon from "../components/Icon.svelte";
  import { members } from "../lib/mock";
  import type { Navigate } from "../lib/types";

  let { navigate }: { navigate: Navigate } = $props();
  let tab = $state("members");

  const tabs = [
    { id: "members", icon: "users", label: "成员管理" },
    { id: "entities", icon: "tag", label: "实体类型" },
    { id: "relations", icon: "network", label: "关系类型" },
    { id: "forms", icon: "globe", label: "表单配置" },
  ];
</script>

<section class="admin">
  <aside>
    <div class="title">工作区设置</div>
    {#each tabs as item}
      <button class:selected={tab === item.id} onclick={() => (tab = item.id)}><Icon name={item.icon} size={15} />{item.label}</button>
    {/each}
  </aside>

  <div class="main">
    {#if tab === "members"}
      <header><h2>成员管理</h2><button class="primary-btn"><Icon name="plus" size={13} color="#fff" />邀请成员</button></header>
      {#each members as member}
        <div class="member">
          <Avatar name={member.name} size={36} />
          <div><strong>{member.name}</strong><span>{member.email}</span></div>
          <Badge value={member.status} />
          <select value={member.role}><option>管理员</option><option>编辑</option><option>查看</option></select>
          <button class="icon-btn"><Icon name="moreH" size={15} /></button>
        </div>
      {/each}
    {:else if tab === "forms"}
      <header><h2>表单配置</h2><button class="primary-btn"><Icon name="plus" size={13} color="#fff" />新建表单</button></header>
      {#each ["债权申报登记表", "资料补充收集表"] as form, index}
        <div class="form-row">
          <span><Icon name="globe" size={17} color="var(--primary)" /></span>
          <div><strong>{form}</strong><small>已发布 · 累计提交 {index === 0 ? 47 : 12} 份</small></div>
          <button class="secondary-btn" onclick={() => navigate("form")}>查看表单</button>
          <button class="secondary-btn">复制链接</button>
        </div>
      {/each}
    {:else}
      <h2>{tab === "entities" ? "实体类型" : "关系类型"}</h2>
      <div class="chips">
        {#each (tab === "entities" ? ["自然人债权人", "企业债权人", "担保方", "关联方", "资产"] : ["债权-债务", "担保", "股权持有", "实际控制", "关联交易"]) as item}
          <button><Icon name={tab === "entities" ? "tag" : "link"} size={13} />{item}<Icon name="edit" size={12} /></button>
        {/each}
        <button class="dashed"><Icon name="plus" size={13} />添加{tab === "entities" ? "类型" : "关系"}</button>
      </div>
    {/if}
  </div>
</section>

<style>
  .admin {
    display: flex;
    flex: 1;
    overflow: hidden;
    background: var(--bg);
  }

  aside {
    width: 200px;
    flex-shrink: 0;
    padding: 16px 8px;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .title {
    padding: 0 8px 10px;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .6px;
  }

  aside button {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 9px;
    padding: 8px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
  }

  aside button:hover {
    background: var(--bg);
  }

  aside button.selected {
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .main {
    flex: 1;
    overflow: auto;
    padding: 28px 32px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  h2 {
    margin: 0 0 20px;
    color: var(--text-1);
    font-size: 16px;
  }

  header h2 {
    margin: 0;
  }

  header button {
    padding: 8px 14px;
  }

  .member {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }

  .member div:nth-child(2),
  .form-row div {
    min-width: 0;
    flex: 1;
  }

  strong,
  .member span,
  small {
    display: block;
  }

  strong {
    color: var(--text-1);
    font-size: 13px;
  }

  .member span,
  small {
    color: var(--text-3);
    font-size: 11px;
  }

  select {
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
  }

  .form-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
  }

  .form-row > span {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border-radius: 8px;
    background: var(--primary-light);
  }

  .form-row button {
    padding: 6px 12px;
    font-size: 12px;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .chips button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 13px;
  }

  .chips .dashed {
    border-style: dashed;
    color: var(--text-3);
  }
</style>
