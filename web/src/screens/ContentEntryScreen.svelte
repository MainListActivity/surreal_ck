<script lang="ts">
  import { contentReaderExchangeRequestSchema } from "@surreal-ck/shared";

  let { onopen }: { onopen: (publicId: string) => void } = $props();
  let pointer = $state("");
  let invalid = $state(false);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const result = contentReaderExchangeRequestSchema.safeParse({ contentPublicId: pointer });
    invalid = !result.success;
    if (result.success) onopen(result.data.contentPublicId);
  }
</script>

<section class="entry">
  <span class="eyebrow">工作区内容</span>
  <h1>打开已知法律内容</h1>
  <p>输入已发布内容的公开指针。打开时会重新核验当前成员、工作区权益和来源许可；内容阅读使用独立短期连接。</p>
  <form onsubmit={submit}>
    <label for="content-public-id">内容公开 ID</label>
    <div class="controls">
      <input id="content-public-id" bind:value={pointer} autocomplete="off" spellcheck="false" placeholder="输入公开内容 ID" aria-invalid={invalid} />
      <button type="submit">验证并打开</button>
    </div>
    {#if invalid}<small role="alert">请输入有效的公开内容 ID。</small>{/if}
  </form>
</section>

<style>
  .entry { max-width: 760px; padding: 44px; }
  .eyebrow { color: var(--brand-strong); font-size: 12px; font-weight: 700; letter-spacing: .07em; }
  h1 { font-family: var(--font-serif); font-size: 32px; margin: 12px 0; }
  p { max-width: 640px; line-height: 1.8; color: var(--text-2); }
  form { margin-top: 32px; }
  label { display: block; margin-bottom: 9px; font-weight: 650; }
  .controls { display: flex; gap: 10px; }
  input { min-width: 0; flex: 1; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); padding: 12px; }
  button { border: 0; border-radius: 9px; background: var(--primary); color: white; padding: 0 18px; cursor: pointer; }
  small { display: block; color: var(--error); margin-top: 8px; }
  @media (max-width: 640px) { .entry { padding: 24px; } .controls { flex-direction: column; } button { padding: 12px; } }
</style>
