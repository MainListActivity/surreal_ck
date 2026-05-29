<script lang="ts">
  import { ICON_PATHS } from "../lib/icons";

  let {
    name,
    size = 16,
    color = "currentColor",
    strokeWidth = 1.8,
  }: {
    name: string;
    size?: number;
    color?: string;
    strokeWidth?: number;
  } = $props();

  const paths = $derived(ICON_PATHS[name] ?? []);
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} stroke-width={strokeWidth} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#each paths as d}
    <path {d}></path>
  {/each}
</svg>
