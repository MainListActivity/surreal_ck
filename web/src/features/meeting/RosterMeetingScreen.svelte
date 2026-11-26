<script lang="ts">
  import { onMount } from "svelte";
  import RosterMeetingPolls from "./RosterMeetingPolls.svelte";
  import { Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication } from "livekit-client";
  import { createPublicRosterApi, rosterExitMessage, rosterVerifyMessage, RosterRequestError, type RosterSession } from "../../lib/meeting/roster";
  import { selectedMeetingSubscriptions } from "../../lib/meeting/sfu";

  let { pass, checkLabel }: { pass: string; checkLabel: string } = $props();
  const api = createPublicRosterApi();
  const mobile = window.matchMedia("(pointer: coarse)").matches;
  let session = $state<RosterSession>();
  let code = $state("");
  let check = $state("");
  let error = $state("");
  let exit = $state("");
  let busy = $state(false);
  let connected = $state(false);
  let audioOnly = $state(false);
  let needsAudio = $state(false);
  let canSpeak = $state(false);
  let raised = $state(false);
  let mic = $state(false);
  let micBusy = $state(false);
  let tracks = $state<RemoteTrack[]>([]);
  let room: Room | undefined;
  let stopped = false;
  let polling = false;
  let allowJoin = $state(true);
  let renewAt = 0;
  let leaseUntil = 0;

  function reconcile(current: Room) {
    if (room !== current) return;
    const publications: RemoteTrackPublication[] = [];
    const candidates = [];
    for (const person of current.remoteParticipants.values()) {
      for (const publication of person.trackPublications.values()) {
        if (publication.isMuted) {
          if (publication.isDesired) publication.setSubscribed(false);
          continue;
        }
        publications.push(publication);
        candidates.push({ id: publication.trackSid, identity: person.identity, source: publication.source,
          host: person.metadata === "host", cohost: person.metadata === "cohost" });
      }
    }
    const wanted = selectedMeetingSubscriptions(candidates, current.activeSpeakers.map((speaker) => speaker.identity),
      audioOnly ? "audio" : mobile ? "mobile" : "desktop", session?.focus ?? "auto");
    for (const publication of publications) {
      const subscribe = wanted.has(publication.trackSid);
      if (publication.isDesired !== subscribe) publication.setSubscribed(subscribe);
    }
    tracks = publications.flatMap((publication) => wanted.has(publication.trackSid) && publication.track ? [publication.track] : []);
  }

  function attach(element: HTMLMediaElement, track: RemoteTrack) {
    track.attach(element);
    return { destroy: () => track.detach(element) };
  }

  function detach() {
    const current = room;
    room = undefined;
    tracks = [];
    connected = false;
    needsAudio = false;
    canSpeak = raised = mic = false;
    void current?.disconnect(true).catch(() => undefined);
  }

  function applySession(next: RosterSession) {
    const focusChanged = session?.focus !== next.focus;
    session = next;
    const message = next.ended ? "主持人已结束会议" : rosterExitMessage(next.state);
    if (message) {
      exit = message;
      error = "";
      allowJoin = false;
      detach();
    } else if (focusChanged && room) reconcile(room);
  }

  async function stopMicrophone(current: Room) {
    const local = current.localParticipant;
    const track = local.getTrackPublication(Track.Source.Microphone)?.track;
    if (track) {
      track.stop();
      await local.unpublishTrack(track);
    }
  }

  function syncPermission(current: Room) {
    if (room !== current) return;
    const allowed = current.localParticipant.permissions?.canPublish === true;
    if (canSpeak === allowed) return;
    canSpeak = allowed;
    raised = false;
    if (!allowed) {
      mic = false;
      void stopMicrophone(current).catch(() => undefined);
    }
  }

  async function toggleMic() {
    const current = room;
    if (!current || !canSpeak || micBusy) return;
    micBusy = true;
    error = "";
    try {
      if (mic) await stopMicrophone(current);
      else await current.localParticipant.setMicrophoneEnabled(true);
      if (room !== current || !canSpeak) await stopMicrophone(current);
      else mic = current.localParticipant.isMicrophoneEnabled;
    } catch {
      if (room === current && canSpeak) error = "无法开启麦克风，请检查浏览器权限。";
    } finally {
      micBusy = false;
    }
  }

  async function raiseHand() {
    const current = room;
    raised = true;
    error = "";
    try { await api.raiseHand(); }
    catch (cause) {
      if (room !== current) return;
      raised = false;
      error = cause instanceof Error ? cause.message : "举手失败，请重试。";
    }
  }

  function updateLease(deadline: number) {
    leaseUntil = deadline;
    renewAt = Math.min(Date.now() + 30_000, deadline - 10_000);
  }

  async function join() {
    const grant = await api.credentials();
    if (stopped || exit || !allowJoin) return;
    if (grant.role !== "listener") throw new Error("名册会议仅允许接收媒体");
    const current = new Room({ adaptiveStream: true, dynacast: true, reconnectPolicy: { nextRetryDelayInMs: () => null } });
    room = current;
    updateLease(grant.leaseExpiresAt);
    for (const event of [RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected, RoomEvent.ActiveSpeakersChanged, RoomEvent.Reconnected] as const) {
      current.on(event, () => reconcile(current));
    }
    current.on(RoomEvent.AudioPlaybackStatusChanged, () => { needsAudio = !current.canPlaybackAudio; });
    current.on(RoomEvent.ParticipantPermissionsChanged, (_before, participant) => {
      if (participant === current.localParticipant) syncPermission(current);
    });
    current.on(RoomEvent.Disconnected, () => {
      if (room !== current) return;
      allowJoin = false;
      detach();
      error = "连接已断开。若会议仍开放，可重新连接。";
      void poll();
    });
    try {
      await current.connect(grant.url, grant.token, { autoSubscribe: false, maxRetries: 0 });
    } catch (cause) {
      if (room === current) detach();
      throw cause;
    }
    if (room !== current) return;
    allowJoin = false;
    connected = true;
    error = "";
    needsAudio = !current.canPlaybackAudio;
    syncPermission(current);
    reconcile(current);
  }

  async function poll() {
    if (polling || stopped || exit || busy || (pass && !session)) return;
    polling = true;
    try {
      const next = await api.session();
      if (stopped || busy) return;
      applySession(next);
      if (exit || next.state !== "admitted") return;
      if (!room && allowJoin) await join();
      else if (room && Date.now() >= renewAt) updateLease((await api.credentials()).leaseExpiresAt);
    } catch (cause) {
      if (stopped || busy) return;
      if (cause instanceof RosterRequestError && cause.status === 401 && session) {
        try { applySession(await api.session()); }
        catch (retry) {
          if (retry instanceof RosterRequestError && retry.status === 401) applySession({ ...session, state: "revoked" });
        }
      } else if (session?.state === "admitted" && !room && allowJoin) {
        error = cause instanceof RosterRequestError && cause.status === 423 ? cause.message : "暂无法加入会议，正在等待媒体服务。";
      }
      if (room && Date.now() >= leaseUntil) {
        allowJoin = false;
        detach();
        error = "连接已断开。若会议仍开放，可重新连接。";
      }
    } finally {
      polling = false;
    }
  }

  async function verify(event: SubmitEvent) {
    event.preventDefault();
    if (!pass || busy) return;
    busy = true;
    error = "";
    try {
      const next = await api.verify(pass, code, check.trim() || undefined);
      if (!stopped) applySession(next);
    } catch (cause) {
      error = rosterVerifyMessage(cause);
    } finally {
      code = "";
      check = "";
      busy = false;
      if (session) void poll();
    }
  }

  onMount(() => {
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      stopped = true;
      detach();
      clearInterval(timer);
    };
  });
