<script lang="ts">
  import Avatar from "../components/Avatar.svelte";
  import Badge from "../components/Badge.svelte";
  import Icon from "../components/Icon.svelte";
  import SelectMenu from "../components/SelectMenu.svelte";
  import { members } from "../lib/mock";
  import type { Navigate } from "../lib/types";

  let { navigate: _navigate }: { navigate: Navigate } = $props();
  let roles = $state(Object.fromEntries(members.map((member) => [member.email, member.role])));

  const roleOptions = [
    { value: "管理员", label: "管理员" },
    { value: "编辑", label: "编辑" },
    { value: "查看", label: "查看" },
  ];
</script>

<section class="admin">
  <aside>
    <div class="title">工作区设置</div>
    <button class="selected"><Icon name="users" size={15} />成员管理</button>
  </aside>

  <div class="main">
    <header><h2>成员管理</h2><button class="primary-btn"><Icon name="plus" size={13} color="#fff" />邀请成员</button></header>
    {#each members as member}
      <div class="member">
        <Avatar name={member.name} size={36} />
        <div><strong>{member.name}</strong><span>{member.email}</span></div>
        <Badge value={member.status} />
        <div class="role-select">
          <SelectMenu
            compact
            value={roles[member.email] ?? member.role}
            options={roleOptions}
            ariaLabel="成员角色"
            onChange={(next) => (roles[member.email] = next)}
          />
        </div>
        <button class="icon-btn"><Icon name="moreH" size={15} /></button>
      </div>
    {/each}
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
    margin: 0;
    color: var(--text-1);
    font-size: 16px;
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

  .member div:nth-child(2) {
    min-width: 0;
    flex: 1;
  }

  strong,
  .member span {
    display: block;
  }

  strong {
    color: var(--text-1);
    font-size: 13px;
  }

  .member span {
    color: var(--text-3);
    font-size: 11px;
  }

  .role-select {
    width: 108px;
  }
</style>
