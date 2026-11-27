<script lang="ts">
  import { onMount } from "svelte";
  import { meetingV2Request } from "../../lib/meeting/v2";
  import { meetingErrorMessage } from "../../lib/meeting/rpc";

  let { room, join }: { room: string; join: string } = $props();
  type Status = { enabled: boolean; locked: boolean; expires: number | null; guests: { id: string; name: string; status: "waiting" | "admitted" }[] };
  let status = $state<Status | null>(null);
  let code = $state("");
  let link = $state("");
  let busy = $state(false);
  let error = $state("");

  const command = <T,>(action: string, extra = {}) => meetingV2Request<T>("member", {
    op: "guest_host", action, room, join_id: join, ...extra,
  }, AbortSignal.timeout(4000));

  async function refresh() {
    try {
      status = await command<Status>("status");
      if (!status.enabled) link = "";
    } catch (cause) {
      error = meetingErrorMessage(cause);
    }
  }

  async function act(action: string, id?: string) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const result = await command<{ token: string } | null>(action, { id, code });
      if (result) {
        link = new URL(`/meeting/guest#${result.token}`, location.origin).href;
        code = "";
      }
      await refresh();
    } catch (cause) {
      error = meetingErrorMessage(cause);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => { if (!busy) void refresh(); }, 900);
    return () => clearInterval(timer);
  });
</script>

<section aria-label="访客等候室">
  <h3>外部访客与等候室</h3>
  {#if status}
    <p aria-live="polite">{status.guests.filter((guest) => guest.status === "waiting").length} 人正在等候</p>
    <p>{status.enabled ? "允许访客申请入会" : "外部访客入口已关闭"}{status.locked ? " · 会议已锁定" : ""}</p>
    <label>可选 6 位访问码 <input type="text" inputmode="numeric" maxlength="6" bind:value={code} /></label>
    <button disabled={busy || (!!code && !/^[0-9]{6}$/.test(code))} onclick={() => act("rotate")}>
      {status.enabled ? "重置访客链接" : "允许外部访客并生成链接"}
    </button>
    {#if status.enabled}
      <button disabled={busy} onclick={() => act("close")}>关闭访客入口</button>
      {#if status.expires}<span> · {new Date(status.expires).toLocaleTimeString()} 到期</span>{/if}
    {/if}
    <button disabled={busy} onclick={() => act(status?.locked ? "unlock" : "lock")}>{status.locked ? "解除锁定" : "锁定会议"}</button>
    {#if link}<label>访客链接 <input readonly value={link} /></label><button onclick={() => navigator.clipboard.writeText(link)}>复制链接</button>{/if}
    <ul>
      {#each status.guests as guest (guest.id)}
        <li>
          {guest.name}
          {#if guest.status === "waiting"}
            <button disabled={busy || status.locked} onclick={() => act("admit", guest.id)}>放行</button>
            <button disabled={busy} onclick={() => act("reject", guest.id)}>拒绝</button>
          {:else}
            <button disabled={busy} onclick={() => act("remove", guest.id)}>移出并禁止本次重入</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  section { display: grid; gap: .5rem; padding: .75rem; border: 1px solid currentColor; border-radius: .5rem; }
  input { background: transparent; border: 1px solid currentColor; padding: .25rem; max-width: 100%; }
  button { border: 1px solid currentColor; border-radius: .25rem; padding: .25rem .5rem; }
</style>
