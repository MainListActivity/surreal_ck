<script lang="ts">
  let { type = "excel", size = 28 }: { type?: "excel" | "word"; size?: number } = $props();

  const width = $derived(size * 0.78);
  const fold = $derived(size * 0.28);
  const bg = $derived(type === "word" ? "#2B579A" : "#1D6F42");
  const letter = $derived(type === "word" ? "W" : "X");
</script>

<svg width={width} height={size} viewBox={`0 0 ${width} ${size}`} fill="none" aria-hidden="true">
  <path d={`M0 3 Q0 0 3 0 L${width - fold} 0 L${width} ${fold} L${width} ${size - 3} Q${width} ${size} ${width - 3} ${size} L3 ${size} Q0 ${size} 0 ${size - 3} Z`} fill={bg} />
  <path d={`M${width - fold} 0 L${width - fold} ${fold} L${width} ${fold} Z`} fill="rgba(255,255,255,0.25)" />
  <text x={width / 2} y={size * 0.67} text-anchor="middle" dominant-baseline="middle" font-size={size * 0.38} font-weight="700" fill="white" font-family="-apple-system, Arial">{letter}</text>
</svg>
