<script lang="ts">
  import { onMount } from "svelte";
  import Avatar from "../components/Avatar.svelte";
  import Icon from "../components/Icon.svelte";
  import { appApi } from "../lib/app-api";
  import { appState } from "../lib/app-state.svelte";
  import type { Navigate } from "../lib/types";
  import type { AiApiFormat, AiProvider } from "../../shared/rpc.types";

  let { navigate: _navigate }: { navigate: Navigate } = $props();

  let retentionDays = $state(30);
  let draftRetentionDays = $state("30");
  let aiProvider = $state<AiProvider>("openai");
  let aiModel = $state("gpt-5.4");
  let aiBaseUrl = $state("");
  let aiApiFormat = $state<AiApiFormat>("openai-compatible");
  let aiApiKey = $state("");
  let aiSecretConfigured = $state(false);
  let clearAiApiKey = $state(false);
  let embeddingProvider = $state<AiProvider>("openai");
  let embeddingModel = $state("text-embedding-3-small");
  let embeddingBaseUrl = $state("");
  let embeddingApiFormat = $state<AiApiFormat>("openai-compatible");
  let embeddingDimensions = $state("1536");
  let embeddingVersion = $state("v1");
  let embeddingApiKey = $state("");
  let embeddingSecretConfigured = $state(false);
  let clearEmbeddingApiKey = $state(false);
  let savedSnapshot = $state("");
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let savedAt = $state<string | null>(null);

  const userName = $derived(appState.user?.displayName || appState.user?.name || "未命名用户");
  const userEmail = $derived(appState.user?.email || "未绑定邮箱");
  const workspaceName = $derived(appState.workspace?.name || "默认工作区");
  const currentSnapshot = $derived(JSON.stringify({
    retentionDays: draftRetentionDays.trim(),
    aiProvider,
    aiModel: aiModel.trim(),
    aiBaseUrl: aiBaseUrl.trim(),
    aiApiFormat,
    aiApiKey,
    aiSecretConfigured,
    clearAiApiKey,
    embeddingProvider,
    embeddingModel: embeddingModel.trim(),
    embeddingBaseUrl: embeddingBaseUrl.trim(),
    embeddingApiFormat,
    embeddingDimensions: embeddingDimensions.trim(),
    embeddingVersion: embeddingVersion.trim(),
    embeddingApiKey,
    embeddingSecretConfigured,
    clearEmbeddingApiKey,
  }));
  const dirty = $derived(savedSnapshot !== currentSnapshot);
  const parsedRetention = $derived(Number.parseInt(draftRetentionDays, 10));
  const invalidRetention = $derived(
    !Number.isFinite(parsedRetention) || parsedRetention < 1 || parsedRetention > 3650
  );
  const invalidAi = $derived(!aiModel.trim());
  const parsedEmbeddingDimensions = $derived(Number.parseInt(embeddingDimensions, 10));
  const invalidEmbeddingDimensions = $derived(
    !Number.isFinite(parsedEmbeddingDimensions) || parsedEmbeddingDimensions < 1 || parsedEmbeddingDimensions > 8192
  );
  const invalidEmbedding = $derived(
    !embeddingModel.trim() || !embeddingVersion.trim() || invalidEmbeddingDimensions || embeddingApiFormat === "anthropic"
  );

  const providerOptions: Array<{ value: AiProvider; label: string }> = [
    { value: "openai", label: "OpenAI" },
    { value: "anthropic", label: "Anthropic" },
    { value: "google", label: "Google" },
    { value: "custom", label: "自定义" },
  ];
  const apiFormatOptions: Array<{ value: AiApiFormat; label: string; hint: string }> = [
    {
      value: "openai-compatible",
      label: "OpenAI Chat Completions",
      hint: "Base URL 填到版本级别，例如 https://api.openai.com/v1；请求会走 /chat/completions。",
    },
    {
      value: "openai-responses",
      label: "OpenAI Responses",
      hint: "Base URL 填到版本级别，例如 https://api.openai.com/v1；请求会走 /responses。",
    },
    {
      value: "anthropic",
      label: "Anthropic Messages",
      hint: "Base URL 填到 Anthropic API 根级别，例如 https://api.anthropic.com/v1 或供应商给出的 /anthropic/v1。",
    },
  ];
  const selectedApiFormat = $derived(
    apiFormatOptions.find((option) => option.value === aiApiFormat) ?? apiFormatOptions[0]
  );
  const embeddingApiFormatOptions: Array<{ value: AiApiFormat; label: string; hint: string }> = [
    {
      value: "openai-compatible",
      label: "OpenAI Embeddings",
      hint: "Base URL 填到版本级别，例如 https://api.openai.com/v1；请求会走 /embeddings。",
    },
    {
      value: "openai-responses",
      label: "OpenAI Embeddings (Responses 兼容)",
      hint: "用于同时走 Responses 接口的兼容供应商；请求仍走 /embeddings。",
    },
  ];
  const selectedEmbeddingApiFormat = $derived(
    embeddingApiFormatOptions.find((option) => option.value === embeddingApiFormat) ?? embeddingApiFormatOptions[0]
  );

  onMount(() => {
    void loadSettings();
  });

  async function loadSettings() {
    loading = true;
    error = null;
    try {
      const result = await appApi.getSettings();
      if (!result.ok) {
        error = result.message;
        return;
      }
      retentionDays = result.data.observability.retentionDays;
      draftRetentionDays = String(retentionDays);
      aiProvider = result.data.ai.provider;
      aiModel = result.data.ai.model;
      aiBaseUrl = result.data.ai.baseUrl ?? "";
      aiApiFormat = result.data.ai.apiFormat;
      aiApiKey = "";
      aiSecretConfigured = result.data.ai.secretConfigured;
      clearAiApiKey = false;
      embeddingProvider = result.data.embedding.provider;
      embeddingModel = result.data.embedding.model;
      embeddingBaseUrl = result.data.embedding.baseUrl ?? "";
      embeddingApiFormat = result.data.embedding.apiFormat === "anthropic" ? "openai-compatible" : result.data.embedding.apiFormat;
      embeddingDimensions = String(result.data.embedding.dimensions);
      embeddingVersion = result.data.embedding.version;
      embeddingApiKey = "";
      embeddingSecretConfigured = result.data.embedding.secretConfigured;
      clearEmbeddingApiKey = false;
      savedSnapshot = currentSnapshot;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function saveSettings() {
    if (invalidRetention || invalidAi || invalidEmbedding || saving) return;
    saving = true;
    error = null;
    savedAt = null;
    try {
      const result = await appApi.saveSettings({
        retentionDays: parsedRetention,
        ai: {
          provider: aiProvider,
          model: aiModel.trim(),
          baseUrl: aiBaseUrl.trim() || undefined,
          apiFormat: aiApiFormat,
          ...(clearAiApiKey
            ? { clearApiKey: true }
            : aiApiKey.trim()
              ? { apiKey: aiApiKey }
              : {}),
        },
        embedding: {
          provider: embeddingProvider,
          model: embeddingModel.trim(),
          baseUrl: embeddingBaseUrl.trim() || undefined,
          apiFormat: embeddingApiFormat,
          dimensions: parsedEmbeddingDimensions,
          version: embeddingVersion.trim(),
          ...(clearEmbeddingApiKey
            ? { clearApiKey: true }
            : embeddingApiKey.trim()
              ? { apiKey: embeddingApiKey }
              : {}),
        },
      });
      if (!result.ok) {
        error = result.message;
        return;
      }
      retentionDays = result.data.observability.retentionDays;
      draftRetentionDays = String(retentionDays);
      aiProvider = result.data.ai.provider;
      aiModel = result.data.ai.model;
      aiBaseUrl = result.data.ai.baseUrl ?? "";
      aiApiFormat = result.data.ai.apiFormat;
      aiApiKey = "";
      aiSecretConfigured = result.data.ai.secretConfigured;
      clearAiApiKey = false;
      embeddingProvider = result.data.embedding.provider;
      embeddingModel = result.data.embedding.model;
      embeddingBaseUrl = result.data.embedding.baseUrl ?? "";
      embeddingApiFormat = result.data.embedding.apiFormat === "anthropic" ? "openai-compatible" : result.data.embedding.apiFormat;
      embeddingDimensions = String(result.data.embedding.dimensions);
      embeddingVersion = result.data.embedding.version;
      embeddingApiKey = "";
      embeddingSecretConfigured = result.data.embedding.secretConfigured;
      clearEmbeddingApiKey = false;
      savedSnapshot = currentSnapshot;
      savedAt = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  function resetDraft() {
    draftRetentionDays = String(retentionDays);
    void loadSettings();
  }

  function markClearAiApiKey() {
    aiApiKey = "";
    clearAiApiKey = true;
    aiSecretConfigured = false;
  }

  function markClearEmbeddingApiKey() {
    embeddingApiKey = "";
    clearEmbeddingApiKey = true;
    embeddingSecretConfigured = false;
  }
</script>

<section class="settings">
  <aside>
    <div class="title">个人设置</div>
    <button class="selected"><Icon name="settings" size={15} />偏好设置</button>
  </aside>

  <div class="main">
    <header>
      <div>
        <h2>设置</h2>
        <p>{workspaceName}</p>
      </div>
      <button class="secondary-btn" onclick={loadSettings} disabled={loading || saving}>
        <Icon name="refresh" size={14} />刷新
      </button>
    </header>

    <div class="profile-panel">
      <Avatar name={userName} size={48} />
      <div>
        <strong>{userName}</strong>
        <span>{userEmail}</span>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <div>
          <h3>AI 模型</h3>
          <p>配置默认模型和第三方 API Key。API Key 会按明文写入本机 SurrealDB 设置表。</p>
        </div>
        <span class="status" class:dirty>{dirty ? "未保存" : "已同步"}</span>
      </div>

      <div class="setting-grid">
        <label class="field">
          <span>服务商</span>
          <select bind:value={aiProvider} disabled={loading || saving}>
            {#each providerOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>

        <label class="field">
          <span>模型</span>
          <input bind:value={aiModel} placeholder="provider/model 或模型名" disabled={loading || saving} />
        </label>

        <label class="field">
          <span>接口格式</span>
          <select bind:value={aiApiFormat} disabled={loading || saving}>
            {#each apiFormatOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>

        <label class="field">
          <span>Base URL</span>
          <input bind:value={aiBaseUrl} placeholder="https://api.openai.com/v1" disabled={loading || saving} />
          <small>{selectedApiFormat.hint}</small>
        </label>

        <label class="field secret-field">
          <span>API Key</span>
          <div class="secret-input">
            <input
              type="text"
              bind:value={aiApiKey}
              placeholder={aiSecretConfigured ? "已保存 API Key；留空将继续保留" : "粘贴 API Key"}
              disabled={loading || saving || clearAiApiKey}
            />
            {#if (aiApiKey || aiSecretConfigured) && !clearAiApiKey}
              <button type="button" class="secondary-btn clear-secret" onclick={markClearAiApiKey} disabled={loading || saving}>
                清除
              </button>
            {/if}
          </div>
        </label>
      </div>

      <div class="secret-note">
        <Icon name="lock" size={14} />
        <span>
          {#if clearAiApiKey}
            保存后会删除当前 API Key。
          {:else}
            {aiSecretConfigured ? "已保存 API Key。出于安全原因，密钥明文不会回显到界面。" : "API Key 只会提交到主进程保存，不会从设置接口回显。"} Base URL 统一填写到 API 版本级别，不要填 /chat/completions、/responses 或 /messages。
          {/if}
        </span>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <div>
          <h3>向量模型 (Embedding)</h3>
          <p>资源检索的语义索引使用独立的 embedding 模型；与对话模型分离，避免对话供应商的限制影响语义搜索。修改模型、维度或版本会让旧资源进入重新索引状态。</p>
        </div>
        <span class="status" class:dirty>{dirty ? "未保存" : "已同步"}</span>
      </div>

      <div class="setting-grid">
        <label class="field">
          <span>服务商</span>
          <select bind:value={embeddingProvider} disabled={loading || saving}>
            {#each providerOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>

        <label class="field">
          <span>模型</span>
          <input bind:value={embeddingModel} placeholder="例如 text-embedding-3-small" disabled={loading || saving} />
        </label>

        <label class="field">
          <span>接口格式</span>
          <select bind:value={embeddingApiFormat} disabled={loading || saving}>
            {#each embeddingApiFormatOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>

        <label class="field">
          <span>Base URL</span>
          <input bind:value={embeddingBaseUrl} placeholder="https://api.openai.com/v1" disabled={loading || saving} />
          <small>{selectedEmbeddingApiFormat.hint}</small>
        </label>

        <label class="field">
          <span>向量维度</span>
          <input
            type="number"
            min="1"
            max="8192"
            step="1"
            bind:value={embeddingDimensions}
            disabled={loading || saving}
          />
          <small>必须与所选模型实际输出维度一致；不一致会被主进程拒绝。</small>
        </label>

        <label class="field">
          <span>Profile 版本</span>
          <input bind:value={embeddingVersion} placeholder="v1" disabled={loading || saving} />
          <small>用于隔离不同 provider/模型/维度的向量。变更后旧 embedding 会被标记为 stale，需要重建。</small>
        </label>

        <label class="field secret-field">
          <span>API Key</span>
          <div class="secret-input">
            <input
              type="text"
              bind:value={embeddingApiKey}
              placeholder={embeddingSecretConfigured ? "已保存 API Key；留空将继续保留" : "粘贴 API Key"}
              disabled={loading || saving || clearEmbeddingApiKey}
            />
            {#if (embeddingApiKey || embeddingSecretConfigured) && !clearEmbeddingApiKey}
              <button type="button" class="secondary-btn clear-secret" onclick={markClearEmbeddingApiKey} disabled={loading || saving}>
                清除
              </button>
            {/if}
          </div>
        </label>
      </div>

      <div class="secret-note">
        <Icon name="lock" size={14} />
        <span>
          {#if clearEmbeddingApiKey}
            保存后会删除当前 embedding API Key；未配置 Key 时资源仍可保存，但只能用关键词检索。
          {:else}
            {embeddingSecretConfigured ? "已保存 embedding API Key。出于安全原因，密钥明文不会回显到界面。" : "未配置 API Key 时仍可保存资源，但语义检索会处于 disabled 状态。"}
          {/if}
        </span>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <div>
          <h3>观测数据</h3>
          <p>控制 Mastra traces、事件和调试数据在本机数据库中的保留时间。</p>
        </div>
        <span class="status" class:dirty>{dirty ? "未保存" : "已同步"}</span>
      </div>

      <label class="setting-row">
        <span>
          <strong>保留天数</strong>
          <small>范围 1 到 3650 天；新写入的数据会按这个值计算过期时间。</small>
        </span>
        <input
          type="number"
          min="1"
          max="3650"
          step="1"
          bind:value={draftRetentionDays}
          disabled={loading || saving}
        />
      </label>

      {#if invalidRetention}
        <div class="message error"><Icon name="alertCircle" size={14} />请输入 1 到 3650 之间的整数。</div>
      {:else if invalidAi}
        <div class="message error"><Icon name="alertCircle" size={14} />AI 模型不能为空。</div>
      {:else if !embeddingModel.trim()}
        <div class="message error"><Icon name="alertCircle" size={14} />向量模型不能为空。</div>
      {:else if invalidEmbeddingDimensions}
        <div class="message error"><Icon name="alertCircle" size={14} />向量维度需为 1 到 8192 之间的整数。</div>
      {:else if !embeddingVersion.trim()}
        <div class="message error"><Icon name="alertCircle" size={14} />Profile 版本不能为空。</div>
      {:else if error}
        <div class="message error"><Icon name="alertCircle" size={14} />{error}</div>
      {:else if savedAt}
        <div class="message success"><Icon name="checkCircle" size={14} />已保存于 {savedAt}</div>
      {/if}

      <div class="actions">
        <button class="secondary-btn" onclick={resetDraft} disabled={!dirty || saving}>
          撤销
        </button>
        <button class="primary-btn" onclick={saveSettings} disabled={!dirty || invalidRetention || invalidAi || invalidEmbedding || loading || saving}>
          <Icon name="check" size={14} color="#fff" />{saving ? "保存中" : "保存设置"}
        </button>
      </div>
    </div>
  </div>
</section>

<style>
  .settings {
    display: flex;
    flex: 1;
    overflow: hidden;
    background: var(--bg);
  }

  aside {
    width: 200px;
    flex-shrink: 0;
    padding: 16px 8px;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .title {
    padding: 0 8px 10px;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .6px;
  }

  aside button {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 9px;
    padding: 8px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
  }

  aside button.selected {
    background: var(--primary-light);
    color: var(--primary);
    font-weight: 650;
  }

  .main {
    flex: 1;
    overflow: auto;
    padding: 28px 32px;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    color: var(--text-1);
    font-size: 18px;
  }

  header p,
  .section-head p,
  .setting-row small {
    color: var(--text-3);
    font-size: 12px;
  }

  .profile-panel,
  .section {
    max-width: 760px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }

  .profile-panel {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    margin-bottom: 14px;
  }

  .profile-panel strong,
  .profile-panel span {
    display: block;
  }

  .profile-panel strong {
    color: var(--text-1);
    font-size: 14px;
  }

  .profile-panel span {
    margin-top: 2px;
    color: var(--text-3);
    font-size: 12px;
  }

  .section {
    padding: 18px;
    margin-bottom: 14px;
  }

  .section-head {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    justify-content: space-between;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }

  h3 {
    margin-bottom: 4px;
    color: var(--text-1);
    font-size: 15px;
  }

  .status {
    flex-shrink: 0;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--success-bg);
    color: var(--success);
    font-size: 11px;
    font-weight: 650;
  }

  .status.dirty {
    background: var(--warning-bg);
    color: var(--warning);
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 18px 0;
  }

  .setting-row span {
    min-width: 0;
  }

  .setting-row strong {
    display: block;
    margin-bottom: 4px;
    color: var(--text-1);
    font-size: 13px;
  }

  .setting-row input {
    width: 120px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface);
    color: var(--text-1);
    outline: none;
  }

  .setting-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    padding-top: 18px;
  }

  .field {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 7px;
  }

  .field span {
    color: var(--text-2);
    font-size: 12px;
    font-weight: 650;
  }

  .field small {
    color: var(--text-3);
    font-size: 11px;
    line-height: 1.45;
  }

  .field input,
  .field select {
    width: 100%;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface);
    color: var(--text-1);
    outline: none;
  }

  .secret-field {
    grid-column: 1 / -1;
  }

  .secret-input {
    display: flex;
    gap: 8px;
  }

  .secret-input input {
    flex: 1;
  }

  .clear-secret {
    flex-shrink: 0;
    padding: 8px 12px;
  }

  .field input:focus,
  .field select:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-light);
  }

  .secret-note {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    margin-top: 14px;
    padding: 9px 10px;
    border-radius: 7px;
    background: var(--soft);
    color: var(--text-2);
    font-size: 12px;
  }

  .setting-row input:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-light);
  }

  .message {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 7px;
    font-size: 12px;
  }

  .message.error {
    background: var(--error-bg);
    color: var(--error);
  }

  .message.success {
    background: var(--success-bg);
    color: var(--success);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  .actions button,
  header button {
    padding: 8px 12px;
  }

  button:disabled,
  input:disabled {
    cursor: not-allowed;
    opacity: .55;
  }

  @media (max-width: 760px) {
    aside {
      display: none;
    }

    .main {
      padding: 20px;
    }

    .setting-row {
      align-items: stretch;
      flex-direction: column;
      gap: 10px;
    }

    .setting-row input {
      width: 100%;
    }

    .setting-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
