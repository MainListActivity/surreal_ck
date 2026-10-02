<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { api } from "../lib/api";
  import { refresh } from "../lib/auth";
  import { onMount } from "svelte";
  import { switchWorkspace } from "../lib/switch-workspace.svelte";

  /** 关闭对话框（取消或成功后）；由父组件控制可见性（父用 {#if} 挂载）。 */
  let { onclose, oncreated }: { onclose?: () => void; oncreated?: () => void } = $props();

  let accounts = $state<{ key: string; name: string }[]>([]);
  let accountKey = $state("");
  let preview = $state<{ revision: string; researchRate: number; startedAt: string; endsAt: string; allowance: number; collections: { key: string; label: string }[]; capacity: { label: string; limit: number }[]; reminderHours: number[]; excludes: string[]; expiry: string; fixture: boolean } | null>(null);
  let confirmed = $state(false);
  let loading = $state(true);
  // 保存原请求的公开字段，恢复时锁定名称/账户，避免同一幂等键改成另一请求。
  const savedRequest = (() => {
    try {
      const v: unknown = JSON.parse(sessionStorage.getItem("pro-trial-pending-request") ?? "null");
      if (typeof v !== "object" || v === null || !("name" in v) || !("slug" in v) || !("accountKey" in v) || !("key" in v)) return null;
      if (typeof v.name !== "string" || typeof v.slug !== "string" || typeof v.accountKey !== "string" || typeof v.key !== "string") return null;
      return { name: v.name, slug: v.slug, accountKey: v.accountKey, key: v.key };
    } catch { return null; }
  })();
  let requestLocked = $state(savedRequest !== null);
  let requestKey = savedRequest?.key ?? sessionStorage.getItem("pro-trial-request-key") ?? crypto.randomUUID();
  sessionStorage.setItem("pro-trial-request-key", requestKey);
  onMount(() => { void loadAccounts(); });
  async function loadAccounts() {
    try {
      if (!await refresh()) throw new Error("请先登录");
      const res = await api.api["pro-trial"].accounts.$get();
      if (!res.ok) throw new Error("无法读取试用资格");
      accounts = await res.json();
      accountKey = savedRequest?.accountKey ?? accounts[0]?.key ?? "";
      if (accountKey) await loadPreview();
    } catch (e) { error = e instanceof Error ? e.message : "试用暂不可用"; }
    finally { loading = false; }
  }
  async function loadPreview() {
    const requestedAccount = accountKey;
    preview = null; confirmed = false;
    try {
      const res = await api.api["pro-trial"].preview.$get({ query: { accountKey, key: requestKey } });
      if (!res.ok) throw new Error("试用配置尚未获批或账户没有资格");
      const offered = await res.json();
      if (accountKey === requestedAccount) preview = offered;
    } catch (e) { error = e instanceof Error ? e.message : "试用暂不可用"; }
  }
  let name = $state(savedRequest?.name ?? "");
  let slug = $state(savedRequest?.slug ?? "");
  let submitting = $state(false);
  let error = $state<string | null>(null);
  /** 非空时表示 workspace 已建但 token scope 没切，展示「重试进入」按钮。 */
  let pendingEnter = $state<string | null>(null);
  let retrying = $state(false);

  // 父组件用 {#if} 控制挂载，所以挂载即打开；用户通过 Escape / 外点 / 关闭按钮关闭时
  // onOpenChange(false) 回流到父组件的 onclose（提交中阻止关闭，避免丢失进行中的创建）。
  let open = $state(true);

  function handleOpenChange(next: boolean) {
    if (next) return;
    if (submitting || retrying) {
      open = true;
      return;
    }
    onclose?.();
  }

  /** name → 默认 slug：小写、空白转连字符、去掉非法字符。后端用同样的 SLUG_PATTERN 把关。 */
  function slugify(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  // slug 未被用户手动编辑时，跟随 name 自动派生。
  let slugTouched = $state(savedRequest !== null);
  $effect(() => {
    if (!slugTouched) slug = slugify(name);
  });

  const canSubmit = $derived(name.trim().length > 0 && slug.length > 0 && !submitting && preview !== null && confirmed && !loading);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;

    error = null;
    pendingEnter = null;
    submitting = true;
    try {
      if (!await refresh()) throw new Error("会话已过期，请重新登录");
      const original = { name: name.trim(), slug, accountKey, key: requestKey };
      sessionStorage.setItem("pro-trial-pending-request", JSON.stringify(original));
      requestLocked = true;
      const res = await api.api["pro-trial"].start.$post({ json: { ...original, offerRevision: preview!.revision } });
      if (!res.ok) {
        const body = await res.json();
        const code = "error" in body && typeof body.error === "object" && body.error && "code" in body.error ? String(body.error.code) : "";
        if (code === "trial-expired") {
          sessionStorage.removeItem("pro-trial-pending-request");
          requestKey = crypto.randomUUID();
          sessionStorage.setItem("pro-trial-request-key", requestKey);
          requestLocked = false;
          await loadPreview();
        } else if (code === "trial-offer-changed") {
          await loadPreview();
        }
        if (res.status === 400 || ("error" in body && typeof body.error === "object" && body.error && "code" in body.error && body.error.code === "trial-slug-conflict")) {
          sessionStorage.removeItem("pro-trial-pending-request");
          requestLocked = false;
        }
        throw new Error("error" in body && typeof body.error === "object" && body.error && "message" in body.error ? String(body.error.message) : "试用交付未完成，请使用相同名称与标识重试");
      }
      const result = await res.json();
      pendingEnter = result.slug;
      sessionStorage.removeItem("pro-trial-request-key");
      sessionStorage.removeItem("pro-trial-pending-request");
      await retryEnter();
    } catch (e) {
      error = e instanceof Error ? e.message : "试用交付未完成，请重试";
    } finally {
      submitting = false;
    }
  }

  async function retryEnter(): Promise<void> {
    if (!pendingEnter) return;
    retrying = true;
    try {
      const result = await switchWorkspace(pendingEnter);
      if (result.ok) {
        oncreated?.();
        onclose?.();
      } else if (result.reason === "refresh-failed") {
        error = "会话已过期，请重新登录";
      } else {
        error = result.message ?? "进入失败，请重试";
      }
    } finally {
      retrying = false;
    }
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="create-workspace">
    <Dialog.Header>
      <Dialog.Title>显式开始七日 Pro 试用</Dialog.Title>
    </Dialog.Header>

    <form onsubmit={submit}>
      {#if loading}<p>正在核对试用资格…</p>
      {:else if accounts.length === 0}<p>仅有资格的计费账户管理员可以启动试用。请联系计费管理员；普通创建不会启动倒计时。</p>
      {:else}
        <label class="field"><span>计费账户</span><select bind:value={accountKey} onchange={() => void loadPreview()} disabled={submitting || requestLocked}>
          {#each accounts as account}<option value={account.key}>{account.name}</option>{/each}
        </select></label>
      {/if}
      {#if requestLocked}<p>正在恢复原启动请求；账户、名称与标识保持原值，重试不会重新计时。</p>{/if}
      {#if preview}
        <div aria-label="试用范围确认">
          {#if preview.fixture}<p>内部验收配置，不代表正式商业承诺。</p>{/if}
          <p>七个自然日（UTC），预计开始 {preview.startedAt}，结束 {preview.endsAt}。实际边界以服务端启动回执为准。</p>
          <p>Pro 核心内容：{preview.collections.map(c => c.label).join("、")}</p>
          <p>所有成员共享 {preview.allowance} AI 单位，每次研究最多预留 {preview.researchRate} 单位；打开正文和引用不扣 AI 额度。</p>
          <p>容量：{preview.capacity.map(c => `${c.label} ${c.limit}`).join("、")}</p>
          <p>不包含：{preview.excludes.join("、")}</p>
          <p>{preview.expiry}无需信用卡，不自动转付费。可以按新商业来源转 Plus / Pro / Max。</p>
          <p>到期前提醒：{preview.reminderHours.join("、")} 小时。语义检索销售范围需另行获批。</p>
          <label><input type="checkbox" bind:checked={confirmed} disabled={submitting} />我确认范围并主动启动七日试用</label>
        </div>
      {/if}
      <label class="field">
        <span>名称</span>
        <input
          type="text"
          bind:value={name}
          placeholder="例如：诉讼部"
          autocomplete="off"
          disabled={submitting || requestLocked}
        />
      </label>

      <label class="field">
        <span>标识（slug）</span>
        <input
          type="text"
          value={slug}
          oninput={(e) => {
            slugTouched = true;
            slug = e.currentTarget.value.toLowerCase();
          }}
          placeholder="litigation"
          autocomplete="off"
          disabled={submitting || requestLocked}
        />
        <small>1–40 位小写字母、数字或连字符；用于 URL，创建后不可改</small>
      </label>

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <div class="actions">
        {#if pendingEnter}
          <button type="button" class="retry" disabled={retrying} onclick={retryEnter}>
            {retrying ? "进入中…" : "重试进入"}
          </button>
        {/if}
        <button type="button" class="cancel" disabled={submitting} onclick={() => onclose?.()}>
          取消
        </button>
        <button type="submit" class="confirm" disabled={!canSubmit}>
          {submitting ? "交付试用中…" : "开始七日 Pro 试用"}
        </button>
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>

<style>
  :global(.create-workspace) {
    width: min(28rem, calc(100vw - 2rem));
    max-width: min(28rem, calc(100vw - 2rem));
    max-height: 90vh;
    overflow-y: auto;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .field > span {
    font-size: 0.85rem;
    font-weight: 650;
    color: #344054;
  }
  .field input {
    border: 1px solid #c8d0dc;
    border-radius: 6px;
    padding: 0.55rem 0.65rem;
    font: inherit;
    color: #16181d;
  }
  .field input:focus {
    outline: 2px solid #1f6feb;
    outline-offset: 0;
    border-color: #1f6feb;
  }
  .field small {
    color: #667085;
    font-size: 0.75rem;
  }

  .error {
    margin: 0;
    color: #b42318;
    font-size: 0.85rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .actions button {
    border-radius: 6px;
    padding: 0.5rem 0.9rem;
    font: inherit;
    font-weight: 650;
    cursor: pointer;
  }
  .actions button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .cancel {
    border: 1px solid #c8d0dc;
    background: #ffffff;
    color: #344054;
  }
  .confirm {
    border: 1px solid #1f6feb;
    background: #1f6feb;
    color: #ffffff;
  }
  .retry {
    border: 1px solid #d97706;
    background: #fff7ed;
    color: #b45309;
    margin-right: auto;
  }
</style>
