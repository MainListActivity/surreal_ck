<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    DisconnectReason, Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication,
  } from "livekit-client";
  import type { MeetingSfuCredentials, MeetingSfuParticipant, MeetingSfuRole } from "@surreal-ck/shared";
  import { loadMemberRows } from "../../lib/members-data";
  import { getSurreal } from "../../lib/surreal";
  import { fetchMeetingIce } from "../../lib/meeting/ice";
  import { meetingSfuApi, selectedMeetingSubscriptions, SfuRequestError } from "../../lib/meeting/sfu";

  let { initialRoom, initialSeats, maxSeats, onback }: { initialRoom: string; initialSeats: number; maxSeats: number; onback: () => void } = $props();
  let inputId = $state("");
  let seats = $state(10);
  let roomId = $state("");
  let role = $state<MeetingSfuRole>("listener");
  let status = $state<"idle" | "connected" | "reconnecting">("idle");
  let busy = $state(false);
  let error = $state("");
  let feedback = $state("");
  let audioOnly = $state(false);
  let needsAudio = $state(false);
  let mic = $state(false);
  let camera = $state(false);
  let screen = $state(false);
  let tracks = $state<RemoteTrack[]>([]);
  let attendees = $state<MeetingSfuParticipant[]>([]);
  let contacts = $state<{ subject: string; display_name?: string | null; email: string }[]>([]);
  let inviteSubject = $state("");
  let inviteRole = $state<"speaker" | "listener">("listener");
  const mobile = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  let room: Room | undefined;
  let destroyed = false;
  let leaseUntil = 0;
  let renewing = false;
  let attempt = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  $effect(() => { inputId = initialRoom; });
  $effect(() => { seats = Math.min(Math.max(1, initialSeats || 10), maxSeats || 10); });

  function reconcile(current: Room) {
    const publications: RemoteTrackPublication[] = [];
    const candidates = [];
    for (const person of current.remoteParticipants.values()) {
      for (const publication of person.trackPublications.values()) {
        if (publication.isMuted) {
          if (publication.isDesired) publication.setSubscribed(false);
          continue;
        }
        publications.push(publication);
        candidates.push({
          id: publication.trackSid, identity: person.identity, source: publication.source,
          host: person.metadata === "host",
        });
      }
    }
    const wanted = selectedMeetingSubscriptions(
      candidates, current.activeSpeakers.map((person) => person.identity), audioOnly ? "audio" : mobile ? "mobile" : "desktop",
    );
    for (const publication of publications) {
      const subscribe = wanted.has(publication.trackSid);
      if (publication.isDesired !== subscribe) publication.setSubscribed(subscribe);
    }
    tracks = publications.flatMap((p) => wanted.has(p.trackSid) && p.track ? [p.track] : []);
  }

  function attach(element: HTMLMediaElement, track: RemoteTrack) {
    track.attach(element);
    return { destroy: () => track.detach(element) };
  }

  function applyLease(grant: MeetingSfuCredentials) {
    role = grant.role;
    leaseUntil = grant.leaseExpiresAt;
  }

  async function refreshLease() {
    const current = room;
    if (!current || renewing) return;
    renewing = true;
    try {
      const grant = await meetingSfuApi.credentials(roomId);
      if (current !== room) return;
      applyLease(grant);
      if (role === "host") await refreshAttendees();
    } catch (cause) {
      if (current !== room) return;
      if ((cause instanceof SfuRequestError && (cause.status === 401 || cause.status === 403)) || Date.now() >= leaseUntil) {
        error = "会议已结束、会话已失效或你已被移出";
        disconnect();
      }
    } finally {
      renewing = false;
    }
  }

  async function enter(id: string, connectionAttempt = ++attempt, retry = false) {
    const grant = await meetingSfuApi.credentials(id);
    if (destroyed || attempt !== connectionAttempt) return;
    const current = new Room({ adaptiveStream: true, dynacast: true });
    room = current;
    roomId = id;
    applyLease(grant);
    current
      .on(RoomEvent.TrackPublished, () => reconcile(current))
      .on(RoomEvent.TrackUnpublished, () => reconcile(current))
      .on(RoomEvent.TrackMuted, () => reconcile(current))
      .on(RoomEvent.TrackUnmuted, () => reconcile(current))
      .on(RoomEvent.TrackSubscribed, () => reconcile(current))
      .on(RoomEvent.TrackUnsubscribed, () => reconcile(current))
      .on(RoomEvent.ParticipantConnected, () => reconcile(current))
      .on(RoomEvent.ParticipantDisconnected, () => reconcile(current))
      .on(RoomEvent.ActiveSpeakersChanged, () => reconcile(current))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => { needsAudio = !current.canPlaybackAudio; })
      .on(RoomEvent.LocalTrackUnpublished, () => syncDevices(current))
      .on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
        if (participant === current.localParticipant && participant.permissions?.canPublish === false) {
          role = "listener";
          syncDevices(current);
        }
      })
      .on(RoomEvent.Reconnecting, () => { status = "reconnecting"; })
      .on(RoomEvent.Reconnected, () => { status = "connected"; reconcile(current); })
      .on(RoomEvent.Disconnected, (reason) => {
        if (room !== current || status === "idle") return;
        disconnect();
        if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED
          || reason === DisconnectReason.DUPLICATE_IDENTITY) {
          error = "会议已结束、你已被移出，或已在另一设备入会。";
          return;
        }
        if (retry) {
          error = "连接已断开。若会议仍开放，可重新加入。";
          return;
        }
        status = "reconnecting";
        void enter(id, ++attempt, true).catch((cause: unknown) => {
          if (!destroyed) {
            disconnect();
            error = cause instanceof SfuRequestError ? cause.message : "连接已断开。若会议仍开放，可重新加入。";
          }
        });
      });
    const ice = await fetchMeetingIce().catch(() => undefined);
    if (room !== current) return;
    const iceServers = ice ? [...ice.direct, ...ice.relay] : [];
    try {
      await current.connect(grant.url, grant.token, {
        autoSubscribe: false, ...(iceServers.length ? { rtcConfig: { iceServers } } : {}),
      });
    } catch {
      if (room === current) disconnect();
      throw new Error("无法连接公司私有媒体服务，请检查网络后重试");
    }
    if (room !== current) return;
    status = "connected";
    reconcile(current);
    refreshTimer = setInterval(() => { void refreshLease(); }, 30_000);
    if (role === "host") {
      void refreshAttendees();
      void loadMemberRows(getSurreal()).then((rows) => {
        if (room === current) contacts = rows.flatMap(({ subject, ...member }) => subject ? [{ ...member, subject }] : []);
      }).catch(() => undefined);
    }
  }

  function disconnect() {
    attempt++;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    const current = room;
    room = undefined;
    status = "idle";
    tracks = [];
    attendees = [];
    mic = camera = screen = false;
    void current?.disconnect(true).catch(() => undefined);
  }

  onDestroy(() => { destroyed = true; disconnect(); });

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    error = "";
    feedback = "";
    busy = true;
    try { await action(); } catch (cause) {
      if (!destroyed) error = cause instanceof Error ? cause.message : "私有会议操作失败";
    } finally { busy = false; }
  }

  async function refreshAttendees() {
    const current = room;
    const list = await meetingSfuApi.list(roomId).catch(() => undefined);
    if (list && room === current) attendees = list;
  }

  function syncDevices(current: Room) {
    mic = current.localParticipant.isMicrophoneEnabled;
    camera = current.localParticipant.isCameraEnabled;
    screen = current.localParticipant.isScreenShareEnabled;
  }

  function device(kind: "mic" | "camera" | "screen") {
    return run(async () => {
      const current = room;
      if (!current) return;
      const local = current.localParticipant;
      try {
        if (kind === "mic") await local.setMicrophoneEnabled(!mic);
        if (kind === "camera") await local.setCameraEnabled(!camera);
        if (kind === "screen") await local.setScreenShareEnabled(!screen);
      } catch {
        throw new Error("无法启用设备，请检查浏览器权限及主持人授权");
      } finally {
        if (room === current) syncDevices(current);
      }
    });
  }

  async function toggleAudio() {
    audioOnly = !audioOnly;
    const current = room;
    if (!current) return;
    reconcile(current);
    if (audioOnly) {
      await Promise.allSettled([
        current.localParticipant.setCameraEnabled(false),
        current.localParticipant.setScreenShareEnabled(false),
      ]);
      if (room === current) syncDevices(current);
    }
  }

  async function copyInvite() {
    const url = new URL(location.href);
    url.searchParams.set("sfu", roomId);
    await navigator.clipboard.writeText(url.toString());
    feedback = "参会链接已复制，请仅分享给已获邀请的成员";
  }
