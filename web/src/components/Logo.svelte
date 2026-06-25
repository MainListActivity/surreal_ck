<script lang="ts">
  // 卯豆 品牌标识：嫩芽 logo + 「卯豆 / WORKSPACE」字标。
  let { size = "md" }: { size?: "sm" | "md" } = $props();

  const mark = $derived(size === "sm" ? 30 : 38);
  const title = $derived(size === "sm" ? 18 : 22);
</script>

<span class="lockup">
  <span class="mark" style={`--mark:${mark}px`}>
    <svg width={mark * 0.63} height={mark * 0.63} viewBox="0 0 64 64" fill="none">
      <path d="M14 53 Q32 49 50 53" stroke="#A88C68" stroke-width="2.4" stroke-linecap="round" fill="none" />
      <path d="M25 53 L25 27" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" />
      <path d="M25 39 C25 39 14 35 12 26 C18 26 25 32 25 39" fill="var(--brand-mid)" />
      <path d="M25 33 C25 33 35 29 37 20 C31 22 25 28 25 33" fill="#8DD49A" />
      <path d="M39 53 L39 30" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" />
      <path d="M39 41 C39 41 50 37 52 28 C46 28 39 34 39 41" fill="var(--brand-mid)" />
      <circle cx="25" cy="54" r="3.2" fill="var(--seed)" />
      <circle cx="39" cy="54" r="3.2" fill="var(--seed)" />
    </svg>
  </span>
  <span class="words">
    <span class="name" style={`font-size:${title}px`}>卯豆</span>
    <span class="sub">Workspace</span>
  </span>
</span>

<style>
  .lockup {
    display: flex;
    align-items: center;
    gap: 11px;
    user-select: none;
  }

  .mark {
    display: grid;
    width: var(--mark);
    height: var(--mark);
    flex-shrink: 0;
    place-items: center;
    border-radius: 11px;
    background: var(--primary-light);
  }

  .words {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    line-height: 1;
  }

  .name {
    font-family: var(--font-serif);
    font-weight: 600;
    color: var(--text-1);
    letter-spacing: 0.5px;
  }

  .sub {
    margin-top: 4px;
    color: var(--text-3);
    font-size: 10px;
    letter-spacing: 2.5px;
    text-transform: uppercase;
  }
</style>
