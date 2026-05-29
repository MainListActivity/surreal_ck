<script lang="ts">
  let { name, size = 30 }: { name: string; size?: number } = $props();

  const palette = ["#5B78F6", "#E86B4F", "#54C07B", "#F5A623", "#8B5CF6", "#EC4899"];
  const bg = $derived(palette[(name.charCodeAt(0) || 0) % palette.length]);
  const char = $derived(name[0] ?? "?");
</script>

<span class="avatar" style={`--size:${size}px;--bg:${bg}`}>{char}</span>

<style>
  .avatar {
    display: inline-grid;
    width: var(--size);
    height: var(--size);
    flex-shrink: 0;
    place-items: center;
    border-radius: 50%;
    background: var(--bg);
    color: #fff;
    font-size: calc(var(--size) * .4);
    font-weight: 700;
    user-select: none;
  }
</style>
