<script lang="ts">
  import type { RosterMeetingCommand, RosterMeetingModeration } from "@surreal-ck/shared";
  import { onMount } from "svelte";
  import { getSurreal } from "../../lib/surreal";
  import { createRosterAdminApi, type EvidenceStatus, type RosterMeeting, type RosterMeetingInput, type RosterPass, type RosterWaiting } from "../../lib/meeting/roster-admin";
  import type { RosterWorkbookSheet } from "../../lib/meeting/roster-archive";
  import RosterMeetingRecords from "./RosterMeetingRecords.svelte";

  let { slug, onhost, onend, onback }: {
    slug: string; onhost: (room: string) => void; onend: (room: string | undefined) => void; onback: () => void;
  } = $props();
  const api = $derived(createRosterAdminApi(slug));
  type Preset = { key: string; label: string; sheet_key: string };
  type Sheet = RosterWorkbookSheet & { template_sheet_key?: string; presets?: Preset[] };
  let sheets = $state<Sheet[]>([]);
  let meetings = $state<RosterMeeting[]>([]);
  let meetingId = $state("");
  let meeting = $derived(meetings.find(({ id }) => id === meetingId));
  let passes = $state<RosterPass[]>([]);
  let waiting = $state<RosterWaiting[]>([]);
  let moderation = $state<RosterMeetingModeration>();
  let moderationRevision = 0;
  let rows = $state<{ id: string; name: string }[]>([]);
  let rowIds = $state<string[]>([]);
  let page = $state(0);
  let more = $state(false);
  let title = $state("");
  let scheduled = $state("");
  let sheetId = $state("");
  const sheet = $derived(sheets.find(({ id }) => String(id) === sheetId));
  const presets = $derived(sheet?.presets?.filter((preset) => preset.sheet_key === sheet?.template_sheet_key) ?? []);
  let presetKey = $state("");
  let displayField = $state("");
  let checkField = $state("");
  let checkMode = $state<"full" | "suffix4">("full");
  let admission = $state<"direct" | "waiting">("waiting");
  let concurrency = $state<"replace" | "reject">("replace");
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let evidenceStatus = $state<{ meeting: string; status: EvidenceStatus }>();
  let disposed = false;

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    error = "";
    notice = "";
    busy = true;
    try { await action(); }
    catch (cause) { error = cause instanceof Error ? cause.message : "无法完成名册会议操作"; }
    finally { busy = false; }
  }

  async function readRows(target: RosterMeeting, index: number) {
    const currentSheet = sheets.find((entry) => String(entry.id) === target.sheet_id);
    if (!currentSheet) { rows = []; more = false; return; }
    const result = await getSurreal().query<Record<string, unknown>>(
      "SELECT * FROM type::table($table) ORDER BY id LIMIT 101 START $offset",
      { table: currentSheet.table_name, offset: index * 100 },
    );
    rows = result.slice(0, 100).map((item) => {
      const value = item[target.display_field ?? ""];
      return { id: String(item.id), name: typeof value === "string" || typeof value === "number" ? String(value) : "" };
    });
    page = index;
    more = result.length > 100;
  }

  async function refreshPasses(target: RosterMeeting) {
    const [nextPasses, nextWaiting] = await Promise.all([
      api.passes(target.id), target.admission === "waiting" ? api.waiting(target.id) : Promise.resolve([]),
    ]);
    if (!disposed && meetingId === target.id) { passes = nextPasses; waiting = nextWaiting; }
  }

  async function refreshModeration(target: RosterMeeting) {
    if (!target.room_id || target.status !== "open") return;
    const revision = moderationRevision;
    const next = await api.moderation(target.id).catch(() => undefined);
    if (!disposed && meetingId === target.id && revision === moderationRevision) moderation = next;
  }

  function moderate(target: RosterMeeting, command: RosterMeetingCommand) {
    return run(async () => {
      moderationRevision++;
      moderation = await api.moderate(target.id, command);
    });
  }

  async function select(target: RosterMeeting) {
    meetingId = target.id;
    moderation = undefined;
    moderationRevision++;
    passes = []; waiting = []; rows = []; rowIds = []; more = false; page = 0;
    await Promise.all([refreshPasses(target), readRows(target, 0), refreshModeration(target)]);
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    await run(async () => {
      const input: RosterMeetingInput = { title, scheduled_at: new Date(scheduled).toISOString(), sheet_id: sheetId };
      if (presetKey) input.preset_key = presetKey;
      else {
        input.display_field = displayField;
        input.admission = admission;
        input.concurrency = concurrency;
        if (checkField) {
          input.check_field = checkField;
          input.check_mode = checkMode;
          input.check_label = sheet?.column_defs?.find((column) => column.key === checkField)?.label?.slice(0, 128) || undefined;
        }
      }
      const created = await api.create(input);
      meetings = await api.list();
      title = "";
      await select(created);
    });
  }

  function download(data: Blob) {
    const url = URL.createObjectURL(data);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "roster-meeting-invitations.csv";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice = "已下载邀请 CSV。访问码仅在此文件中，请妥善保管。";
  }

  async function decide(target: RosterMeeting, item: RosterWaiting | RosterPass, action: "admit" | "reject" | "kick") {
    await api.decide(target.id, item.id, item.generation, action);
    await refreshPasses(target);
  }

  onMount(() => {
    void run(async () => {
      [sheets, meetings] = await Promise.all([getSurreal().query<Sheet>(
        "SELECT id, label, table_name, column_defs, template_sheet_key, workbook.name AS workbook_name, workbook.template.roster_meeting_presets AS presets FROM sheet ORDER BY label",
      ), api.list()]);
    });
    const timer = setInterval(() => {
      const target = meeting;
      if (target?.status === "open" && !busy) void refreshPasses(target).catch(() => undefined);
    }, 4000);
    const moderationTimer = setInterval(() => {
      const target = meeting;
      if (target?.room_id && !busy) void refreshModeration(target);
    }, 1500);
    return () => { disposed = true; clearInterval(timer); clearInterval(moderationTimer); };
  });
