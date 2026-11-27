<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { checkMeetingSupport, OPEN_IN_SYSTEM_BROWSER, readMeetingSupportEnv } from "../../lib/meeting/browser-support";
  import { MeetingController, type MeetingView } from "../../lib/meeting/controller";
  import { BrowserMeetingEdge } from "../../lib/meeting/edge";
  import { DEVICE_ERROR_MESSAGES, LocalMedia } from "../../lib/meeting/local-media";
  import { meetingErrorCode, randomMeetingId } from "../../lib/meeting/rpc";
  import type { MeetingSource } from "../../lib/meeting/sdp";
  import { connectGuest, createMeetingV2Rpc, fetchGuestIce, meetingV2Request } from "../../lib/meeting/v2";
  import MediaTrackView from "./MediaTrackView.svelte";

  let { token }: { token: string } = $props();
  const support = checkMeetingSupport(readMeetingSupportEnv());
  const media = new LocalMedia(navigator.mediaDevices ?? {
    getUserMedia: () => Promise.reject(new Error("not supported")),
  });
  let stage = $state<"form" | "waiting" | "live" | "finished">(untrack(() => token) ? "form" : "waiting");
  let name = $state("");
  let code = $state("");
  let error = $state("");
  let busy = $state(false);
  let devices = $state<MediaDeviceInfo[] | null | undefined>();
  let local = $state<Partial<Record<MeetingSource, MediaStreamTrack | null>>>({});
  let view = $state<MeetingView | null>(null);
  let chat = $state("");
  let grant: MeetingController | null = null;
  let unwatch: (() => void) | undefined;
  let active = true;

  async function toggle(source: MeetingSource) {
    if (media.has(source)) {
      media.stop(source);
    } else {
      const before = stage;
      const issue = await media.start(source);
      if (!active || stage !== before) {
        media.stop(source);
        return;
      }
      error = issue ? DEVICE_ERROR_MESSAGES[issue] : "";
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      await meetingV2Request("guest", { op: "open", token, code, name }, AbortSignal.timeout(5000));
      token = "";
      code = "";
      media.stopAll();
      stage = "waiting";
    } catch (cause) {
      error = meetingErrorCode(cause) === "rate_limited" ? "尝试过于频繁，请稍后再试" : "访客链接或访问码无效";
    } finally {
      busy = false;
    }
  }

  async function poll() {
    if (stage !== "waiting" || busy || support.kind !== "supported") return;
    busy = true;
    try {
      const status = await meetingV2Request<{ status: "waiting" | "admitted" }>("guest", { op: "status" }, AbortSignal.timeout(2200));
      if (!active || status.status !== "admitted") return;
      const requested = Date.now();
      const { connection, snapshot } = await connectGuest();
      if (!active) return;
      const controller = new MeetingController({
        rpc: createMeetingV2Rpc("guest", connection),
        fetchIce: () => fetchGuestIce(connection),
        createEdge: (options) => new BrowserMeetingEdge(options),
        localTrack: (source) => media.track(source),
        randomId: randomMeetingId,
        authorizationLeaseMs: 2400,
        onTerminated: () => { media.stopAll(); stage = "finished"; },
      });
      grant = controller;
      unwatch = controller.subscribe((next) => (view = next));
      stage = "live";
      await controller.attach(snapshot, requested);
    } catch (cause) {
      if (meetingErrorCode(cause) === "not_found" || meetingErrorCode(cause) === "denied") {
        media.stopAll();
        stage = "finished";
      }
    } finally {
      busy = false;
    }
  }

  function pagehide() {
    grant?.leaveOnUnload();
    media.stopAll();
  }

  onMount(() => {
    if (support.kind === "supported" && stage === "form") {
      void navigator.mediaDevices.enumerateDevices()
        .then((result) => { devices = result; }, () => { devices = null; });
    }
    const unsubscribe = media.subscribe((source, track) => {
      local = { ...local, [source]: track };
      void grant?.setLocalTrack(source, track);
    });
    void poll();
    const timer = setInterval(() => void poll(), 800);
    window.addEventListener("pagehide", pagehide);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("pagehide", pagehide);
      pagehide();
      unsubscribe();
      unwatch?.();
    };
  });
