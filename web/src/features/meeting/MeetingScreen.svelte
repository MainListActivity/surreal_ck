<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    Copy,
    LogIn,
    Mic,
    MicOff,
    MonitorUp,
    MonitorX,
    PhoneOff,
    Send,
    UserPlus,
    Users,
    Video,
    VideoOff,
  } from "@lucide/svelte";
  import MediaTrackView from "./MediaTrackView.svelte";
  import GuestHostPanel from "./GuestHostPanel.svelte";
  import { getSurreal } from "../../lib/surreal";
  import { loadMembers, type WorkspaceMember } from "../../lib/members-data";
  import {
    checkMeetingSupport,
    IN_APP_LABELS,
    OPEN_IN_SYSTEM_BROWSER,
    readMeetingSupportEnv,
  } from "../../lib/meeting/browser-support";
  import { MeetingController, type MeetingPhase, type MeetingView } from "../../lib/meeting/controller";
  import { BrowserMeetingEdge, MAX_CHAT_BYTES } from "../../lib/meeting/edge";
  import { fetchMeetingIce } from "../../lib/meeting/ice";
  import {
    createLevelMeter,
    DEVICE_ERROR_MESSAGES,
    LocalMedia,
    type DeviceError,
  } from "../../lib/meeting/local-media";
  import {
    createMeetingRpc,
    meetingErrorMessage,
    randomMeetingId,
    type MeetingInvitation,
  } from "../../lib/meeting/rpc";
  import type { MeetingSource } from "../../lib/meeting/sdp";
  import { createMeetingV2Rpc, isV2MeetingCode } from "../../lib/meeting/v2";

  // M-05 浏览器会议：工作区内部成员免安装入会，与原生 App 共用 V1 网状房间。
  // 设备默认关闭，只在用户点击后申请权限；任何终态都立即 stop 全部本地轨道。
  type Stage = "lobby" | "prejoin" | "room" | "finished";
  type Pending = { kind: "create"; external?: boolean } | { kind: "join"; code: string };

  const support = checkMeetingSupport(readMeetingSupportEnv());
  const rpc = createMeetingRpc(getSurreal());
  const media = new LocalMedia(
    typeof navigator !== "undefined" && navigator.mediaDevices
      ? navigator.mediaDevices
      : { getUserMedia: () => Promise.reject(Object.assign(new Error("unsupported"), { name: "NotSupportedError" })) },
  );

  let stage = $state<Stage>("lobby");
  let pending = $state<Pending | null>(null);
  let joinCode = $state("");
  let lobbyError = $state<string | null>(null);
  let busy = $state(false);
  let invitations = $state<MeetingInvitation[]>([]);
  let members = $state<WorkspaceMember[]>([]);
  let local = $state<Record<MeetingSource, MediaStreamTrack | null>>({ microphone: null, camera: null, screen: null });
  let deviceErrors = $state<Partial<Record<MeetingSource, DeviceError>>>({});
  let level = $state(0);
  let view = $state<MeetingView | null>(null);
  let finishedPhase = $state<MeetingPhase | null>(null);
  let chatText = $state("");
  let chatNotice = $state<string | null>(null);
  let showInvite = $state(false);
  let inviteSelection = $state<string[]>([]);
  let inviteNotice = $state<string | null>(null);
  let copied = $state(false);

  let controller: MeetingController | null = null;
  let unsubscribe: (() => void) | null = null;
  let invitationTimer: ReturnType<typeof setInterval> | null = null;

  const unsubscribeMedia = media.subscribe((source, track) => {
    local = { ...local, [source]: track };
    void controller?.setLocalTrack(source, track);
  });

  const memberNames = $derived(new Map(members.map((m) => [m.id, m.displayName || m.email])));
  const peers = $derived(view?.peers ?? []);
  const inviteCandidates = $derived(
    members.filter((m) => !m.pending && m.id !== view?.localMember && !peers.some((p) => p.member === m.id)),
  );
  const chatPeers = $derived(peers.filter((p) => p.chat).length);

  function nameOf(member: string | null | undefined): string {
    if (!member) return "成员";
    if (member.startsWith("guest:")) return "访客";
    if (member.startsWith("member:")) return "工作区成员";
    return memberNames.get(member) ?? member.replace(/^user:/, "");
  }

  function memberKey(id: string): string {
    return id.replace(/^user:/, "").replace(/^[⟨`]|[⟩`]$/g, "");
  }

  async function refreshInvitations(): Promise<void> {
    if (stage !== "lobby") return;
    try {
      invitations = await rpc.invitations();
    } catch {
      invitations = [];
    }
  }

  onMount(() => {
    if (support.kind !== "supported") return;
    void loadMembers(getSurreal()).then((rows) => (members = rows)).catch(() => undefined);
    void refreshInvitations();
    invitationTimer = setInterval(() => void refreshInvitations(), 10_000);
    window.addEventListener("pagehide", onPageHide);
  });

  onDestroy(() => {
    if (invitationTimer) clearInterval(invitationTimer);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    void controller?.leave();
    unsubscribe?.();
    unsubscribeMedia();
    media.stopAll();
  });

  function onPageHide(): void {
    controller?.leaveOnUnload();
    media.stopAll();
  }

  // 麦克风电平条：只在有麦克风轨道时运行。
  $effect(() => {
    const track = local.microphone;
    if (!track) {
      level = 0;
      return;
    }
    const meter = createLevelMeter(track);
    let frame = 0;
    const loop = () => {
      level = meter.read();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      meter.close();
    };
  });

  async function toggle(source: MeetingSource): Promise<void> {
    if (media.has(source)) {
      media.stop(source);
      return;
    }
    const error = await media.start(source);
    deviceErrors = { ...deviceErrors, [source]: error ?? undefined };
  }

  function openPrejoin(next: Pending): void {
    lobbyError = null;
    if (next.kind === "join" && !/^[A-Za-z0-9]{4,64}$/.test(next.code.trim()) && !isV2MeetingCode(next.code.trim().toUpperCase())) {
      lobbyError = "请输入有效的会议号";
      return;
    }
    pending = next;
    stage = "prejoin";
  }

  function cancelPrejoin(): void {
    media.stopAll();
    pending = null;
    stage = "lobby";
    void refreshInvitations();
  }

  async function enter(): Promise<void> {
    if (!pending || busy) return;
    busy = true;
    lobbyError = null;
    const v2 = pending.kind === "create" ? pending.external : isV2MeetingCode(pending.code.trim().toUpperCase());
    const next = new MeetingController({
      rpc: v2 ? createMeetingV2Rpc("member") : rpc,
      fetchIce: fetchMeetingIce,
      createEdge: (options) => new BrowserMeetingEdge(options),
      localTrack: (source) => media.track(source),
      randomId: randomMeetingId,
      onTerminated: (phase) => {
        media.stopAll();
        finishedPhase = phase;
        stage = "finished";
      },
    });
    controller = next;
    unsubscribe = next.subscribe((value) => (view = value));
    try {
      if (pending.kind === "create") await next.create();
      else await next.join(pending.code.trim().toUpperCase());
      stage = "room";
    } catch (error) {
      lobbyError = meetingErrorMessage(error);
      unsubscribe?.();
      unsubscribe = null;
      controller = null;
      view = null;
      stage = "prejoin";
    } finally {
      busy = false;
    }
  }

  async function leave(): Promise<void> {
    media.stopAll();
    await controller?.leave();
  }

  async function endMeeting(): Promise<void> {
    if (!confirm("确定结束会议？所有参会者都会被移出。")) return;
    await controller?.end();
  }

  function backToLobby(): void {
    unsubscribe?.();
    unsubscribe = null;
    controller = null;
    view = null;
    pending = null;
    finishedPhase = null;
    chatText = "";
    stage = "lobby";
    void refreshInvitations();
  }

  function sendChat(event: SubmitEvent): void {
    event.preventDefault();
    const text = chatText.trim();
    if (!text || !controller) return;
    if (new TextEncoder().encode(text).length > MAX_CHAT_BYTES) {
      chatNotice = "消息过长";
      return;
    }
    const delivered = controller.sendChat(text);
    chatText = "";
    chatNotice =
      peers.length === 0
        ? null
        : delivered < peers.length
          ? "部分参会者（原生客户端或未连通）暂时收不到会中文字消息"
          : null;
  }

  async function sendInvites(): Promise<void> {
    if (!controller || inviteSelection.length === 0) return;
    try {
      const invited = await controller.invite(inviteSelection.map(memberKey));
      inviteNotice = `已邀请 ${invited.length} 人`;
      inviteSelection = [];
      showInvite = false;
    } catch (error) {
      inviteNotice = meetingErrorMessage(error);
    }
  }

  async function copyCode(): Promise<void> {
    const code = view?.room?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  const STATUS_LABELS = {
    waiting: "等待连接",
    connecting: "连接中",
    direct: "直连",
    relay: "中继",
    failed: "连接失败，重试中",
  } as const;

  const FINISHED_MESSAGES: Partial<Record<MeetingPhase, string>> = {
    ended: "会议已结束",
    left: "你已离开会议",
    removed: "你已不在会议中（会议失效或被移出）",
    failed: "入会失败",
  };
</script>

<section class="meeting" data-testid="meeting-screen">
  {#if support.kind === "in-app"}
    <div class="notice-card" data-testid="meeting-in-app">
      <h2>请在系统浏览器中打开会议</h2>
      <p>{IN_APP_LABELS[support.app]}内置浏览器无法使用摄像头、麦克风和屏幕共享。</p>
      <p class="strong">{OPEN_IN_SYSTEM_BROWSER}</p>
    </div>
  {:else if support.kind === "unsupported"}
    <div class="notice-card" data-testid="meeting-unsupported">
      <h2>当前浏览器无法参加会议</h2>
      <p>{support.reason}。请使用最新版 Chrome、Edge 或 Safari。</p>
    </div>
  {:else if stage === "lobby"}
    <header class="head">
      <h1>会议</h1>
      <p>免安装浏览器会议，与 macOS / Windows / Android 协同 App 互通（当前每场最多 4 人）。</p>
    </header>
    <div class="lobby">
      <div class="card">
        <h2>发起会议</h2>
        <p>创建会议后可邀请工作区成员，被邀请者凭会议号加入。</p>
        <button class="primary" data-testid="meeting-create" onclick={() => openPrejoin({ kind: "create" })}>
          <Video size={16} />立即开会
        </button>
        <button onclick={() => openPrejoin({ kind: "create", external: true })}>创建可邀请访客的会议</button>
      </div>
      <form class="card" onsubmit={(e) => { e.preventDefault(); openPrejoin({ kind: "join", code: joinCode }); }}>
        <h2>加入会议</h2>
        <input
          data-testid="meeting-code-input"
          placeholder="输入会议号"
          autocomplete="off"
          autocapitalize="characters"
          bind:value={joinCode}
        />
        <button class="primary" type="submit" data-testid="meeting-join"><LogIn size={16} />加入</button>
      </form>
      <div class="card">
        <h2>进行中的会议</h2>
        {#if invitations.length === 0}
          <p class="muted">暂无邀请你的进行中会议</p>
        {:else}
          <ul class="invites">
            {#each invitations as invitation (invitation.room)}
              <li>
                <span>{nameOf(invitation.host)} 的会议 · {invitation.code}</span>
                <button onclick={() => openPrejoin({ kind: "join", code: invitation.code })}>加入</button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
    {#if lobbyError}<p class="error" role="alert">{lobbyError}</p>{/if}
  {:else if stage === "prejoin"}
    <header class="head">
      <h1>{pending?.kind === "create" ? "发起会议" : `加入会议 ${pending?.kind === "join" ? pending.code.toUpperCase() : ""}`}</h1>
      <p>入会前检查设备。摄像头和麦克风都可以不开，仅收听也能入会。</p>
    </header>
    <div class="prejoin">
      <div class="preview">
        {#if local.camera}
          <MediaTrackView track={local.camera} kind="video" mirror label="摄像头预览" />
        {:else}
          <div class="placeholder"><VideoOff size={32} /><span>摄像头未开启</span></div>
        {/if}
      </div>
      <div class="device-panel">
        <button class:on={!!local.microphone} data-testid="prejoin-mic" onclick={() => toggle("microphone")}>
          {#if local.microphone}<Mic size={16} />关闭麦克风{:else}<MicOff size={16} />开启麦克风{/if}
        </button>
        <div class="meter" aria-label="麦克风音量"><span style={`width:${Math.round(level * 100)}%`}></span></div>
        {#if deviceErrors.microphone}<p class="warn">麦克风：{DEVICE_ERROR_MESSAGES[deviceErrors.microphone]}，可仅收听入会</p>{/if}
        <button class:on={!!local.camera} data-testid="prejoin-camera" onclick={() => toggle("camera")}>
          {#if local.camera}<Video size={16} />关闭摄像头{:else}<VideoOff size={16} />开启摄像头{/if}
        </button>
        {#if deviceErrors.camera}<p class="warn">摄像头：{DEVICE_ERROR_MESSAGES[deviceErrors.camera]}，将以纯音频入会</p>{/if}
        <div class="actions">
          <button onclick={cancelPrejoin}>返回</button>
          <button class="primary" data-testid="prejoin-enter" disabled={busy} onclick={enter}>
            {busy ? "正在入会…" : local.camera ? "入会" : "纯音频入会"}
          </button>
        </div>
        {#if lobbyError}<p class="error" role="alert">{lobbyError}</p>{/if}
      </div>
    </div>
  {:else if stage === "room" && view}
    <div class="room" data-testid="meeting-room">
      <div class="room-bar">
        <span class="code" data-testid="meeting-code">会议号 {view.room?.code}</span>
        <button class="icon" onclick={copyCode} aria-label="复制会议号"><Copy size={14} />{copied ? "已复制" : "复制"}</button>
        <span class="count"><Users size={14} />{peers.length + 1} 人</span>
        {#if view.overflow > 0}<span class="warn">另有 {view.overflow} 人超出网状会议上限</span>{/if}
        {#if view.error}<span class="error">{view.error}</span>{/if}
      </div>
      <div class="stage-grid" class:solo={peers.length === 0}>
        <div class="tile self">
          {#if local.screen}
            <MediaTrackView track={local.screen} kind="video" label="我的共享" />
          {:else if local.camera}
            <MediaTrackView track={local.camera} kind="video" mirror label="我的画面" />
          {:else}
            <div class="placeholder"><span>{nameOf(view.localMember)}（我）</span></div>
          {/if}
          <span class="tag">我{view.isHost ? " · 主持人" : ""}{local.microphone ? "" : " · 静音"}</span>
        </div>
        {#each peers as peer (peer.joinId)}
          <div class="tile" data-testid="meeting-peer" data-status={peer.status}>
            {#if peer.tracks.screen}
              <MediaTrackView track={peer.tracks.screen} kind="video" label={`${nameOf(peer.member)} 的共享`} />
            {:else if peer.tracks.camera}
              <MediaTrackView track={peer.tracks.camera} kind="video" label={nameOf(peer.member)} />
            {:else}
              <div class="placeholder"><span>{nameOf(peer.member)}</span></div>
            {/if}
            {#if peer.tracks.screen && peer.tracks.camera}
              <div class="pip"><MediaTrackView track={peer.tracks.camera} kind="video" label={nameOf(peer.member)} /></div>
            {/if}
            {#if peer.tracks.microphone}
              <MediaTrackView track={peer.tracks.microphone} kind="audio" label={`${nameOf(peer.member)} 的声音`} />
            {/if}
            <span class="tag">{nameOf(peer.member)}{view.room?.host === peer.member ? " · 主持人" : ""} · {STATUS_LABELS[peer.status]}</span>
          </div>
        {/each}
      </div>
      <aside class="side">
        <h3>成员</h3>
        <ul class="members" data-testid="meeting-members">
          <li>{nameOf(view.localMember)}（我）</li>
          {#each peers as peer (peer.joinId)}
            <li>{nameOf(peer.member)} <small>{STATUS_LABELS[peer.status]}</small></li>
          {/each}
        </ul>
        {#if view.isHost}
          <button onclick={() => (showInvite = !showInvite)}><UserPlus size={14} />邀请成员</button>
          {#if showInvite}
            <div class="invite-box">
              {#each inviteCandidates as member (member.id)}
                <label><input type="checkbox" value={member.id} bind:group={inviteSelection} />{member.displayName || member.email}</label>
              {:else}
                <p class="muted">没有可邀请的成员</p>
              {/each}
              <button class="primary" disabled={inviteSelection.length === 0} onclick={sendInvites}>发送邀请</button>
            </div>
          {/if}
          {#if inviteNotice}<p class="muted">{inviteNotice}</p>{/if}
          {#if view.room && view.localJoin && isV2MeetingCode(view.room.code)}
            <GuestHostPanel room={view.room.id} join={view.localJoin} />
          {/if}
        {/if}
        <h3>聊天</h3>
        <ol class="chat" data-testid="meeting-chat">
          {#each view.chat as entry (entry.id)}
            <li class:self={entry.self}><b>{entry.self ? "我" : nameOf(entry.member)}</b>{entry.text}</li>
          {/each}
        </ol>
        <form class="chat-form" onsubmit={sendChat}>
          <input data-testid="meeting-chat-input" placeholder={chatPeers > 0 ? "发送消息" : "等待可聊天的参会者"} bind:value={chatText} />
          <button type="submit" aria-label="发送"><Send size={14} /></button>
        </form>
        {#if chatNotice}<p class="muted">{chatNotice}</p>{/if}
      </aside>
      <div class="controls">
        <button class:on={!!local.microphone} data-testid="room-mic" onclick={() => toggle("microphone")} aria-label="麦克风">
          {#if local.microphone}<Mic size={18} />{:else}<MicOff size={18} />{/if}<span>麦克风</span>
        </button>
        <button class:on={!!local.camera} data-testid="room-camera" onclick={() => toggle("camera")} aria-label="摄像头">
          {#if local.camera}<Video size={18} />{:else}<VideoOff size={18} />{/if}<span>摄像头</span>
        </button>
        {#if support.canShareScreen}
          <button class:on={!!local.screen} data-testid="room-screen" onclick={() => toggle("screen")} aria-label="共享屏幕">
            {#if local.screen}<MonitorX size={18} />{:else}<MonitorUp size={18} />{/if}<span>{local.screen ? "停止共享" : "共享屏幕"}</span>
          </button>
        {/if}
        <button class="danger" data-testid="room-leave" onclick={leave}><PhoneOff size={18} /><span>离开</span></button>
        {#if view.isHost}
          <button class="danger solid" data-testid="room-end" onclick={endMeeting}><span>结束会议</span></button>
        {/if}
      </div>
      {#if deviceErrors.camera || deviceErrors.microphone || deviceErrors.screen}
        <p class="warn device-warn">
          {#each Object.entries(deviceErrors) as [source, error] (source)}
            {#if error}<span>{source === "microphone" ? "麦克风" : source === "camera" ? "摄像头" : "屏幕共享"}：{DEVICE_ERROR_MESSAGES[error]}</span>{/if}
          {/each}
        </p>
      {/if}
    </div>
  {:else if stage === "finished"}
    <div class="notice-card" data-testid="meeting-finished">
      <h2>{FINISHED_MESSAGES[finishedPhase ?? "left"] ?? "会议已结束"}</h2>
      <p>摄像头、麦克风和屏幕共享均已释放。</p>
      <button class="primary" onclick={backToLobby}>返回会议首页</button>
    </div>
  {/if}
</section>

<style>
  .meeting {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 100%;
    box-sizing: border-box;
    color: var(--text-1);
  }
  .head h1 {
    margin: 0 0 4px;
    font-size: 20px;
  }
  .head p,
  .muted {
    margin: 0;
    color: var(--text-3);
    font-size: 13px;
  }
  .lobby {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 16px;
  }
  .card,
  .notice-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .notice-card {
    max-width: 460px;
    margin: 40px auto;
    text-align: center;
    align-items: center;
  }
  .card h2,
  .notice-card h2 {
    margin: 0;
    font-size: 15px;
  }
  .card p,
  .notice-card p {
    margin: 0;
    font-size: 13px;
    color: var(--text-2);
  }
  .strong {
    font-weight: 600;
    color: var(--primary) !important;
    font-size: 15px !important;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-1);
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button.primary {
    background: var(--primary);
    border-color: var(--primary);
    color: #fff;
  }
  button.on {
    border-color: var(--primary);
    color: var(--primary);
  }
  button.danger {
    color: var(--error);
    border-color: var(--error);
  }
  button.danger.solid {
    background: var(--error);
    color: #fff;
  }
  input {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    font: inherit;
    font-size: 14px;
    background: var(--surface);
    color: var(--text-1);
    min-width: 0;
  }
  .invites {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  .invites li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .error {
    color: var(--error);
    font-size: 13px;
    margin: 0;
  }
  .warn {
    color: var(--warning);
    font-size: 12px;
    margin: 0;
  }
  .prejoin {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(240px, 1fr);
    gap: 16px;
  }
  .preview,
  .tile {
    position: relative;
    background: #1d1f24;
    border-radius: 10px;
    overflow: hidden;
    aspect-ratio: 4 / 3;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: #c9ccd3;
    font-size: 14px;
  }
  .device-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .meter {
    height: 6px;
    border-radius: 3px;
    background: var(--soft);
    overflow: hidden;
  }
  .meter span {
    display: block;
    height: 100%;
    background: var(--success);
    transition: width 80ms linear;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: auto;
  }
  .room {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 280px;
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas: "bar bar" "grid side" "controls controls";
    gap: 12px;
    min-height: calc(100vh - 48px);
  }
  .room-bar {
    grid-area: bar;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .code {
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .count {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-2);
  }
  button.icon {
    padding: 4px 8px;
  }
  .stage-grid {
    grid-area: grid;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    align-content: start;
  }
  .stage-grid.solo {
    grid-template-columns: minmax(0, 1fr);
  }
  .tag {
    position: absolute;
    left: 8px;
    bottom: 8px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 6px;
  }
  .pip {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 28%;
    aspect-ratio: 4 / 3;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.4);
  }
  .side {
    grid-area: side;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    background: var(--surface);
    min-height: 0;
  }
  .side h3 {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--text-2);
  }
  .members,
  .chat {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .members small {
    color: var(--text-3);
  }
  .chat {
    flex: 1;
    overflow-y: auto;
    min-height: 120px;
    word-break: break-word;
  }
  .chat b {
    margin-right: 6px;
  }
  .chat li.self b {
    color: var(--primary);
  }
  .chat-form {
    display: flex;
    gap: 6px;
  }
  .chat-form input {
    flex: 1;
  }
  .invite-box {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    max-height: 180px;
    overflow-y: auto;
  }
  .controls {
    grid-area: controls;
    display: flex;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .device-warn {
    grid-column: 1 / -1;
    display: flex;
    gap: 12px;
    justify-content: center;
  }

  /* 手机竖屏（iOS Safari / Android Chrome）：单列布局，控制条固定在底部。 */
  @media (max-width: 720px) {
    .meeting {
      padding: 12px;
    }
    .prejoin {
      grid-template-columns: minmax(0, 1fr);
    }
    .room {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "bar" "grid" "side" "controls";
      min-height: auto;
      padding-bottom: 72px;
    }
    .stage-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .controls {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 10px max(10px, env(safe-area-inset-left)) calc(10px + env(safe-area-inset-bottom));
      background: var(--surface);
      border-top: 1px solid var(--border);
      z-index: 10;
      gap: 6px;
    }
    .controls button span {
      display: none;
    }
    .controls button.solid span {
      display: inline;
    }
  }
</style>
