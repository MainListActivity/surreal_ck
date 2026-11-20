<script lang="ts">
  import { Copy, Download, Link2, X } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { getToken } from "../lib/auth";
  import { getSurreal } from "../lib/surreal";
  import { getCurrentWorkspace } from "../lib/workspace-store.svelte";
  import { claimsPortalPath } from "../lib/route";

  let { onclose }: { onclose?: () => void } = $props();

  type RosterRow = {
    id: string;
    name: string;
    identity_code: string;
  };

  type TokenRow = {
    id: string;
    rosterId: string;
    status: string;
    openedAt: string | null;
    createdAt: string | null;
  };

  let busy = $state(false);
  let error = $state<string | null>(null);
  let roster = $state<RosterRow[]>([]);
  let tokens = $state<TokenRow[]>([]);
  let lastPlaintext = $state<string | null>(null);
  let lastPath = $state<string | null>(null);
  let lastRosterId = $state<string | null>(null);
  let selectedIds = $state<string[]>([]);
  let status = $state("");

  const workspace = $derived(getCurrentWorkspace());
  const tokenEndpoint = $derived(workspace?.slug
    ? `${apiBase()}/api/workspaces/${encodeURIComponent(workspace.slug)}/claims-portal/tokens`
    : "");

  function apiBase(): string {
    return import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, "") ?? "";
  }

  function recordId(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "toString" in value) return String(value);
    return "";
  }

  async function loadRoster() {
    const db = getSurreal();
    const rows = await db.query<{ id: unknown; name?: unknown; identity_code?: unknown }>(
      "SELECT id, name, identity_code FROM creditor_roster ORDER BY name ASC;",
    );
    roster = (rows ?? []).flatMap((row) => {
      const id = recordId(row.id);
      if (!id || typeof row.name !== "string" || typeof row.identity_code !== "string") return [];
      return [{ id, name: row.name, identity_code: row.identity_code }];
    });
  }

  async function loadTokens() {
    const bearer = getToken();
    if (!tokenEndpoint || !bearer) return;
    const res = await fetch(tokenEndpoint, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `加载令牌失败（${res.status}）`);
    }
    const body = await res.json() as { tokens?: TokenRow[] };
    tokens = body.tokens ?? [];
  }

  async function refresh() {
    busy = true;
    error = null;
    try {
      await Promise.all([loadRoster(), loadTokens()]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function mint(rosterId: string) {
    const slug = workspace?.slug;
    const bearer = getToken();
    if (!slug || !tokenEndpoint || !bearer || busy) return;
    busy = true;
    error = null;
    lastPlaintext = null;
    lastPath = null;
    lastRosterId = rosterId;
    try {
      const res = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ rosterId }),
      });
      const body = await res.json() as {
        tokenPlaintext?: string;
        portalPath?: string;
        error?: { message?: string; code?: string };
      };
      if (!res.ok) {
        error = body.error?.message ?? `生成失败（${res.status}）`;
        return;
      }
      lastPlaintext = body.tokenPlaintext ?? null;
      lastPath = body.portalPath ?? (body.tokenPlaintext ? claimsPortalPath(slug, body.tokenPlaintext) : null);
      await loadTokens();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function downloadBatch() {
    const bearer = getToken();
    if (busy || !tokenEndpoint || !bearer || selectedIds.length === 0 || selectedIds.length > 500) return;
    busy = true;
    error = null;
    status = "";
    lastPlaintext = null;
    lastPath = null;
    try {
      const res = await fetch(`${tokenEndpoint}:batch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ rosterIds: selectedIds }),
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `批量生成失败（${res.status}）`);
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "claims-portal-links.csv";
      link.click();
      URL.revokeObjectURL(url);
      selectedIds = [];
      status = "已发起下载。请妥善保管 CSV，系统不会保留明文链接。";
      await loadTokens();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function revoke(existing: TokenRow) {
    const bearer = getToken();
    if (busy || !tokenEndpoint || !bearer || !window.confirm("作废后，旧链接和已经打开的会话都将失效。确定作废？")) return;
    busy = true;
    error = null;
    status = "";
    if (lastRosterId === existing.rosterId) {
      lastPlaintext = null;
      lastPath = null;
    }
    try {
      const res = await fetch(`${tokenEndpoint}/${encodeURIComponent(existing.id)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `作废失败（${res.status}）`);
      }
      status = "链接已作废。";
      await loadTokens();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      error = "复制失败，请手动选择文本";
    }
  }

  function tokenForRoster(rosterId: string): TokenRow | undefined {
    return tokens.find((item) => item.rosterId === rosterId);
  }

  onMount(() => {
    void refresh();
  });
</script>

<div class="overlay" role="presentation" onclick={() => !busy && onclose?.()}>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="claims-token-title"
    onclick={(event) => event.stopPropagation()}
  >
    <header class="header">
      <div class="title-wrap">
        <Link2 size={18} />
        <h2 id="claims-token-title">债权人填报链接</h2>
      </div>
      <button type="button" class="icon-btn" aria-label="关闭" disabled={busy} onclick={() => onclose?.()}>
        <X size={16} />
      </button>
    </header>

    <p class="hint">
      为名册中的债权人生成专属链接。换发后旧链接即失效；批量生成的明文只在本次 CSV 下载中提供。
    </p>

    {#if lastPlaintext && lastPath}
      <div class="once" role="status">
        <strong>请立即复制（只显示一次）</strong>
        <code>{typeof window !== "undefined" ? `${window.location.origin}${lastPath}` : lastPath}</code>
        <button
          type="button"
          class="secondary"
          onclick={() => void copyText(`${window.location.origin}${lastPath}`)}
        >
          <Copy size={14} />复制完整链接
        </button>
      </div>
    {/if}

    {#if error}
      <div class="status error" role="alert">{error}</div>
    {/if}
    {#if status}<p role="status">{status}</p>{/if}
    <button type="button" class="secondary" disabled={busy || selectedIds.length === 0 || selectedIds.length > 500} onclick={() => void downloadBatch()}>
      <Download size={14} />批量生成并下载 CSV（已选 {selectedIds.length} / 500）
    </button>

    <div class="list">
      {#each roster as row}
        {@const existing = tokenForRoster(row.id)}
        <div class="row">
          <div>
            <label>
              <input type="checkbox" bind:group={selectedIds} value={row.id} disabled={busy} />
              <strong>{row.name}</strong>
            </label>
            <small>{row.identity_code}</small>
            {#if existing}
              <span class="badge">{existing.status}{existing.openedAt ? " · 已打开" : ""}</span>
            {/if}
          </div>
          <div class="actions">
            {#if existing?.status === "active"}
              <button type="button" class="secondary" disabled={busy} onclick={() => void revoke(existing)}>作废</button>
            {/if}
            <button type="button" class="primary" disabled={busy} onclick={() => void mint(row.id)}>
              {existing?.status === "active" ? "重新生成" : "生成链接"}
            </button>
          </div>
        </div>
      {:else}
        <p class="empty">名册为空。请先通过「债权对账导入」导入债权人名册。</p>
      {/each}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    display: grid;
    place-items: center;
    z-index: 80;
    padding: 24px;
  }
  .dialog {
    width: min(640px, 100%);
    max-height: min(80vh, 720px);
    overflow: auto;
    background: var(--surface, #fff);
    color: var(--text-1, #0f172a);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
    padding: 20px 22px 22px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .hint {
    color: var(--text-2, #475569);
    font-size: 0.9rem;
  }
  .once {
    display: grid;
    gap: 8px;
    padding: 12px;
    border-radius: 12px;
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
  }
  code {
    word-break: break-all;
    font-size: 0.85rem;
  }
  .list {
    display: grid;
    gap: 10px;
    margin-top: 12px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 12px;
  }
  .row small {
    display: block;
    color: var(--text-2, #64748b);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .badge {
    display: inline-block;
    margin-top: 4px;
    font-size: 0.75rem;
    color: #0f766e;
  }
  .empty {
    color: var(--text-2, #64748b);
  }
  .status.error {
    background: #fef2f2;
    color: #b91c1c;
    padding: 10px 12px;
    border-radius: 10px;
  }
  button {
    border: 0;
    border-radius: 10px;
    padding: 8px 12px;
    font: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .primary {
    background: #0f766e;
    color: #fff;
  }
  .secondary {
    background: #e2e8f0;
  }
  .icon-btn {
    background: transparent;
    padding: 6px;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