</script>

<svelte:head><title>访客会议</title><meta name="referrer" content="no-referrer" /></svelte:head>

<main>
  <h1>访客会议</h1>
  {#if support.kind !== "supported"}
    <p>{OPEN_IN_SYSTEM_BROWSER}</p>
  {:else if stage === "form"}
    <form onsubmit={submit}>
      <label>展示名称 <input bind:value={name} maxlength="80" required /></label>
      <label>访问码（如主持人已设置） <input bind:value={code} inputmode="numeric" maxlength="6" type="password" /></label>
      <p role="status">{devices === undefined ? "正在检测麦克风和摄像头…"
        : devices === null ? "无法检测设备，仍可关闭设备参会"
        : `麦克风：${devices.some((device) => device.kind === "audioinput") ? "已检测" : "未检测到"} · 摄像头：${devices.some((device) => device.kind === "videoinput") ? "已检测" : "未检测到"}`}</p>
      <div class="actions">
        <button type="button" onclick={() => toggle("microphone")}>{local.microphone ? "停止麦克风测试" : "测试麦克风"}</button>
        <button type="button" onclick={() => toggle("camera")}>{local.camera ? "停止摄像头测试" : "测试摄像头"}</button>
      </div>
      {#if local.camera}<MediaTrackView track={local.camera} kind="video" mirror />{/if}
      <button disabled={busy || devices === undefined} type="submit">进入等候室</button>
    </form>
  {:else if stage === "waiting"}
    <p role="status">正在等候主持人放行。放行前不会接收会议内容。</p>
  {:else if stage === "finished"}
    <p role="status">访客会话已结束。如需加入，请联系会议主持人。</p>
  {:else}
    <p role="status">已加入会议</p>
    <div class="actions">
      <button onclick={() => toggle("microphone")}>{local.microphone ? "关闭麦克风" : "开启麦克风"}</button>
      <button onclick={() => toggle("camera")}>{local.camera ? "关闭摄像头" : "开启摄像头"}</button>
      {#if support.canShareScreen}<button onclick={() => toggle("screen")}>{local.screen ? "停止共享" : "共享屏幕"}</button>{/if}
      <button onclick={() => grant?.leave()}>离开会议</button>
    </div>
    {#if local.camera}<MediaTrackView track={local.camera} kind="video" mirror />{/if}
    <div class="peers">
      {#each view?.peers ?? [] as peer (peer.joinId)}
        <section aria-label="远端参会者">
          {#if peer.tracks.camera}<MediaTrackView track={peer.tracks.camera} kind="video" />{/if}
          {#if peer.tracks.screen}<MediaTrackView track={peer.tracks.screen} kind="video" />{/if}
          {#if peer.tracks.microphone}<MediaTrackView track={peer.tracks.microphone} kind="audio" />{/if}
        </section>
      {/each}
    </div>
    {#if view?.peers.some((peer) => peer.chat)}
      <form onsubmit={(event) => { event.preventDefault(); if (grant?.sendChat(chat)) chat = ""; }}>
        <label>会中消息 <input bind:value={chat} maxlength="512" /></label><button type="submit">发送</button>
      </form>
    {/if}
    {#each view?.chat ?? [] as message (message.id)}<p>{message.self ? "我" : "参会者"}：{message.text}</p>{/each}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</main>

<style>
  main { width: min(100% - 2rem, 48rem); margin: 2rem auto; display: grid; gap: 1rem; }
  h1 { font-size: 1.5rem; font-weight: 650; }
  form, label, .peers { display: grid; gap: .5rem; }
  .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
  input, button { border: 1px solid currentColor; border-radius: .25rem; padding: .35rem .65rem; background: transparent; }
</style>
