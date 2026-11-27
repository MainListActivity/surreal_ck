<script lang="ts">
  import { onMount } from "svelte";
  import { RosterRequestError, type createPublicRosterApi } from "../../lib/meeting/roster";
  import { canCastRosterBallot, downloadMeetingFile, isPollClosed, type RosterPoll } from "../../lib/meeting/roster-polls";

  let { api, ended }: { api: ReturnType<typeof createPublicRosterApi>; ended: boolean } = $props();
  let polls = $state<RosterPoll[]>([]);
  let now = $state(Date.now());
  let loading = $state(true);
  let loadError = $state("");
  let actionError = $state("");
  let busy = $state("");
  type Attempt = { option: string; note?: string; requestId: string };
  let drafts = $state<Record<string, { option: string; note: string; attempt?: Attempt }>>({});
  let disposed = false;
  let refreshing = false;
  let revision = 0;

  async function refresh() {
    if (refreshing || busy || disposed) return;
    const requested = revision;
    refreshing = true;
    try {
      const next = await api.polls();
      if (!disposed && requested === revision) { polls = next; loadError = ""; }
    } catch (cause) {
      if (!disposed && requested === revision) {
        loadError = cause instanceof RosterRequestError ? cause.message : "暂时无法加载表决，将自动重试。";
        if (cause instanceof RosterRequestError && [401, 403].includes(cause.status)) {
          polls = [];
          drafts = {};
        }
      }
    } finally {
      refreshing = false;
      loading = false;
    }
  }

  function edit(poll: RosterPoll) {
    actionError = "";
    drafts[poll.id] = { option: poll.ballot?.option ?? "", note: poll.ballot?.note ?? "" };
  }

  async function vote(event: SubmitEvent, poll: RosterPoll) {
    event.preventDefault();
    const draft = drafts[poll.id];
    if (busy || !draft?.option || !canCastRosterBallot(poll, Date.now(), ended)) return;
    busy = poll.id;
    actionError = "";
    revision++;
    try {
      const note = draft.note.trim() || undefined;
      const attempt = draft.attempt?.option === draft.option && draft.attempt.note === note
        ? draft.attempt : { option: draft.option, note, requestId: crypto.randomUUID() };
      draft.attempt = attempt;
      const ballot = await api.vote(poll.id, attempt);
      if (!disposed) {
        polls = polls.map((item) => item.id === poll.id ? { ...item, ballot } : item);
        delete drafts[poll.id];
      }
    } catch (cause) {
      actionError = cause instanceof RosterRequestError ? cause.message : "提交表决失败，请重试。";
    } finally {
      busy = "";
      void refresh();
    }
  }

  async function receipt(poll: RosterPoll) {
    if (busy) return;
    actionError = "";
    busy = poll.id;
    try {
      const file = await api.receipt(poll.id);
      if (!disposed) downloadMeetingFile(file, `个人表决回执-${poll.title}-${poll.version}.pdf`);
    } catch (cause) {
      actionError = cause instanceof RosterRequestError ? cause.message : "下载个人回执失败，请重试。";
    } finally { busy = ""; }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => {
      now = Date.now();
      void refresh();
    }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  });
</script>

<section aria-label="会议表决">
  <h2>会议表决</h2>
  {#if loading}<p role="status">正在加载表决…</p>{/if}
  {#if loadError}<p role="alert">{loadError}</p>{/if}
  {#if actionError}<p role="alert">{actionError}</p>{/if}
  {#each polls as poll (poll.id)}
    {@const draft = drafts[poll.id]}
    {@const editable = canCastRosterBallot(poll, now, ended)}
    <article>
      <h3>{poll.title} · 版本 {poll.version}</h3>
      <p>{ended || isPollClosed(poll.deadline, now) ? "已截止" : "进行中"} · 截止 {new Date(poll.deadline).toLocaleString()} ·
        {poll.allowChange ? "截止前可改票" : "提交后不可更改"}</p>
      {#if poll.ballot}
        <p>已提交：{poll.options.find(({ key }) => key === poll.ballot?.option)?.label ?? poll.ballot.option}
          · {new Date(poll.ballot.at).toLocaleString()}</p>
        {#if poll.ballot.note}<p>书面意见：{poll.ballot.note}</p>{/if}
        <button disabled={!!busy} onclick={() => void receipt(poll)}>下载个人回执 PDF</button>
      {/if}
      {#if editable}
        {#if draft}
          <form onsubmit={(event) => void vote(event, poll)}>
            <label>选择选项
              <select required bind:value={draft.option} disabled={!!busy}>
                <option value="" disabled>请选择</option>
                {#each poll.options as option (option.key)}<option value={option.key}>{option.label}</option>{/each}
              </select>
            </label>
            <label>书面异议或意见（选填）<textarea bind:value={draft.note} disabled={!!busy}></textarea></label>
            <div>
              <button disabled={!!busy || !draft.option}>确认提交</button>
              <button type="button" disabled={!!busy} onclick={() => { delete drafts[poll.id]; }}>取消</button>
            </div>
          </form>
        {:else}
          <button disabled={!!busy} onclick={() => edit(poll)}>{poll.ballot ? "修改表决" : "填写表决"}</button>
        {/if}
      {/if}
    </article>
  {:else}
    {#if !loading && !loadError}<p>暂无表决议题。</p>{/if}
  {/each}
</section>

<style>
  section, article, form, label { display: grid; gap: 0.5rem; }
  article { padding: 0.75rem; border: 1px solid var(--border, #aaa); border-radius: 0.5rem; }
  button, select, textarea { padding: 0.45rem 0.6rem; border: 1px solid var(--border, #aaa); border-radius: 0.4rem; }
  button { justify-self: start; }
</style>