</script>

<svelte:window ononline={() => void poll()} />

<main>
  <h1>{session?.title ?? "名册会议"}</h1>
  {#if exit}
    <p role="alert">{exit}</p>
  {:else if session}
    <label>参会显示名 <input value={session.name} readonly /></label>
    {#if session.state === "waiting"}
      <p role="status">正在等候主持人准入，请保持此页面打开。</p>
    {:else if connected}
      <p role="status">已连接 · {canSpeak ? "主持人已允许发言" : raised ? "已举手，等待主持人" : "只听"}</p>
      <div class="media">
        {#each tracks as track (track)}
          {#if track.kind === Track.Kind.Video}
            <video use:attach={track} autoplay playsinline aria-label="大会视频"></video>
          {:else}
            <audio use:attach={track} autoplay></audio>
          {/if}
        {/each}
      </div>
      <div class="controls">
        {#if canSpeak}
          <button disabled={micBusy} aria-pressed={mic} onclick={() => void toggleMic()}>{mic ? "关闭麦克风" : "打开麦克风"}</button>
        {:else}
          <button disabled={raised} onclick={() => void raiseHand()}>举手申请发言</button>
        {/if}
        {#if needsAudio}<button onclick={() => void room?.startAudio().catch(() => undefined)}>开启声音</button>{/if}
        <button aria-pressed={audioOnly} onclick={() => { audioOnly = !audioOnly; if (room) reconcile(room); }}>
          {audioOnly ? "恢复视频接收" : "纯音频省流模式"}
        </button>
        <button onclick={() => { allowJoin = false; detach(); }}>离开</button>
      </div>
    {:else if allowJoin}
      <p role="status">已获准入，正在连接私有媒体…</p>
    {:else}
      <button onclick={() => { error = ""; allowJoin = true; void poll(); }}>重新连接</button>
    {/if}
  {:else if pass}
    <form onsubmit={verify}>
      <label>访问码 <input required inputmode="numeric" pattern={"[0-9]{6,32}"} autocomplete="off" bind:value={code} /></label>
      <label>{checkLabel || "名册校对（如有要求）"} <input type="password" maxlength="512" autocomplete="off" bind:value={check} /></label>
      <button disabled={busy}>核验并参会</button>
    </form>
  {:else}
    <p>请打开主持人提供的专属参会链接。</p>
  {/if}
  {#if session && (session.ended ? session.canReadReceipt : session.state === "admitted" && !exit)}
    <RosterMeetingPolls {api} ended={!!session.ended} />
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</main>

<style>
  main { width: min(52rem, 100%); margin: 2rem auto; padding: 1.25rem; display: grid; gap: 1rem; }
  form, label { display: grid; gap: 0.5rem; }
  form { max-width: 26rem; }
  input, button { padding: 0.55rem 0.7rem; border: 1px solid var(--border, #aaa); border-radius: 0.4rem; }
  button { justify-self: start; }
  .controls { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  video { width: 100%; max-height: 65vh; background: #141414; }
  [role="alert"] { color: var(--danger, #b22); }
  @media (pointer: coarse) { main { margin-block: 0; } button { min-height: 44px; } }
</style>
