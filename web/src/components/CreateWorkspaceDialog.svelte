<script lang="ts">
  import { createWorkspace } from "../lib/create-workspace.svelte";
  import { switchWorkspace } from "../lib/switch-workspace.svelte";

  /** 关闭对话框（取消或成功后）；由父组件控制可见性。 */
  let { onclose, oncreated }: { onclose?: () => void; oncreated?: () => void } = $props();

  let name = $state("");
  let slug = $state("");
  let submitting = $state(false);
  let error = $state<string | null>(null);
  /** 非空时表示 workspace 已建但 token scope 没切，展示「重试进入」按钮。 */
  let pendingEnter = $state<string | null>(null);
  let retrying = $state(false);

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
  let slugTouched = $state(false);
  $effect(() => {
    if (!slugTouched) slug = slugify(name);
  });

  const canSubmit = $derived(name.trim().length > 0 && slug.length > 0 && !submitting);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;

    error = null;
    pendingEnter = null;
    submitting = true;
    try {
      const result = await createWorkspace({ name: name.trim(), slug });
      if (result.ok) {
        oncreated?.();
        onclose?.();
        return;
      }
      switch (result.reason) {
        case "slug-conflict":
          error = "该标识已被占用，请换一个";
          break;
        case "forbidden":
          error = "你没有创建工作区的权限";
          break;
        case "refresh-failed":
          error = "工作区已创建，但会话已过期，请重新登录后进入";
          break;
        case "scope-update-failed":
          // workspace 已建，只是 token scope 没切；保留 slug 供「重试进入」走 D2-05 switch flow。
          pendingEnter = result.slug;
          error = "工作区已创建，但切换失败，可点「重试进入」";
          break;
        default:
          error = result.message ?? "创建失败，请重试";
      }
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

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose?.()} />

<div
  class="backdrop"
  role="presentation"
  onclick={(e) => {
    // 只在点到背景本身（而非对话框内部）时关闭。
    if (e.target === e.currentTarget) onclose?.();
  }}
>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cw-title" tabindex="-1">
    <h2 id="cw-title">新建工作区</h2>

    <form onsubmit={submit}>
      <label class="field">
        <span>名称</span>
        <input
          type="text"
          bind:value={name}
          placeholder="例如：诉讼部"
          autocomplete="off"
          disabled={submitting}
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
          disabled={submitting}
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
          {submitting ? "创建中…" : "创建"}
        </button>
      </div>
    </form>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(16, 24, 40, 0.45);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .dialog {
    width: min(28rem, calc(100vw - 2rem));
    background: #ffffff;
    border-radius: 12px;
    box-shadow: 0 18px 48px rgba(16, 24, 40, 0.24);
    padding: 1.5rem;
  }

  h2 {
    margin: 0 0 1rem;
    font-size: 1.15rem;
    color: #16181d;
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
