<script lang="ts">
  import { parseRateSegmentsJson } from "../lib/claims-interest";

  /**
   * 债权人令牌填报公开页：打开会话 → 申报草稿 → 附件（本轮 fail-closed）→ 提交。
   */
  let { slug, token }: { slug: string; token: string } = $props();

  type AttachmentRow = {
    id?: string | null;
    attachmentType?: string | null;
    fileName?: string | null;
  };

  type SubmissionRow = {
    id?: string | null;
    principal?: number | null;
    rateSegments?: Array<Record<string, unknown>> | null;
    interestStart?: string | null;
    interestEnd?: string | null;
    interestMethod?: string | null;
    penalty?: number | null;
    statement?: string | null;
    status?: string | null;
  };

  let phase = $state<"open" | "form">("open");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let name = $state("");
  let identityCode = $state("");
  let principal = $state("");
  let interestStart = $state("");
  let interestEnd = $state("");
  let interestMethod = $state("simple");
  let penalty = $state("");
  let statement = $state("");
  let rateAnnual = $state("0.06");
  let rateSegmentsJson = $state("");
  const SEGMENTS_PLACEHOLDER = '[{"start":"2024-01-01","end":"2024-07-01","annual_rate":0.06},{"start":"2024-07-01","end":"2025-01-01","annual_rate":0.08}]';
  let submission = $state<SubmissionRow | null>(null);
  let attachments = $state<AttachmentRow[]>([]);
  let submitted = $state(false);

  function apiBase(): string {
    return import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "") ?? "";
  }

  function portalUrl(suffix: string): string {
    return `${apiBase()}/api/claims-portal/${encodeURIComponent(slug)}/${encodeURIComponent(token)}${suffix}`;
  }

  async function readError(res: Response): Promise<string> {
    try {
      const body = await res.json() as { error?: { message?: string; code?: string } };
      if (body.error?.code === "attachment-storage-not-configured") {
        return "附件存储尚未配置（attachment-storage-not-configured）";
      }
      return body.error?.message ?? `请求失败（${res.status}）`;
    } catch {
      return `请求失败（${res.status}）`;
    }
  }

  async function openSession() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const res = await fetch(portalUrl("/session"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), identityCode: identityCode.trim() }),
      });
      if (!res.ok) {
        error = await readError(res);
        return;
      }
      phase = "form";
      await loadSubmission();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function loadSubmission() {
    const res = await fetch(portalUrl("/submission"), { credentials: "include" });
    if (!res.ok) {
      error = await readError(res);
      return;
    }
    const body = await res.json() as {
      submission?: SubmissionRow | null;
      attachments?: AttachmentRow[];
    };
    submission = body.submission ?? null;
    attachments = body.attachments ?? [];
    if (submission) {
      principal = submission.principal != null ? String(submission.principal) : "";
      interestStart = submission.interestStart?.slice(0, 10) ?? "";
      interestEnd = submission.interestEnd?.slice(0, 10) ?? "";
      interestMethod = submission.interestMethod ?? "simple";
      penalty = submission.penalty != null ? String(submission.penalty) : "";
      statement = submission.statement ?? "";
      const seg = submission.rateSegments?.[0];
      if (seg && typeof seg.annual_rate === "number") rateAnnual = String(seg.annual_rate);
      if (Array.isArray(submission.rateSegments) && submission.rateSegments.length > 1 && rateSegmentsJson === "") {
        rateSegmentsJson = JSON.stringify(submission.rateSegments, null, 2);
      }
      if (submission.status === "submitted") submitted = true;
    }
  }

  async function saveDraft() {
    if (busy || submitted) return;
    const parsed = parseRateSegmentsJson(rateSegmentsJson);
    if (!parsed.ok) {
      error = parsed.error;
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await fetch(portalUrl("/submission"), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principal: principal === "" ? null : Number(principal),
          rate_segments: parsed.segments ?? [
            {
              annual_rate: Number(rateAnnual),
              start: interestStart || null,
              end: interestEnd || null,
            },
          ],
          interest_start: interestStart ? `${interestStart}T00:00:00.000Z` : null,
          interest_end: interestEnd ? `${interestEnd}T00:00:00.000Z` : null,
          interest_method: interestMethod,
          penalty: penalty === "" ? null : Number(penalty),
          statement: statement || null,
        }),
      });
      if (!res.ok) {
        error = await readError(res);
        return;
      }
      const body = await res.json() as { submission?: SubmissionRow };
      submission = body.submission ?? submission;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function uploadAttachment(file: File | undefined) {
    if (!file || busy || submitted) return;
    busy = true;
    error = null;
    try {
      const form = new FormData();
      form.set("attachmentType", "contract");
      form.set("file", file);
      const res = await fetch(portalUrl("/attachments"), {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        error = await readError(res);
        return;
      }
      await loadSubmission();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function submitClaim() {
    if (busy || submitted) return;
    await saveDraft();
    if (error) return;
    busy = true;
    error = null;
    try {
      const res = await fetch(portalUrl("/submission/submit"), {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        error = await readError(res);
        return;
      }
      submitted = true;
      await loadSubmission();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<main class="portal">
  <header class="hero">
    <h1>债权申报</h1>
    <p>请按管理人提供的链接填写。系统不会向你展示名册中的其他信息。</p>
  </header>

  {#if phase === "open"}
    <section class="card" aria-label="打开会话">
      <label>
        姓名 / 名称
        <input bind:value={name} autocomplete="name" disabled={busy} />
      </label>
      <label>
        唯一识别码
        <input bind:value={identityCode} autocomplete="off" disabled={busy} />
      </label>
      <button type="button" class="primary" disabled={busy || !name.trim() || !identityCode.trim()} onclick={() => void openSession()}>
        {busy ? "校验中…" : "进入申报"}
      </button>
    </section>
  {:else}
    <section class="card" aria-label="申报表单">
      {#if submitted}
        <p class="ok">已提交。如需补充材料，请等待管理人联系。</p>
      {/if}
      <label>
        本金
        <input type="number" min="0" step="0.01" bind:value={principal} disabled={busy || submitted} />
      </label>
      <div class="row">
        <label>
          年利率（分段简表）
          <input type="number" min="0" step="0.0001" bind:value={rateAnnual} disabled={busy || submitted} />
        </label>
        <label>
          计息方式
          <select bind:value={interestMethod} disabled={busy || submitted}>
            <option value="simple">单利 simple</option>
          </select>
        </label>
      </div>
      <label>
        分段利率（可选；合同约定多段利率时用 JSON 覆盖上方单段）
        <textarea
          rows={3}
          bind:value={rateSegmentsJson}
          disabled={busy || submitted}
          placeholder={SEGMENTS_PLACEHOLDER}
        ></textarea>
      </label>
      <div class="row">
        <label>
          计息起始日
          <input type="date" bind:value={interestStart} disabled={busy || submitted} />
        </label>
        <label>
          计息终止日（不含）
          <input type="date" bind:value={interestEnd} disabled={busy || submitted} />
        </label>
      </div>
      <label>
        违约金（无约定可留空）
        <input type="number" min="0" step="0.01" bind:value={penalty} disabled={busy || submitted} />
      </label>
      <label>
        说明
        <textarea rows="4" bind:value={statement} disabled={busy || submitted}></textarea>
      </label>

      <div class="attachments">
        <h2>附件</h2>
        <p class="hint">至少一份（合同 / 对账单 / 判决书）。本轮若未配置对象存储，上传会返回明确错误。</p>
        <ul>
          {#each attachments as item}
            <li>{item.attachmentType ?? "—"} · {item.fileName ?? item.id}</li>
          {:else}
            <li class="muted">尚未登记附件</li>
          {/each}
        </ul>
        <input
          type="file"
          accept=".pdf,image/png,image/jpeg,application/pdf"
          disabled={busy || submitted}
          onchange={(event) => {
            const input = event.currentTarget as HTMLInputElement;
            void uploadAttachment(input.files?.[0]);
            input.value = "";
          }}
        />
      </div>

      <div class="actions">
        <button type="button" class="secondary" disabled={busy || submitted} onclick={() => void saveDraft()}>保存草稿</button>
        <button type="button" class="primary" disabled={busy || submitted} onclick={() => void submitClaim()}>提交申报</button>
      </div>
    </section>
  {/if}

  {#if error}
    <div class="error" role="alert">{error}</div>
  {/if}
</main>

<style>
  .portal {
    max-width: 720px;
    margin: 0 auto;
    padding: 32px 20px 64px;
    color: var(--text-1, #0f172a);
  }
  .hero h1 {
    margin: 0 0 8px;
    font-size: 1.6rem;
  }
  .hero p {
    margin: 0 0 20px;
    color: var(--text-2, #475569);
  }
  .card {
    display: grid;
    gap: 14px;
    padding: 20px;
    border-radius: 16px;
    background: var(--surface, #fff);
    border: 1px solid var(--border, #e2e8f0);
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
  }
  label {
    display: grid;
    gap: 6px;
    font-size: 0.9rem;
    font-weight: 600;
  }
  input, textarea, select {
    font: inherit;
    font-weight: 400;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--border, #cbd5e1);
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .attachments h2 {
    margin: 0;
    font-size: 1rem;
  }
  .hint, .muted {
    color: var(--text-2, #64748b);
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
  button {
    border: 0;
    border-radius: 10px;
    padding: 10px 14px;
    font: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .primary {
    background: #0f766e;
    color: #fff;
  }
  .secondary {
    background: #e2e8f0;
    color: #0f172a;
  }
  .error {
    margin-top: 16px;
    padding: 12px 14px;
    border-radius: 10px;
    background: #fef2f2;
    color: #b91c1c;
  }
  .ok {
    margin: 0;
    padding: 10px 12px;
    border-radius: 10px;
    background: #ecfdf5;
    color: #047857;
  }
  @media (max-width: 640px) {
    .row { grid-template-columns: 1fr; }
  }
</style>
