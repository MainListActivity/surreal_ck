<script lang="ts">
  import { onMount } from "svelte";
  import { getSurreal } from "../../lib/surreal";
  import type { createRosterAdminApi, RosterMeeting } from "../../lib/meeting/roster-admin";
  import {
    archiveFields, buildRosterArchiveCsv, isRosterArchiveSheet, printRosterArchive, readRosterArchive,
    type ArchiveKind, type RosterArchiveConfig, type RosterArchiveSheets, type RosterWorkbookSheet,
  } from "../../lib/meeting/roster-archive";
  import { downloadMeetingFile, isPollClosed, type RosterPollOption, type RosterPollResult } from "../../lib/meeting/roster-polls";

  let { api, meeting, sheets }: {
    api: ReturnType<typeof createRosterAdminApi>; meeting: RosterMeeting; sheets: RosterWorkbookSheet[];
  } = $props();
  let polls = $state<RosterPollResult[]>([]);
  let now = $state(Date.now());
  let loadingPolls = $state(true);
  let pollsError = $state("");
  let creating = $state(false);
  let createError = $state("");
  let agendaIndex = $state("");
  let title = $state("");
  let deadline = $state("");
  let allowChange = $state(false);
  let options = $state<RosterPollOption[]>([{ key: "option_1", label: "" }, { key: "option_2", label: "" }]);
  let nextOption = 3;

  let defaults = $state<RosterArchiveConfig["defaults"]>();
  let attendanceSheet = $state("");
  let voteSheet = $state("");
  let weightField = $state("");
  let saved = $state<(RosterArchiveSheets & { weightField?: string })>();
  let archiveLoading = $state(true);
  let archiveBusy = $state(false);
  let archiveReady = $state(false);
  let archiveError = $state("");
  let archiveNotice = $state("");
  let disposed = false;
  let refreshing = false;
  let revision = 0;
  let lastRequestedStatus: RosterMeeting["status"] | undefined;
  const weightColumns = $derived(
    sheets.find((entry) => String(entry.id) === meeting.sheet_id)?.column_defs?.filter(
      ({ field_type }) => field_type === "number" || field_type === "decimal",
    ) ?? [],
  );
  const attendanceSheets = $derived(sheets.filter((entry) => isRosterArchiveSheet(entry, "attendance")));
  const voteSheets = $derived(sheets.filter((entry) => isRosterArchiveSheet(entry, "vote")));
  const targetsAvailable = $derived(attendanceSheets.some((entry) => String(entry.id) === attendanceSheet)
    && voteSheets.some((entry) => String(entry.id) === voteSheet) && attendanceSheet !== voteSheet);
  const dirty = $derived(saved?.attendanceSheet !== attendanceSheet || saved?.voteSheet !== voteSheet
    || (saved?.weightField ?? "") !== weightField);

  function errorText(cause: unknown, fallback: string) {
    return cause instanceof Error ? cause.message : fallback;
  }

  async function refreshPolls() {
    if (refreshing || creating || disposed) return;
    const requested = revision;
    refreshing = true;
    lastRequestedStatus = meeting.status;
    try {
      const next = await api.polls(meeting.id);
      if (!disposed && requested === revision) { polls = next; pollsError = ""; }
    } catch (cause) {
      if (!disposed && requested === revision) pollsError = errorText(cause, "无法加载表决议题。");
    } finally { refreshing = false; loadingPolls = false; }
  }

  function applyAgenda(value: string) {
    const item = value ? defaults?.agenda?.[Number(value)] : undefined;
    if (!item) return;
    title = item.title;
    options = item.options.map((option) => ({ ...option }));
    allowChange = item.allowChange;
  }

  function addOption() {
    let key: string;
    do { key = `option_${nextOption++}`; } while (options.some((entry) => entry.key === key));
    options.push({ key, label: "" });
  }

  async function createPoll(event: SubmitEvent) {
    event.preventDefault();
    if (creating || meeting.status !== "open") return;
    const due = new Date(deadline);
    if (isPollClosed(deadline, Date.now())) { createError = "截止时间必须晚于当前时间。"; return; }
    const trimmed = options.map(({ key, label }) => ({ key, label: label.trim() }));
    if (!title.trim() || trimmed.length < 2 || trimmed.some(({ label }) => !label)
        || new Set(trimmed.map(({ label }) => label)).size !== trimmed.length) {
      createError = "请填写议题和至少两个不同的选项。";
      return;
    }
    creating = true;
    createError = "";
    revision++;
    try {
      await api.createPoll(meeting.id, { title: title.trim(), deadline: due.toISOString(), options: trimmed, allowChange });
      title = deadline = agendaIndex = "";
      allowChange = false;
      options = [{ key: "option_1", label: "" }, { key: "option_2", label: "" }];
      nextOption = 3;
    } catch (cause) { createError = errorText(cause, "无法发起表决。"); }
    finally { creating = false; void refreshPolls(); }
  }

  async function loadConfig() {
    archiveLoading = true;
    archiveError = "";
    archiveReady = false;
    try {
      const config = await api.archiveConfig(meeting.id);
      if (disposed) return;
      defaults = config.defaults;
      attendanceSheet = config.attendanceSheet ?? "";
      voteSheet = config.voteSheet ?? "";
      saved = attendanceSheet && voteSheet
        ? { attendanceSheet, voteSheet, weightField: config.weightField } : undefined;
      weightField = saved ? saved.weightField ?? "" : config.defaults?.weightField ?? "";
      archiveReady = true;
    } catch (cause) { archiveError = errorText(cause, "无法加载归档配置。"); }
    finally { archiveLoading = false; }
  }

  async function runArchive(action: () => Promise<void>) {
    if (archiveBusy) return;
    archiveBusy = true;
    archiveError = archiveNotice = "";
    try { await action(); }
    catch (cause) { archiveError = errorText(cause, "无法完成归档操作。"); }
    finally { archiveBusy = false; }
  }

  function saveConfig(event: SubmitEvent) {
    event.preventDefault();
    if (!archiveReady || !targetsAvailable) return;
    void runArchive(async () => {
      const input = { attendanceSheet, voteSheet, weightField: weightField || undefined };
      await api.saveArchiveConfig(meeting.id, input);
      saved = input;
      archiveNotice = "归档配置已保存。";
    });
  }

  function generateArchive() {
    if (!saved || dirty) return;
    void runArchive(async () => {
      const written = await api.archive(meeting.id);
      if (!disposed) {
        saved = { ...written, weightField: saved?.weightField };
        attendanceSheet = written.attendanceSheet;
        voteSheet = written.voteSheet;
        archiveNotice = "归档已回写，可以导出。";
      }
    });
  }

  function exportArchive(kind: ArchiveKind, format: "csv" | "pdf") {
    if (!saved || dirty || archiveBusy) return;
    const sheet = kind === "attendance" ? saved.attendanceSheet : saved.voteSheet;
    const printable = format === "pdf" ? window.open("", "_blank") : null;
    if (format === "pdf" && !printable) { archiveError = "浏览器阻止了打印窗口，请允许弹出窗口后重试。"; return; }
    if (printable) {
      printable.opener = null;
      printable.document.body.textContent = "正在读取归档数据…";
    }
    void runArchive(async () => {
      try {
        const table = await readRosterArchive(getSurreal(), meeting.id, sheet, kind);
        if (disposed) { printable?.close(); return; }
        if (printable) printRosterArchive(printable, meeting.title, table);
        else downloadMeetingFile(new Blob([buildRosterArchiveCsv(table)], { type: "text/csv;charset=utf-8" }),
          `${meeting.title}-${table.label}.csv`);
        if (!table.rows.length) archiveNotice = "该数据表没有这场会议的归档记录。若尚未回写，请先生成会议归档。";
      } catch (cause) { printable?.close(); throw cause; }
    });
  }

  onMount(() => {
    void refreshPolls();
    void loadConfig();
    const timer = setInterval(() => {
      now = Date.now();
      if (meeting.status === "open" || meeting.status !== lastRequestedStatus || pollsError) void refreshPolls();
    }, 4000);
    return () => { disposed = true; clearInterval(timer); };
  });
