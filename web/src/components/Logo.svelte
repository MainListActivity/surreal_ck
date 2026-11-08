<script lang="ts">
  // 吉吉品牌标识：背影猫面对数据墙 +「吉吉 / WORKSPACE」字标。
  let { size = "md" }: { size?: "sm" | "md" } = $props();

  const mark = $derived(size === "sm" ? 30 : 38);
  const title = $derived(size === "sm" ? 18 : 22);
  const cells = Array.from({ length: 30 }, (_, index) => {
    const column = index % 6;
    const row = Math.floor(index / 6);
    const x = 10 + column * 7.6;
    const y = 10 + row * 7.6;
    const distance = Math.hypot(x + 3 - 32, (y + 3 - 24) * 1.15);
    const highlighted = [2, 9, 16, 22, 27].includes(index);
    return { x, y, opacity: highlighted ? 1 : Math.max(0.22, Math.min(1, 1.15 - distance / 26)) };
  });
</script>

<span class="lockup" aria-label="吉吉">
  <svg class="mark" width={mark} height={mark} viewBox="0 0 64 64" aria-hidden="true">
    <rect width="64" height="64" rx="15" fill="#161513" />
    {#each cells as cell}
      <rect x={cell.x} y={cell.y} width="6" height="6" rx="1.2" fill="#f5c542" fill-opacity={cell.opacity} />
    {/each}
    <path class="rim" d="M20.5 57C18.5 51 20 44.5 25.5 40.5C26.6 39.7 27 38.6 26.6 37.4C25.4 35.8 24.8 33.6 24.9 31L25.6 20.6Q25.9 19 27.2 19.9L30.6 23.2Q32 22.8 33.4 23.2L36.8 19.9Q38.1 19 38.4 20.6L39.1 31C39.2 33.6 38.6 35.8 37.4 37.4C37 38.6 37.4 39.7 38.5 40.5C44 44.5 45.5 51 43.5 57Z" />
    <path fill="#161513" d="M20.5 57C18.5 51 20 44.5 25.5 40.5C26.6 39.7 27 38.6 26.6 37.4C25.4 35.8 24.8 33.6 24.9 31L25.6 20.6Q25.9 19 27.2 19.9L30.6 23.2Q32 22.8 33.4 23.2L36.8 19.9Q38.1 19 38.4 20.6L39.1 31C39.2 33.6 38.6 35.8 37.4 37.4C37 38.6 37.4 39.7 38.5 40.5C44 44.5 45.5 51 43.5 57Z" />
    <path class="tail-rim" d="M41 56.6C48 57.6 52 55 52.5 50.5C52.8 48 51.6 46.4 50 46" />
    <path class="tail" d="M41 56.6C48 57.6 52 55 52.5 50.5C52.8 48 51.6 46.4 50 46" />
  </svg>
  <span class="words">
    <span class="name" style={`font-size:${title}px`}>吉吉</span>
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
    display: block;
    flex-shrink: 0;
    overflow: visible;
  }

  .rim,
  .tail-rim {
    fill: none;
    stroke: #f5c542;
    stroke-linejoin: round;
    stroke-width: 1.3;
  }

  .tail-rim {
    stroke-linecap: round;
    stroke-width: 4.6;
  }

  .tail {
    fill: none;
    stroke: #161513;
    stroke-linecap: round;
    stroke-width: 3.4;
  }

  .words {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    line-height: 1;
  }

  .name {
    color: var(--text-1);
    font-family: var(--font-sans);
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .sub {
    margin-top: 4px;
    color: var(--text-3);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 2.2px;
    text-transform: uppercase;
  }
</style>
