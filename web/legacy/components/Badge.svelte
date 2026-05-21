<script lang="ts">
  let { value }: { value: string } = $props();

  const styleMap: Record<string, { bg: string; color: string }> = {
    待审核: { bg: "var(--warning-bg)", color: "var(--warning)" },
    审核中: { bg: "var(--primary-light)", color: "var(--primary)" },
    已通过: { bg: "var(--success-bg)", color: "var(--success)" },
    已退回: { bg: "var(--error-bg)", color: "var(--error)" },
    活跃: { bg: "var(--success-bg)", color: "var(--success)" },
    已邀请: { bg: "var(--soft)", color: "var(--text-3)" },
  };

  const cfg = $derived(styleMap[value] ?? { bg: "var(--bg)", color: "var(--text-3)" });
</script>

<span class="badge" style={`--badge-bg:${cfg.bg};--badge-color:${cfg.color}`}>{value}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--badge-bg);
    color: var(--badge-color);
    font-size: 11px;
    font-weight: 550;
    white-space: nowrap;
  }

  .badge::before {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    content: "";
  }
</style>
