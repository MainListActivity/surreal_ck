<script lang="ts">
  import { mountTurnstile } from "@surreal-ck/shared/turnstile-widget";

  let { action, token = $bindable(""), reset = $bindable<() => void>(() => {}) }:
    { action: string; token?: string; reset?: () => void } = $props();
  const sitekey = import.meta.env.VITE_TURNSTILE_SITEKEY?.trim();
  let container = $state<HTMLDivElement>();
  let error = $state("");

  $effect(() => {
    if (!sitekey || !container) return;
    const widget = mountTurnstile(container, sitekey, action, value => { token = value; }, value => { error = value; });
    reset = widget.reset;
    return widget.remove;
  });
</script>

<div bind:this={container}></div>
{#if error}<p role="alert">{error}</p>{/if}
{#if import.meta.env.PROD && !sitekey}<p role="alert">安全验证暂未配置。</p>{/if}
