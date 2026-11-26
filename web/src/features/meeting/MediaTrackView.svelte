<script lang="ts">
  // 把单条 MediaStreamTrack 绑定到 <video>/<audio>；卸载时解除引用，不 stop 远端轨道。
  let {
    track,
    kind,
    mirror = false,
    label = "",
  }: { track: MediaStreamTrack | null; kind: "audio" | "video"; mirror?: boolean; label?: string } = $props();

  let video = $state<HTMLVideoElement | null>(null);
  let audio = $state<HTMLAudioElement | null>(null);

  $effect(() => {
    const el = kind === "audio" ? audio : video;
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
    if (track) void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  });
</script>

{#if kind === "audio"}
  <audio bind:this={audio} autoplay aria-label={label}></audio>
{:else}
  <video bind:this={video} autoplay playsinline muted class:mirror aria-label={label}></video>
{/if}

<style>
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: #111;
    display: block;
  }
  video.mirror {
    transform: scaleX(-1);
  }
</style>