</script>

<section aria-label="表决与会议归档">
  <h3>会议表决</h3>
  {#if meeting.status === "open"}
    <form onsubmit={createPoll}>
      {#if defaults?.agenda?.length}
        <label>预置议程
          <select bind:value={agendaIndex} onchange={(event) => applyAgenda(event.currentTarget.value)} disabled={creating}>
            <option value="">自定义议题</option>
            {#each defaults.agenda as item, index}<option value={String(index)}>{item.title}</option>{/each}
          </select>
        </label>
      {/if}
      <label>议题 <input required bind:value={title} disabled={creating} /></label>
      <label>截止时间（本地时间）<input type="datetime-local" required bind:value={deadline} disabled={creating} /></label>
      {#each options as option, index (option.key)}
        <div class="actions">
          <label>选项 {index + 1} <input required bind:value={option.label} disabled={creating} /></label>
          <button type="button" disabled={creating || options.length <= 2}
            onclick={() => { options = options.filter(({ key }) => key !== option.key); }}>移除选项 {index + 1}</button>
        </div>
      {/each}
      <div class="actions">
        <button type="button" disabled={creating} onclick={addOption}>添加选项</button>
        <label><input type="checkbox" bind:checked={allowChange} disabled={creating} /> 允许截止前改票</label>
        <button disabled={creating}>发起表决</button>
      </div>
    </form>
    {#if createError}<p role="alert">{createError}</p>{/if}
  {/if}
  {#if loadingPolls}<p role="status">正在加载表决结果…</p>{/if}
  {#if pollsError}<p role="alert">{pollsError}</p>{/if}
  {#each polls as poll (poll.id)}
    <article>
      <h4>{poll.title} · 版本 {poll.version}</h4>
      <p>{meeting.status === "closed" || isPollClosed(poll.deadline, now) ? "已截止" : "进行中"}
        · 截止 {new Date(poll.deadline).toLocaleString()} · {poll.allowChange ? "截止前可改票" : "提交后不可更改"}</p>
      <table aria-label={`${poll.title}表决结果`}>
        <thead><tr><th scope="col">选项</th><th scope="col">人数</th><th scope="col">权重合计</th></tr></thead>
        <tbody>
          {#each poll.results as result (result.key)}
            <tr><th scope="row">{result.label}</th><td>{result.count}</td><td>{result.weight}</td></tr>
          {/each}
        </tbody>
      </table>
    </article>
  {:else}
    {#if !loadingPolls && !pollsError}<p>暂无表决议题。</p>{/if}
  {/each}

  <h3>会议归档</h3>
  <p>绑定目标数据表后，结束会议时可自动回写；也可手动生成或刷新归档。导出只包含当前会议的记录。</p>
  {#if archiveLoading}
    <p role="status">正在加载归档配置…</p>
  {:else if !archiveReady}
    <button onclick={() => void loadConfig()}>重新加载归档配置</button>
  {:else}
    <form onsubmit={saveConfig}>
      <label>签到数据表
        <select required bind:value={attendanceSheet} disabled={archiveBusy}>
          <option value="" disabled>请选择</option>
          {#if attendanceSheet && !attendanceSheets.some((entry) => String(entry.id) === attendanceSheet)}
            <option value={attendanceSheet} disabled>原签到数据表不可用</option>
          {/if}
          {#each attendanceSheets as entry (String(entry.id))}
            <option value={String(entry.id)}>{entry.workbook_name ? `${entry.workbook_name} / ` : ""}{entry.label}</option>
          {/each}
        </select>
      </label>
      {#if !attendanceSheets.length}<p>没有匹配的签到表。所需字段：{Object.keys(archiveFields.attendance).join("、")}。</p>{/if}
      <label>表决统计数据表
        <select required bind:value={voteSheet} disabled={archiveBusy}>
          <option value="" disabled>请选择</option>
          {#if voteSheet && !voteSheets.some((entry) => String(entry.id) === voteSheet)}
            <option value={voteSheet} disabled>原表决数据表不可用</option>
          {/if}
          {#each voteSheets as entry (String(entry.id))}
            <option value={String(entry.id)}>{entry.workbook_name ? `${entry.workbook_name} / ` : ""}{entry.label}</option>
          {/each}
        </select>
      </label>
      {#if !voteSheets.length}<p>没有匹配的表决统计表。所需字段：{Object.keys(archiveFields.vote).join("、")}。</p>{/if}
      <label>名册权重字段
        <select bind:value={weightField} disabled={archiveBusy}>
          <option value="">不指定权重字段</option>
          {#if weightField && !weightColumns.some(({ key }) => key === weightField)}
            <option value={weightField} disabled>{weightField}（原配置字段）</option>
          {/if}
          {#each weightColumns as column (column.key)}<option value={column.key}>{column.label || column.key}</option>{/each}
        </select>
      </label>
      {#if attendanceSheet && attendanceSheet === voteSheet}<p>请选择两张不同的数据表。</p>{/if}
      <button disabled={archiveBusy || !dirty || !targetsAvailable}>保存归档配置</button>
    </form>
    {#if saved && !dirty}
      <button disabled={archiveBusy || !targetsAvailable} onclick={generateArchive}>生成会议归档</button>
      <div class="actions">
        <button disabled={archiveBusy} onclick={() => exportArchive("attendance", "csv")}>签到 CSV</button>
        <button disabled={archiveBusy} onclick={() => exportArchive("attendance", "pdf")}>签到打印 / PDF</button>
        <button disabled={archiveBusy} onclick={() => exportArchive("vote", "csv")}>表决 CSV</button>
        <button disabled={archiveBusy} onclick={() => exportArchive("vote", "pdf")}>表决打印 / PDF</button>
      </div>
      <p>导出 PDF 时请在打印对话框选择「另存为 PDF」。</p>
    {/if}
  {/if}
  {#if archiveBusy}<p role="status">正在处理归档…</p>{/if}
  {#if archiveError}<p role="alert">{archiveError}</p>{/if}
  {#if archiveNotice}<p role="status">{archiveNotice}</p>{/if}
</section>

<style>
  section, article, form, label { display: grid; gap: 0.5rem; }
  section, article { padding: 0.75rem; border: 1px solid var(--border, #aaa); border-radius: 0.5rem; }
  .actions { display: flex; flex-wrap: wrap; align-items: end; gap: 0.5rem; }
  .actions label:has(input[type="checkbox"]) { display: flex; align-items: center; }
  th, td { padding: 0.25rem 0.5rem; text-align: start; }
  button, input:not([type="checkbox"]), select { padding: 0.45rem 0.6rem; border: 1px solid var(--border, #aaa); border-radius: 0.4rem; }
  button { justify-self: start; }
</style>
