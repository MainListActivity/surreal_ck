<script lang="ts">
  import { X } from "@lucide/svelte";
  import type { WorkbookTemplate } from "@surreal-ck/shared/dto";
  import { workbookTemplatesStore } from "../lib/workbook-templates.svelte";

  let { template, onclose }: { template: WorkbookTemplate; onclose: () => void } = $props();
  let source = $state(JSON.stringify(template.checkRules ?? { version: "v1", rules: [] }, null, 2));
  let saving = $state(false);
  let error = $state("");

  async function save(): Promise<void> {
    if (saving) return;
    saving = true;
    error = "";
    try {
      await workbookTemplatesStore.saveCheckRules(template.id, JSON.parse(source));
      onclose();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving = false;
    }
  }
</script>

<div class="overlay" role="presentation">
  <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="template-rules-title">
    <header>
      <div><h2 id="template-rules-title">{template.label} · 数据检查规则</h2><p>每次修改版本号；旧运行与旧问题会继续保留。</p></div>
      <button class="icon" aria-label="关闭" onclick={onclose}><X size={18} /></button>
    </header>
    <div class="body">
      <div class="rule-types" aria-label="支持的规则类型">
        <article><strong>重复候选</strong><span>duplicate · 指定 1–8 个字段和 2–100 的候选组阈值，不自动合并或删除。</span></article>
        <article><strong>引用存在性</strong><span>reference_exists · 目标表不可读时标记“无法核验”，不会误报缺失。</span></article>
        <article><strong>字段一致性</strong><span>consistency · 比较同一记录的两个模板字段。</span></article>
      </div>
      <label for="template-rules-json">规则声明（JSON）</label>
      <textarea id="template-rules-json" bind:value={source} spellcheck="false"></textarea>
      <p class="hint">只接受上列三种结构化类型；数据表、字段、阈值与说明均须来自当前模板声明，不执行脚本或查询。</p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <footer><button onclick={onclose}>取消</button><button class="primary" disabled={saving} onclick={() => void save()}>{saving ? "保存中…" : "保存规则"}</button></footer>
  </section>
</div>

<style>
  .overlay { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(20 28 24 / 48%); }
  .dialog { display: flex; width: min(820px, 100%); max-height: calc(100vh - 48px); flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); }
  header, footer { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px; border-bottom: 1px solid var(--border); }
  footer { justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border); border-bottom: 0; }
  h2, p { margin: 0; } header p { margin-top: 4px; color: var(--text-3); font-size: 12px; }
  .body { display: grid; gap: 12px; overflow: auto; padding: 20px 22px; }
  .rule-types { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  article { display: grid; gap: 4px; padding: 10px; border-radius: 8px; background: var(--surface-2); }
  article strong, label { color: var(--text-1); font-size: 12px; } article span, .hint { color: var(--text-3); font-size: 11px; line-height: 1.5; }
  textarea { min-height: 300px; resize: vertical; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text-1); font: 12px/1.55 ui-monospace, monospace; }
  button { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; } .icon { border: 0; } .primary { color: white; border-color: var(--primary); background: var(--primary); }
  .error { color: var(--error); font-size: 12px; }
  @media (max-width: 700px) { .rule-types { grid-template-columns: 1fr; } }
</style>