</script>

<section>
  <header><h2>名册会议管理</h2><button onclick={onback}>返回会议</button></header>
  <form onsubmit={create}>
    <h3>创建名册会议</h3>
    <label>会议标题 <input required maxlength="200" bind:value={title} /></label>
    <label>计划时间 <input required type="datetime-local" bind:value={scheduled} /></label>
    <label>名册表
      <select required bind:value={sheetId} onchange={() => { presetKey = ""; displayField = ""; checkField = ""; }}>
        <option value="">选择名册表</option>
        {#each sheets as item (String(item.id))}
          <option value={String(item.id)}>{item.workbook_name ? item.workbook_name + " / " : ""}{item.label}</option>
        {/each}
      </select>
    </label>
    {#if presets.length}
      <label>模板预设
        <select bind:value={presetKey}>
          <option value="">手动配置</option>
          {#each presets as preset (preset.key)}<option value={preset.key}>{preset.label}</option>{/each}
        </select>
      </label>
    {/if}
    {#if sheet && !presetKey}
      <label>显示名字段 <select required bind:value={displayField}>
        <option value="">选择字段</option>
        {#each sheet.column_defs ?? [] as column (column.key)}<option value={column.key}>{column.label || column.key}</option>{/each}
      </select></label>
      <label>校对字段 <select bind:value={checkField}>
        <option value="">无需校对</option>
        {#each sheet.column_defs ?? [] as column (column.key)}<option value={column.key}>{column.label || column.key}</option>{/each}
      </select></label>
      {#if checkField}<label>校对方式 <select bind:value={checkMode}><option value="full">完整匹配</option><option value="suffix4">后四位</option></select></label>{/if}
      <label>准入 <select bind:value={admission}><option value="waiting">等候主持人</option><option value="direct">直接入会</option></select></label>
      <label>并发 <select bind:value={concurrency}><option value="replace">替换旧会话</option><option value="reject">拒绝新会话</option></select></label>
    {/if}
    <button disabled={busy || !sheetId}>创建会议</button>
  </form>

  <label>已创建的会议
    <select value={meetingId} disabled={busy} onchange={(event) => {
      const target = meetings.find(({ id }) => id === event.currentTarget.value);
      if (target) void run(() => select(target));
    }}>
      <option value="" disabled>选择会议</option>
      {#each meetings as item (item.id)}<option value={item.id}>{item.title} · {item.status === "open" ? "开放" : "已结束"}</option>{/each}
    </select>
  </label>
  {#if meeting}
    {@const current = meeting}
    {#if current.status === "open"}
      <div class="actions">
        {#if current.room_id}<button onclick={() => { if (current.room_id) onhost(current.room_id); }}>进入主持席</button>{/if}
        <button disabled={busy} onclick={() => void run(async () => {
          const room = await api.start(current.id);
          onhost(room.id);
          meetings = await api.list();
          if (meeting) await refreshModeration(meeting);
        })}>启动媒体房间</button>
        <button disabled={busy} onclick={() => void run(async () => {
          if (!window.confirm("确定结束此名册会议？")) return;
          moderationRevision++;
          await api.end(current.id);
          onend(current.room_id);
          meetings = await api.list();
          waiting = [];
          moderation = undefined;
        })}>结束全体会议</button>
      </div>
      {#if moderation}
        {@const controls = moderation}
        <h3>主持秩序控制</h3>
        <div class="actions">
          <button disabled={busy} aria-pressed={controls.locked}
            onclick={() => void moderate(current, { action: "lock", locked: !controls.locked })}>
            {controls.locked ? "解锁会议" : "锁定会议"}
          </button>
          <button disabled={busy} onclick={() => void moderate(current, { action: "mute-all" })}>全员静音</button>
          <label>画面聚焦
            <select disabled={busy} value={controls.focus} onchange={(event) => {
              const focus = event.currentTarget.value;
              if (focus === "auto" || focus === "speaker" || focus === "screen") void moderate(current, { action: "focus", focus });
            }}>
              <option value="auto">自动聚焦主持人共享</option>
              <option value="speaker">锁定主讲画面</option>
              <option value="screen">锁定共享画面</option>
            </select>
          </label>
        </div>
        <h4>举手队列与参会人</h4>
        <ul>
          {#each controls.participants as participant (participant.id)}
            <li>
              <span>{participant.name} · {participant.raisedAt !== undefined
                ? `举手 ${new Date(participant.raisedAt).toLocaleTimeString()}` : participant.speaking ? "可发言" : "只听"}</span>
              <button disabled={busy} onclick={() => void moderate(current, {
                action: participant.speaking ? "withdraw" : "allow", identity: participant.id,
              })}>{participant.speaking ? "收回发言权" : "允许发言"}</button>
              <button disabled={busy} onclick={() => void run(async () => {
                if (!window.confirm(`移出并吊销 ${participant.name} 的本场资格？`)) return;
                moderationRevision++;
                await api.revoke(current.id, participant.pass);
                await Promise.all([refreshPasses(current), refreshModeration(current)]);
              })}>移出并吊销本场资格</button>
            </li>
          {:else}
            <li>暂无参会人。</li>
          {/each}
        </ul>
      {/if}
      <h3>批量签发</h3>
      {#if rows.length === 0}<p>当前页面没有可选名册行。</p>{/if}
      <ul>
        {#each rows as row (row.id)}
          <li><label><input type="checkbox" checked={rowIds.includes(row.id)}
            onchange={(event) => { rowIds = event.currentTarget.checked ? [...rowIds, row.id] : rowIds.filter((id) => id !== row.id); }}
            disabled={busy || (rowIds.length >= 500 && !rowIds.includes(row.id))} /> {row.name || row.id}</label></li>
        {/each}
      </ul>
      <div class="actions">
        <button disabled={busy || page === 0} onclick={() => void run(() => readRows(current, page - 1))}>上一页</button>
        <span>第 {page + 1} 页</span>
        <button disabled={busy || !more} onclick={() => void run(() => readRows(current, page + 1))}>下一页</button>
        <button disabled={busy || !rowIds.length} onclick={() => void run(async () => {
          download(await api.issue(current.id, rowIds)); rowIds = []; await refreshPasses(current);
        })}>签发并下载 CSV（{rowIds.length}/500）</button>
      </div>
    {/if}

    {#if current.admission === "waiting" && current.status === "open"}
      <h3>等候室</h3>
      {#if !waiting.length}<p>暂无等候者。</p>{/if}
      <ul>
        {#each waiting as item (item.id)}
          <li>{item.name}
            <button disabled={busy || moderation?.locked} onclick={() => void run(() => decide(current, item, "admit"))}>准入</button>
            <button disabled={busy} onclick={() => void run(() => decide(current, item, "reject"))}>拒绝</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#key current.id}
      <RosterMeetingRecords {api} meeting={current} {sheets} />
      {#if current.status === "closed" && current.room_id}
        <h3>会议存证</h3>
        <button disabled={busy} onclick={() => void run(async () => {
          evidenceStatus = { meeting: current.id, status: await api.evidenceStatus(current.id) };
        })}>检查可信根与备份期限</button>
        <button disabled={busy} onclick={() => void run(async () => {
          await api.finalizeEvidence(current.id);
          notice = "已请求封存，请稍后检查可信根。";
        })}>请求重新封存</button>
        {#if evidenceStatus?.meeting === current.id}
          <p>可信根 SHA-256：<code>{evidenceStatus.status.root}</code></p>
          <p>保留期限：{evidenceStatus.status.retainUntil}</p>
          {#if evidenceStatus.status.backupReminder}
            <p role="alert">请立即下载并离线备份存证包；未归档证据不会自动删除。</p>
          {/if}
          <button disabled={busy} onclick={() => void run(async () => {
            const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) =>
              Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }> }).showSaveFilePicker;
            if (picker) {
              const file = await picker.call(window, { suggestedName: "meeting-evidence.tar" }).catch((cause: unknown) => {
                if (cause instanceof DOMException && cause.name === "AbortError") return;
                throw cause;
              });
              if (!file) return;
              const stream = (await api.downloadEvidence(current.id)).body;
              if (!stream) throw new Error("会议存证下载响应为空");
              await stream.pipeTo(await file.createWritable());
              return;
            }
            const blob = await (await api.downloadEvidence(current.id)).blob();
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            link.href = url;
            link.download = "meeting-evidence.tar";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          })}>下载存证包</button>
        {/if}
      {/if}
    {/key}
    <h3>参会凭证</h3>
    {#if !passes.length}<p>尚未签发凭证。</p>{/if}
    <ul>
      {#each passes as item (item.id)}
        <li>
          <span>{rows.find(({ id }) => id === item.row_id)?.name || item.row_id} · {item.status === "revoked" ? "已吊销" : "有效"}
            · {item.opened_at ? `已核验 ${new Date(item.opened_at).toLocaleString()}` : "未核验"}</span>
          {#if item.status === "active" && current.status === "open"}
            <button disabled={busy} onclick={() => void run(async () => {
              download(await api.reissue(current.id, item.row_id)); await refreshPasses(current);
            })}>补发</button>
            <button disabled={busy} onclick={() => void run(async () => {
              await api.revoke(current.id, item.id); await refreshPasses(current);
            })}>吊销</button>
            {#if item.lease_state === "admitted"}
              <button disabled={busy} onclick={() => void run(() => decide(current, item, "kick"))}>踢出</button>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
</section>

<style>
  section { display: grid; gap: 0.8rem; padding: 1rem; border: 1px solid var(--border, #aaa); border-radius: 0.75rem; }
  header, .actions, li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  header { justify-content: space-between; }
  form { display: grid; gap: 0.65rem; max-width: 36rem; }
  label { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 0.4rem; }
  input, select, button { padding: 0.35rem 0.6rem; border: 1px solid var(--border, #aaa); border-radius: 0.35rem; }
  ul { display: grid; gap: 0.4rem; }
  button:disabled { opacity: 0.5; }
  [role="alert"] { color: var(--danger, #b22); }
</style>
