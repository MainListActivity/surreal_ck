<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import Logo from "../components/Logo.svelte";
  import SelectMenu from "../components/SelectMenu.svelte";
  import type { Navigate } from "../lib/types";

  let { navigate, mode = "form" }: { navigate: Navigate; mode?: "form" | "success" } = $props();

  let values = $state<Record<string, string>>({});
  let errors = $state<Record<string, string>>({});
  let files = $state<{ name: string; size: string }[]>([]);

  function setValue(key: string, value: string) {
    values = { ...values, [key]: value };
    errors = { ...errors, [key]: "" };
  }

  function submit() {
    const next: Record<string, string> = {};
    for (const key of ["name", "idno", "contact", "amount", "type"]) {
      if (!values[key]) next[key] = key === "type" ? "请选择债权类型" : "请填写必填项";
    }
    errors = next;
    if (!Object.keys(next).length) navigate("form-success");
  }
</script>

<section class="public-form">
  <header><button class="logo-btn" onclick={() => navigate("home")}><Logo size="sm" /></button><span>债权申报在线登记</span></header>

  {#if mode === "success"}
    <div class="success-card">
      <div class="success-icon"><Icon name="checkCircle" size={36} color="var(--success)" /></div>
      <h1>申报已成功提交</h1>
      <p>您的债权申报材料已收到。管理人团队将在审核完成后通过您留下的联系方式与您取得联系。</p>
      <dl>
        <dt>受理案件</dt><dd>华润置地（集团）股份有限公司破产重整案</dd>
        <dt>受理编号</dt><dd>CK-2026-03-426</dd>
        <dt>提交时间</dt><dd>2026/04/24 07:08</dd>
        <dt>审核周期</dt><dd>预计 5-10 个工作日</dd>
      </dl>
      <button class="secondary-btn" onclick={() => navigate("form")}>返回重新填写</button>
    </div>
  {:else}
    <div class="form-wrap">
      <div class="case-info"><Icon name="info" size={16} color="var(--primary)" /><div><strong>华润置地（集团）股份有限公司破产重整案</strong><span>案号：（2026）京01破字第003号 · 申报截止日期：2026年05月31日 · 管理人：北京德恒律师事务所</span></div></div>

      {#each [
        { title: "基本信息", fields: [["name", "债权人名称", "请输入法定名称或姓名", true], ["idno", "证件号码", "身份证号或统一社会信用代码", true], ["contact", "联系方式", "手机号或固定电话", true], ["email", "电子邮箱", "example@email.com", false]] },
        { title: "债权信息", fields: [["amount", "申报金额（元）", "请输入申报金额，精确到分", true], ["type", "债权类型", "", true], ["basis", "债权依据", "如：借款合同、买卖合同、劳动合同等", false], ["note", "补充说明", "如有特殊情况请说明", false]] },
      ] as group}
        <div class="form-card">
          <h2>{group.title}</h2>
          {#each group.fields as field}
            <label>
              <span>{field[1]}{#if field[3]}<b>*</b>{/if}</span>
              {#if field[0] === "type"}
                <SelectMenu
                  value={values.type ?? ""}
                  options={[
                    { value: "", label: "请选择债权类型", disabled: true },
                    { value: "普通债权", label: "普通债权" },
                    { value: "有担保债权", label: "有担保债权" },
                    { value: "职工债权", label: "职工债权" },
                    { value: "工程款债权", label: "工程款债权" },
                    { value: "税务债权", label: "税务债权" },
                  ]}
                  ariaLabel="债权类型"
                  onChange={(next) => setValue("type", next)}
                />
              {:else if field[0] === "note"}
                <textarea value={values.note ?? ""} placeholder={String(field[2])} oninput={(event) => setValue("note", event.currentTarget.value)}></textarea>
              {:else}
                <input value={values[String(field[0])] ?? ""} placeholder={String(field[2])} oninput={(event) => setValue(String(field[0]), event.currentTarget.value)} />
              {/if}
              {#if errors[String(field[0])]}<small><Icon name="alertCircle" size={11} color="var(--error)" />{errors[String(field[0])]}</small>{/if}
            </label>
          {/each}
        </div>
      {/each}

      <div class="form-card">
        <h2>上传证明材料</h2>
        <p>支持 PDF、Word、Excel、图片，单文件不超过 20MB</p>
        {#each files as file, index}
          <div class="attachment"><Icon name="paperclip" size={13} /><span>{file.name}</span><em>{file.size}</em><button onclick={() => (files = files.filter((_, i) => i !== index))}><Icon name="x" size={13} /></button></div>
        {/each}
        <button class="upload-box" onclick={() => (files = [...files, { name: `凭证${files.length + 1}.pdf`, size: "238 KB" }])}><Icon name="upload" size={20} color="var(--text-3)" />点击上传文件（模拟）</button>
      </div>
      <button class="submit" onclick={submit}>提交申报</button>
    </div>
  {/if}
</section>

<style>
  .public-form {
    flex: 1;
    overflow: auto;
    background: #f5f6fa;
  }

  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .logo-btn {
    display: flex;
    align-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    padding: 4px 6px;
    cursor: pointer;
  }

  .logo-btn:hover {
    background: var(--bg);
  }

  header > span {
    padding-left: 12px;
    border-left: 1px solid var(--border);
    color: var(--text-3);
    font-size: 12px;
  }

  .form-wrap {
    width: min(640px, calc(100% - 32px));
    margin: 28px auto;
  }

  .case-info {
    display: flex;
    gap: 12px;
    margin-bottom: 20px;
    padding: 14px 18px;
    border: 1px solid rgba(22, 100, 255, .25);
    border-radius: 10px;
    background: var(--primary-light);
  }

  .case-info strong {
    display: block;
    color: var(--primary);
    font-size: 13px;
  }

  .case-info span,
  .form-card p {
    color: var(--text-2);
    font-size: 11px;
    line-height: 1.6;
  }

  .form-card {
    margin-bottom: 16px;
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
  }

  h2 {
    margin: 0 0 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }

  label {
    display: block;
    margin-bottom: 16px;
  }

  label > span {
    display: block;
    margin-bottom: 6px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 550;
  }

  b,
  small {
    color: var(--error);
  }

  input,
  textarea {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 7px;
    outline: none;
    color: var(--text-1);
    font-size: 13px;
  }

  input:focus,
  textarea:focus {
    border-color: var(--primary);
  }

  textarea {
    min-height: 78px;
    resize: vertical;
  }

  small {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
    font-size: 11px;
  }

  .attachment {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    padding: 8px 12px;
    border-radius: 7px;
    background: var(--bg);
    color: var(--text-2);
    font-size: 12px;
  }

  .attachment span {
    flex: 1;
  }

  .attachment em {
    color: var(--text-3);
    font-size: 11px;
    font-style: normal;
  }

  .attachment button {
    border: 0;
    background: transparent;
  }

  .upload-box {
    display: grid;
    width: 100%;
    place-items: center;
    gap: 6px;
    padding: 20px;
    border: 2px dashed var(--border-dark);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text-3);
    font-size: 12px;
  }

  .submit {
    width: 100%;
    margin-bottom: 32px;
    padding: 13px 0;
    border: 0;
    border-radius: 9px;
    background: var(--primary);
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    box-shadow: 0 2px 8px rgba(22, 100, 255, .3);
  }

  .success-card {
    width: min(480px, calc(100% - 32px));
    margin: 80px auto;
    padding: 48px 40px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    text-align: center;
    box-shadow: 0 4px 24px rgba(0, 0, 0, .07);
  }

  .success-icon {
    display: grid;
    width: 72px;
    height: 72px;
    place-items: center;
    margin: 0 auto 20px;
    border-radius: 50%;
    background: var(--success-bg);
  }

  .success-card h1 {
    margin: 0 0 10px;
    font-size: 22px;
  }

  .success-card p {
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.7;
  }

  dl {
    display: grid;
    grid-template-columns: 72px 1fr;
    gap: 8px 10px;
    margin: 24px 0 28px;
    padding: 14px 18px;
    border-radius: 10px;
    background: var(--bg);
    text-align: left;
  }

  dt {
    color: var(--text-3);
    font-size: 11px;
  }

  dd {
    margin: 0;
    color: var(--text-1);
    font-size: 12px;
    font-weight: 550;
  }

  .success-card button {
    width: 100%;
    padding: 11px 0;
  }
</style>
