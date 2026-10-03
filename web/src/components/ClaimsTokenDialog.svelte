<script lang="ts">
  import { Copy, Link2, X } from "@lucide/svelte";
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

  const workspace = $derived(getCurrentWorkspace());

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
    const [rows] = await db.query<Array<Array<{ id: unknown; name?: unknown; identity_code?: unknown }>>>(
      "SELECT id, name, identity_code FROM creditor_roster ORDER BY name ASC;",
    );
    roster = (rows ?? []).flatMap((row) => {
      const id = recordId(row.id);
      if (!id || typeof row.name !== "string" || typeof row.identity_code !== "string") return [];
      return [{ id, name: row.name, identity_code: row.identity_code }];
    });
  }

  async function loadTokens() {
    const slug = workspace?.slug;
    const bearer = getToken();
    if (!slug || !bearer) return;
    const res = await fetch(`${apiBase()}/api/workspaces/${encodeURIComponent(slug)}/claims-portal/tokens`, {
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
    if (!slug || !bearer || busy) return;
    busy = true;
    error = null;
    lastPlaintext = null;
    lastPath = null;
    lastRosterId = rosterId;
    try {
      const res = await fetch(`${apiBase()}/api/workspaces/${encodeURIComponent(slug)}/claims-portal/tokens`, {
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
      为名册中的债权人生成专属链接。明文令牌只在生成当下显示一次；请立即复制后自行转发。系统不发邮件或短信。
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

    <div class="list">
      {#each roster as row}
        {@const existing = tokenForRoster(row.id)}
        <div class="row">
          <div>
            <strong>{row.name}</strong>
            <small>{row.identity_code}</small>
            {#if existing}
              <span class="badge">{existing.status}{existing.openedAt ? " · 已打开" : ""}</span>
            {/if}
          </div>
          <button
            type="button"
            class="primary"
            disabled={busy}
            onclick={() => void mint(row.id)}
          >
            {existing ? "重新生成" : "生成链接"}
          </button>
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