</script>

<svelte:window ononline={() => void refreshLease()} onpagehide={disconnect} />

<div class="private-meeting" data-testid="private-meeting">
  <header>
    <h2>私有大会</h2>
    <button onclick={() => { disconnect(); onback(); }}>返回普通会议</button>
  </header>
  {#if status === "idle"}
    <p>媒体由公司私有节点转发，仅获邀请的工作区成员可进入。默认关闭录制。</p>
    {#if maxSeats > 0}
      <form onsubmit={(event) => { event.preventDefault(); void run(async () => {
        const created = await meetingSfuApi.create(seats);
        inputId = created.id;
        await enter(created.id);
      }); }}>
        <label>预计参会人数 <input type="number" min="1" max={maxSeats} required bind:value={seats} /></label>
        <button disabled={busy}>创建私有大会</button>
      </form>
    {/if}
    <form onsubmit={(event) => { event.preventDefault(); void run(() => enter(inputId.trim())); }}>
      <label>大会编号 <input required bind:value={inputId} autocomplete="off" /></label>
      <button disabled={busy}>加入大会</button>
    </form>
  {:else}
    <p aria-live="polite">{status === "reconnecting" ? "网络变化，正在自动重连…" : "已连接 · 私有媒体"}{role === "listener" ? " · 只听" : ""}</p>
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
      {#if needsAudio}
        <button onclick={() => void run(() => room?.startAudio() ?? Promise.resolve())}>开启声音</button>
      {/if}
      <button aria-pressed={audioOnly} onclick={() => void run(toggleAudio)}>{audioOnly ? "恢复视频接收" : "纯音频省流模式"}</button>
      {#if role !== "listener"}
        <button disabled={busy} onclick={() => device("mic")}>{mic ? "关闭麦克风" : "开启麦克风"}</button>
        <button disabled={busy || audioOnly} onclick={() => device("camera")}>{camera ? "关闭摄像头" : "开启摄像头"}</button>
        {#if typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function"}
          <button disabled={busy || audioOnly} onclick={() => device("screen")}>{screen ? "停止共享" : "共享屏幕"}</button>
        {/if}
      {/if}
      <button onclick={disconnect}>离开</button>
      {#if role === "host"}
        <button disabled={busy} onclick={() => void run(async () => { await meetingSfuApi.end(roomId); disconnect(); })}>结束大会</button>
      {/if}
    </div>
    {#if role === "host"}
      <form onsubmit={(event) => { event.preventDefault(); void run(async () => {
        await meetingSfuApi.invite(roomId, inviteSubject, inviteRole);
        await refreshAttendees();
      }); }}>
        <label>成员 <select required bind:value={inviteSubject}>
          <option value="">选择工作区成员</option>
          {#each contacts as contact (contact.subject)}
            <option value={contact.subject}>{contact.display_name || contact.email}</option>
          {/each}
        </select></label>
        <label>权限 <select bind:value={inviteRole}><option value="listener">只听</option><option value="speaker">发言</option></select></label>
        <button disabled={busy}>添加邀请</button>
        <button type="button" onclick={() => void run(copyInvite)}>复制参会链接</button>
        <span>大会编号：{roomId}</span>
      </form>
      <ul>
        {#each attendees.filter((person) => person.role !== "host") as person (person.id)}
          <li>
            {contacts.find((contact) => contact.subject === person.memberSubject)?.display_name
              || contacts.find((contact) => contact.subject === person.memberSubject)?.email
              || person.name}
            · {person.revoked ? "已移出" : person.role === "speaker" ? "发言" : "只听"}
            {#if !person.revoked}
              {#if person.role === "speaker"}
                <button disabled={busy} onclick={() => void run(async () => {
                  await meetingSfuApi.stopPublishing(roomId, person.id); await refreshAttendees();
                })}>停止其发布</button>
              {/if}
              <button disabled={busy} onclick={() => void run(async () => {
                await meetingSfuApi.kick(roomId, person.id); await refreshAttendees();
              })}>移出并禁重入</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if feedback}<p role="status">{feedback}</p>{/if}
</div>

<style>
  .private-meeting { display: grid; gap: 1rem; padding: 1.25rem; border: 1px solid var(--border, #bbb); border-radius: 0.75rem; }
  header, form, .controls { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; }
  header { justify-content: space-between; }
  label { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
  button, input, select { padding: 0.45rem 0.7rem; border: 1px solid var(--border, #aaa); border-radius: 0.4rem; }
  button[aria-pressed="true"] { font-weight: 700; }
  button:disabled { opacity: 0.5; }
  video { width: 100%; background: #141414; max-height: 65vh; }
  li { margin-block: 0.4rem; }
  [role="alert"] { color: var(--danger, #b22); }
</style>
