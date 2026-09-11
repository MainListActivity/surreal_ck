/**
 * SCK-LCM-10 OAuth + MCP 生产验收脚本。
 *
 * 该脚本只读取本机 0600 临时文件中的 OAuth 状态，不打印密码、授权码或
 * token。它使用 RFC 8414 / RFC 7591 / RFC 7636 的授权码流程换取 token，
 * 然后用 Streamable HTTP 调用五个平台内容工具，并验证刷新与撤销。
 *
 * 运行前：
 *   1. 通过 ego-mcp-e2e.mjs 完成浏览器登录和同意；
 *   2. 保证 /tmp/sck-mcp-e2e-callback.json 已生成；
 *   3. 配置 CONTENT_MCP_URL（默认生产地址）。
 *
 * 默认只提交并 inspect，不发布。完整发布验收必须显式使用：
 *   --fixture --publish，且 CONTENT_PUBLISH_CONFIRM=YES。
 * 加上 --full-lifecycle 会额外验证文书修订、撤回、恢复、法规条文拆分和
 * 已发布投影读取；仅能与上述两个 flag 同时使用。
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const paths = {
  client: process.env.CONTENT_DCR_FILE?.trim() || "/tmp/sck-mcp-e2e.json",
  oauth: process.env.CONTENT_OAUTH_FILE?.trim() || "/tmp/sck-mcp-e2e-oauth.json",
  callback: process.env.CONTENT_CALLBACK_FILE?.trim() || "/tmp/sck-mcp-e2e-callback.json",
  tokens: process.env.CONTENT_TOKENS_FILE?.trim() || "/tmp/sck-mcp-e2e-tokens.json",
  report: process.env.CONTENT_E2E_REPORT_FILE?.trim() || "/tmp/sck-mcp-e2e-report.json",
};

const mcpUrl = process.env.CONTENT_MCP_URL?.trim() || "https://l.maplayer.top/api/ops/mcp";
const issuer = process.env.CONTENT_ISSUER?.trim() || "https://o.maplayer.top/t/ck";
const tokenEndpoint = process.env.CONTENT_TOKEN_ENDPOINT?.trim() || `${issuer}/token`;
const revokeEndpoint = process.env.CONTENT_REVOCATION_ENDPOINT?.trim() || `${issuer}/revoke`;
const protocolVersion = "2025-06-18";
const publishRequested = process.argv.includes("--publish");
const fixtureRequested = process.argv.includes("--fixture");
const fullLifecycleRequested = process.argv.includes("--full-lifecycle");

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 不是对象`);
  }
  return value;
}

async function jsonFile(path, label) {
  try {
    return object(JSON.parse(await readFile(path, "utf8")), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} JSON 无效`);
    throw new Error(`${label} 不可读取：${path}`);
  }
}

async function savePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // writeFile 的 mode 对已存在文件不生效，显式收紧权限。
  await chmod(path, 0o600);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} 缺失`);
  return value;
}

function safeHttpError(status, statusText) {
  return { httpStatus: status, statusText: statusText || undefined };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    // enableJsonResponse 通常返回 JSON；兼容 MCP 服务端回退到 SSE 的实现。
    const candidates = text
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter(Boolean)
      .reverse();
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // 继续找最后一个可解析的 data 行。
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resultValue(result) {
  if (result && typeof result === "object" && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = result && typeof result === "object" && Array.isArray(result.content)
    ? result.content
    : [];
  const text = content.find((item) => item && typeof item === "object" && item.type === "text")?.text;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function businessError(result) {
  const value = resultValue(result);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { code: "unknown" };
  const error = value.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return { code: "unknown" };
  return {
    code: typeof error.code === "string" ? error.code : "unknown",
    message: typeof error.message === "string" ? error.message : undefined,
  };
}

class McpClient {
  constructor(accessToken) {
    this.accessToken = requiredString(accessToken, "access token");
    this.sessionId = null;
    this.requestId = 0;
  }

  async rpc(method, params = {}) {
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, params }),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    const body = await parseJsonResponse(response);
    return { response, body };
  }

  async initialize() {
    return this.rpc("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "surreal-ck-codex-e2e", version: "1.0.0" },
    });
  }

  async tool(name, args) {
    return this.rpc("tools/call", { name, arguments: args });
  }
}

function summarizeRpc(call) {
  const status = call.response.status;
  const envelope = call.body && typeof call.body === "object" ? call.body : null;
  const rpcError = envelope?.error && typeof envelope.error === "object" ? envelope.error : null;
  const result = envelope?.result && typeof envelope.result === "object" ? envelope.result : null;
  return {
    httpStatus: status,
    ok: call.response.ok && !rpcError && Boolean(result),
    ...(rpcError ? { rpcError: { code: rpcError.code, message: rpcError.message } } : {}),
    ...(result?.isError === true ? { businessError: businessError(result) } : {}),
    ...(result && result.isError !== true ? { value: resultValue(result) } : {}),
  };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fixtureToken(value, prefix) {
  return `${prefix}-${sha256(value).slice(0, 16)}`;
}

/** 明确标记为 synthetic；不能当作真实来源或可销售内容。 */
function syntheticJudgmentBatch(options = {}) {
  const idempotencyKey = options.idempotencyKey
    ?? process.env.CONTENT_FIXTURE_IDEMPOTENCY_KEY?.trim()
    ?? "fixture-synthetic-judgment-v1";
  const recordKey = options.recordKey ?? fixtureToken(idempotencyKey, "judgment");
  const caseNumber = `(fixture) ${recordKey}`;
  const bodyRevision = options.bodyRevision ?? "";
  const bodyText =
    "【合成全文】本院经审理查明：当事人行为时有效的《合同法》第四百条规定，受托人应当报告处理委托事务的情况。" +
    `本院认为，争议应依照证据和适用时点判断。判决如下：驳回全部诉讼请求。${bodyRevision}`;
  const quotedText = "当事人行为时有效的《合同法》第四百条规定";
  const bodySha256 = sha256(bodyText);
  const start = Buffer.byteLength(bodyText.slice(0, bodyText.indexOf(quotedText)), "utf8");
  const end = start + Buffer.byteLength(quotedText, "utf8");
  return {
    contractVersion: "1",
    idempotencyKey,
    items: [{
      entryKey: fixtureToken(idempotencyKey, "fixture-judgment"),
      operation: "upsert",
      payload: {
        kind: "judicial_document",
        source: {
          sourceKey: "fixture.synthetic.cn",
          url: `https://example.invalid/fixture/${recordKey}`,
          recordKey,
          fetchedAt: "2026-09-01T12:00:00Z",
          publishedAt: null,
          updatedAt: null,
          publishedOn: "2026-09-01",
          updatedOn: null,
          dateText: null,
        },
        document: {
          title: "合成民事判决书（契约测试）",
          bodyText,
          sourceForm: "full_text",
          evidence: [{ text: "合成来源，仅用于协议边界测试。", sourceLocator: null }],
          fieldIssues: [],
          processing: {
            pipelineVersion: "fixture-v1",
            methods: ["synthetic-fixture"],
            agentName: null,
            model: null,
            cleaningNotes: "不代表任何真实裁判文书。",
          },
          clientDigest: { bodySha256 },
        },
        judgment: {
          documentType: "民事判决书",
          caseNumber,
          court: "合成测试法院",
          decidedOn: "2026-09-01",
          causeOfAction: "合同纠纷",
          instance: "一审",
          procedure: "普通程序",
          outcome: { disposition: "驳回全部诉讼请求", evidenceRef: null },
          citationExtractionStatus: "processed_complete",
          citations: [{
            localCitationKey: "citation-1",
            relationKind: "explicit_citation",
            speaker: "court",
            quotedText,
            locator: { start, end, bodyDigest: bodySha256, sourceLocator: null },
            rawLawName: "合同法",
            rawArticleLabel: "第四百条",
            resolution: "unresolved",
            candidates: [],
            treatment: "discusses",
            treatmentEvidence: "本院认为，争议应依照证据和适用时点判断。",
          }],
        },
        ...(options.target ? { target: options.target } : {}),
      },
    }],
  };
}

/** 用于验证法规条文拆分；同样是不可售合成数据。 */
function syntheticLegislationBatch(options = {}) {
  const idempotencyKey = options.idempotencyKey ?? "fixture-synthetic-legislation-v1";
  const recordKey = options.recordKey ?? fixtureToken(idempotencyKey, "legislation");
  const articleText = "第一条　本合成法规仅用于验证平台内容发布和条文拆分能力。";
  const bodyText = `【合成法规】SCK-LCM-10 平台内容验收规范\n${articleText}`;
  const start = Buffer.byteLength(bodyText.slice(0, bodyText.indexOf(articleText)), "utf8");
  const end = start + Buffer.byteLength(articleText, "utf8");
  const bodySha256 = sha256(bodyText);
  return {
    contractVersion: "1",
    idempotencyKey,
    items: [{
      entryKey: fixtureToken(idempotencyKey, "fixture-legislation"),
      operation: "upsert",
      payload: {
        kind: "legislation",
        source: {
          sourceKey: "fixture.synthetic.cn",
          url: `https://example.invalid/fixture/${recordKey}`,
          recordKey,
          fetchedAt: "2026-09-01T12:00:00Z",
          publishedAt: null,
          updatedAt: null,
          publishedOn: "2026-09-01",
          updatedOn: null,
          dateText: null,
        },
        document: {
          title: "SCK-LCM-10 合成法规（契约测试）",
          bodyText,
          sourceForm: "full_text",
          evidence: [{ text: "合成来源，仅用于协议边界测试。", sourceLocator: { paragraph: 1 } }],
          fieldIssues: [],
          processing: {
            pipelineVersion: "fixture-v1",
            methods: ["synthetic-fixture"],
            agentName: null,
            model: null,
            cleaningNotes: "不代表任何真实法规。",
          },
          clientDigest: { bodySha256 },
        },
        legislation: {
          issuingAuthorities: ["合成测试机关"],
          instrumentType: "规范性文件",
          documentNumber: `(fixture) ${recordKey}`,
          promulgatedOn: "2026-09-01",
          effectiveOn: "2026-09-01",
          repealedOn: null,
          legalStatus: "effective",
          versionLabel: "fixture-v1",
          versionResolution: "resolved",
          amendsRefs: [],
          articles: [{
            localKey: "article-1",
            label: "第一条",
            hierarchyPath: ["第一章"],
            bodyText: articleText,
            locator: { start, end, bodyDigest: bodySha256 },
            sourceLocator: { paragraph: 1, articleLabel: "第一条" },
            effectiveOn: "2026-09-01",
          }],
        },
      },
    }],
  };
}

async function loadBatch() {
  if (fixtureRequested) return syntheticJudgmentBatch();
  const path = process.env.CONTENT_BATCH_FILE?.trim();
  if (!path) return null;
  return object(JSON.parse(await readFile(path, "utf8")), "CONTENT_BATCH_FILE");
}

function contentApiUrl(pathname) {
  const url = new URL(mcpUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * 真实生产验收不能把合成文书伪装成公开数据。仅在 --fixture 时登记专用、
 * 不可售的来源；已经存在时只验证其权限，不制造新的许可修订。
 */
async function ensureSyntheticFixtureSource(accessToken) {
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  const listed = await fetch(contentApiUrl("/api/content/sources"), { headers });
  const existing = await parseJsonResponse(listed);
  if (!listed.ok || !Array.isArray(existing)) {
    return { ok: false, httpStatus: listed.status, created: false };
  }

  const source = existing.find((item) => item && typeof item === "object" && item.sourceKey === "fixture.synthetic.cn");
  if (source) {
    const allowed = Array.isArray(source.allowedActions) ? source.allowedActions : [];
    return {
      ok: source.status === "active" && allowed.includes("submit") && allowed.includes("publish"),
      httpStatus: listed.status,
      created: false,
    };
  }

  const registered = await fetch(contentApiUrl("/api/content/sources"), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      sourceKey: "fixture.synthetic.cn",
      label: "SCK-LCM-10 合成验收来源（不可售）",
      jurisdiction: "中国大陆（合成测试）",
      baseUrl: "https://example.invalid/sck-lcm-10",
      status: "active",
      allowedActions: ["submit", "publish", "withdraw", "restore"],
      license: {
        licenseKind: "synthetic-e2e-only",
        allowedActions: ["submit", "publish", "withdraw", "restore"],
        effectiveFrom: "2026-09-01T00:00:00Z",
        effectiveUntil: null,
        evidenceUrl: "https://example.invalid/sck-lcm-10/license",
        evidenceText: "仅用于 SCK-LCM-10 自动验收；不代表真实裁判文书、不可对外销售或作为法律内容提供。",
      },
    }),
  });
  const sourceResult = await parseJsonResponse(registered);
  return {
    ok: registered.ok && sourceResult?.sourceKey === "fixture.synthetic.cn",
    httpStatus: registered.status,
    created: registered.ok,
  };
}

function clientAuth(client, headers, form) {
  const method = client.token_endpoint_auth_method || "none";
  if (method === "client_secret_basic") {
    const secret = requiredString(client.client_secret, "client_secret");
    headers.authorization = `Basic ${Buffer.from(`${requiredString(client.client_id, "client_id")}:${secret}`).toString("base64")}`;
  } else if (method === "client_secret_post") {
    form.client_id = requiredString(client.client_id, "client_id");
    form.client_secret = requiredString(client.client_secret, "client_secret");
  } else {
    form.client_id = requiredString(client.client_id, "client_id");
  }
}

async function oauthForm(client, endpoint, values) {
  const form = { ...values };
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  clientAuth(client, headers, form);
  const response = await fetch(endpoint, { method: "POST", headers, body: new URLSearchParams(form) });
  const body = await parseJsonResponse(response);
  return { response, body };
}

function tokenSummary(body) {
  return {
    tokenType: typeof body?.token_type === "string" ? body.token_type : null,
    expiresIn: typeof body?.expires_in === "number" ? body.expires_in : null,
    hasAccessToken: typeof body?.access_token === "string" && body.access_token.length > 0,
    hasRefreshToken: typeof body?.refresh_token === "string" && body.refresh_token.length > 0,
  };
}

async function main() {
  if (fullLifecycleRequested && (!fixtureRequested || !publishRequested)) {
    throw new Error("--full-lifecycle 只能与 --fixture --publish 一起使用");
  }
  const [client, oauth, callback] = await Promise.all([
    jsonFile(paths.client, "DCR client"),
    jsonFile(paths.oauth, "OAuth 状态"),
    jsonFile(paths.callback, "OAuth 回调"),
  ]);
  const callbackParams = object(callback.params, "OAuth 回调参数");
  if (callback.path !== "/callback") throw new Error("OAuth 回调路径不正确");
  if (callbackParams.error) throw new Error(`OAuth 授权失败：${String(callbackParams.error)}`);
  if (callbackParams.state !== oauth.state) throw new Error("OAuth state 校验失败");
  const code = requiredString(callbackParams.code, "OAuth authorization code");
  const redirectUri = requiredString(oauth.redirect_uri, "redirect_uri");
  const resource = requiredString(oauth.resource, "resource");

  const report = {
    startedAt: new Date().toISOString(),
    endpoints: { issuer, token: tokenEndpoint, revoke: revokeEndpoint, mcp: mcpUrl, resource },
    client: {
      applicationType: client.application_type ?? null,
      tokenEndpointAuthMethod: client.token_endpoint_auth_method ?? null,
      grantTypes: Array.isArray(client.grant_types) ? client.grant_types : [],
    },
    oauth: { stateVerified: true, codeExchanged: false },
    protocol: {},
    lifecycle: {},
    refresh: {},
    revoke: {},
    failures: [],
  };

  const exchanged = await oauthForm(client, tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: requiredString(oauth.code_verifier, "code_verifier"),
    resource,
  });
  if (!exchanged.response.ok) {
    report.failures.push({ step: "authorization_code", ...safeHttpError(exchanged.response.status, exchanged.response.statusText) });
    throw new Error(`authorization_code 换 token 失败（HTTP ${exchanged.response.status}）`);
  }
  const firstTokens = object(exchanged.body, "token response");
  const initialAccess = requiredString(firstTokens.access_token, "access_token");
  const initialRefresh = typeof firstTokens.refresh_token === "string" ? firstTokens.refresh_token : null;
  report.oauth.codeExchanged = true;
  report.oauth.token = tokenSummary(firstTokens);
  await savePrivateJson(paths.tokens, {
    clientId: client.client_id,
    resource,
    obtainedAt: new Date().toISOString(),
    initial: firstTokens,
  });

  const clientForProtocol = new McpClient(initialAccess);
  const initialize = await clientForProtocol.initialize();
  report.protocol.initialize = summarizeRpc(initialize);
  if (!initialize.response.ok || !initialize.body?.result) {
    report.failures.push({ step: "initialize", ...safeHttpError(initialize.response.status, initialize.response.statusText) });
  }

  const toolsList = await clientForProtocol.rpc("tools/list", {});
  const toolsSummary = summarizeRpc(toolsList);
  const listedTools = toolsSummary.value?.tools;
  const expectedTools = ["get_data_contract", "search_content", "submit_batch", "inspect_batch", "publish_batch"];
  report.protocol.toolsList = {
    httpStatus: toolsSummary.httpStatus,
    ok: toolsSummary.ok && Array.isArray(listedTools) && listedTools.map((tool) => tool.name).join("\u0000") === expectedTools.join("\u0000"),
    names: Array.isArray(listedTools) ? listedTools.map((tool) => tool.name) : [],
  };
  if (!report.protocol.toolsList.ok) report.failures.push({ step: "tools/list", reason: "工具集合与五工具契约不一致" });

  async function callAndRecord(name, args) {
    const call = await clientForProtocol.tool(name, args);
    const summary = summarizeRpc(call);
    report.protocol[name] = {
      httpStatus: summary.httpStatus,
      ok: summary.ok && !summary.businessError,
      ...(summary.businessError ? { businessError: summary.businessError } : {}),
      ...(summary.value !== undefined ? { value: summary.value } : {}),
    };
    return { call, summary, value: summary.value };
  }

  async function submitInspectPublish(label, fixture) {
    const submitted = summarizeRpc(await clientForProtocol.tool("submit_batch", fixture));
    const submitOk = submitted.ok && !submitted.businessError;
    const batchId = typeof submitted.value?.batchId === "string" ? submitted.value.batchId : null;
    const result = {
      submit: { httpStatus: submitted.httpStatus, ok: submitOk, batchId, status: submitted.value?.status ?? null },
      inspect: null,
      publish: null,
      ok: false,
    };
    if (!submitOk || !batchId) {
      report.failures.push({ step: `${label}_submit`, reason: "未返回可发布的 batchId" });
      return result;
    }
    const inspected = summarizeRpc(await clientForProtocol.tool("inspect_batch", { batchId, cursor: null, limit: 100 }));
    const inspectOk = inspected.ok && !inspected.businessError;
    const entryKeys = Array.isArray(inspected.value?.entries)
      ? inspected.value.entries.map((entry) => entry?.entryKey).filter((entryKey) => typeof entryKey === "string")
      : [];
    result.inspect = {
      httpStatus: inspected.httpStatus,
      ok: inspectOk,
      validationRevision: inspected.value?.validationRevision ?? null,
      status: inspected.value?.status ?? null,
      entryKeys,
    };
    if (!inspectOk || entryKeys.length === 0 || typeof inspected.value?.validationRevision !== "number") {
      report.failures.push({ step: `${label}_inspect`, reason: "批次不可发布或缺少 validationRevision" });
      return result;
    }
    const published = summarizeRpc(await clientForProtocol.tool("publish_batch", {
      batchId,
      validationRevision: inspected.value.validationRevision,
      entryKeys,
      idempotencyKey: `${fixture.idempotencyKey}:publish`,
    }));
    const entries = Array.isArray(published.value?.entries) ? published.value.entries : [];
    const completed = published.ok
      && !published.businessError
      && published.value?.status === "completed"
      && entries.length === entryKeys.length
      && entries.every((entry) => entry?.status === "published");
    result.publish = {
      httpStatus: published.httpStatus,
      ok: completed,
      status: published.value?.status ?? null,
      entries: entries.map((entry) => ({ entryKey: entry?.entryKey ?? null, status: entry?.status ?? null, versionId: entry?.versionId ?? null })),
    };
    result.ok = completed;
    if (!completed) report.failures.push({ step: `${label}_publish`, reason: "发布未完成" });
    return result;
  }

  async function readPublishedFixture(label, filters, expected) {
    const searched = summarizeRpc(await clientForProtocol.tool("search_content", { filters, limit: 20 }));
    const items = Array.isArray(searched.value?.items) ? searched.value.items : [];
    const item = expected.itemId
      ? items.find((candidate) => candidate?.itemId === expected.itemId) ?? null
      : items[0] ?? null;
    const ok = searched.ok
      && !searched.businessError
      && (expected.present ? item !== null : item === null)
      && (!expected.versionId || item?.version?.versionId === expected.versionId)
      && (!expected.bodyText || item?.bodyText === expected.bodyText);
    const result = {
      httpStatus: searched.httpStatus,
      ok,
      visible: item !== null,
      itemId: item?.itemId ?? null,
      versionId: item?.version?.versionId ?? null,
    };
    if (!ok) report.failures.push({ step: label, reason: "已发布投影读取结果与预期不一致" });
    return result;
  }

  async function runSyntheticFullLifecycle(initialBatch, initialPublication) {
    const initialPayload = initialBatch.items[0]?.operation === "upsert" ? initialBatch.items[0].payload : null;
    const initialEntry = Array.isArray(initialPublication?.entries) ? initialPublication.entries[0] : null;
    const initialVersionId = typeof initialEntry?.versionId === "string" ? initialEntry.versionId : null;
    if (!initialPayload || initialPayload.kind !== "judicial_document" || !initialVersionId) {
      report.failures.push({ step: "fixture_lifecycle_initial", reason: "首个合成文书未返回发布版本" });
      return { ok: false };
    }
    const caseNumber = initialPayload.judgment.caseNumber;
    const initialRead = await readPublishedFixture("fixture_lifecycle_initial_read", { caseNumber }, {
      present: true,
      versionId: initialVersionId,
      bodyText: initialPayload.document.bodyText,
    });
    if (!initialRead.ok || !initialRead.itemId) return { initialRead, ok: false };

    const correction = syntheticJudgmentBatch({
      idempotencyKey: `${initialBatch.idempotencyKey}-correction`,
      recordKey: initialPayload.source.recordKey,
      target: { itemId: initialRead.itemId, expectedVersionId: initialVersionId, expectedPublicationRevision: 1 },
      bodyRevision: "【合成修订：用于验证不可变版本与审计链。】",
    });
    const corrected = await submitInspectPublish("fixture_lifecycle_correction", correction);
    const correctedVersionId = corrected.publish?.entries?.[0]?.versionId ?? null;
    if (!corrected.ok || typeof correctedVersionId !== "string") return { initialRead, corrected, ok: false };
    const correctedBody = correction.items[0].payload.document.bodyText;
    const correctedRead = await readPublishedFixture("fixture_lifecycle_correction_read", { caseNumber }, {
      present: true,
      versionId: correctedVersionId,
      bodyText: correctedBody,
    });
    if (!correctedRead.ok) return { initialRead, corrected, correctedRead, ok: false };

    const withdrawal = {
      contractVersion: "1",
      idempotencyKey: `${initialBatch.idempotencyKey}-withdraw`,
      items: [{
        entryKey: fixtureToken(`${initialBatch.idempotencyKey}-withdraw`, "fixture-withdraw"),
        operation: "withdraw",
        payload: {
          target: { itemId: initialRead.itemId, expectedVersionId: correctedVersionId, expectedPublicationRevision: 2 },
          reason: "合成验收：验证撤回后投影不可读取。",
          evidenceRefs: [],
        },
      }],
    };
    const withdrawn = await submitInspectPublish("fixture_lifecycle_withdraw", withdrawal);
    if (!withdrawn.ok) return { initialRead, corrected, correctedRead, withdrawn, ok: false };
    const withdrawnRead = await readPublishedFixture("fixture_lifecycle_withdraw_read", { caseNumber }, {
      present: false,
      versionId: null,
      bodyText: null,
    });
    if (!withdrawnRead.ok) return { initialRead, corrected, correctedRead, withdrawn, withdrawnRead, ok: false };

    const restoration = {
      contractVersion: "1",
      idempotencyKey: `${initialBatch.idempotencyKey}-restore`,
      items: [{
        entryKey: fixtureToken(`${initialBatch.idempotencyKey}-restore`, "fixture-restore"),
        operation: "restore",
        payload: {
          target: { itemId: initialRead.itemId, expectedVersionId: correctedVersionId, expectedPublicationRevision: 3 },
          reason: "合成验收：验证恢复后投影重新可读取。",
          evidenceRefs: [],
        },
      }],
    };
    const restored = await submitInspectPublish("fixture_lifecycle_restore", restoration);
    if (!restored.ok) return { initialRead, corrected, correctedRead, withdrawn, withdrawnRead, restored, ok: false };
    const restoredRead = await readPublishedFixture("fixture_lifecycle_restore_read", { caseNumber }, {
      present: true,
      versionId: correctedVersionId,
      bodyText: correctedBody,
    });

    const legislation = syntheticLegislationBatch({ idempotencyKey: `${initialBatch.idempotencyKey}-legislation` });
    const legislationPublished = await submitInspectPublish("fixture_lifecycle_legislation", legislation);
    const legislationVersionId = legislationPublished.publish?.entries?.[0]?.versionId ?? null;
    const legislationKey = legislation.items[0].payload.source.recordKey;
    const legislationRead = typeof legislationVersionId === "string"
      ? await readPublishedFixture("fixture_lifecycle_legislation_read", { query: legislationKey }, {
        present: true,
        versionId: legislationVersionId,
        bodyText: legislation.items[0].payload.document.bodyText,
      })
      : { ok: false };
    if (!legislationRead.ok) report.failures.push({ step: "fixture_lifecycle_legislation_read", reason: "法规或条文发布后不可读取" });

    return {
      initialRead,
      corrected,
      correctedRead,
      withdrawn,
      withdrawnRead,
      restored,
      restoredRead,
      legislationPublished,
      legislationRead,
      ok: restoredRead.ok && legislationPublished.ok && legislationRead.ok,
    };
  }

  const contract = await callAndRecord("get_data_contract", {});
  if (!contract.summary.ok || contract.value?.contractVersion !== "1") {
    report.failures.push({ step: "get_data_contract", reason: "契约版本不是 1 或工具失败" });
  }
  const search = await callAndRecord("search_content", { filters: { query: "法" }, limit: 20 });
  if (!search.summary.ok) report.failures.push({ step: "search_content", reason: "检索工具失败" });

  const batch = await loadBatch();
  let batchId = null;
  if (!batch) {
    report.lifecycle = { skipped: true, reason: "未配置 --fixture 或 CONTENT_BATCH_FILE" };
  } else {
    if (fixtureRequested) {
      report.lifecycle.source = await ensureSyntheticFixtureSource(initialAccess);
      if (!report.lifecycle.source.ok) {
        report.failures.push({ step: "fixture_source", ...safeHttpError(report.lifecycle.source.httpStatus, "") });
      }
    }
    const submitted = await callAndRecord("submit_batch", batch);
    batchId = typeof submitted.value?.batchId === "string" ? submitted.value.batchId : null;
    report.lifecycle.submit = {
      httpStatus: submitted.summary.httpStatus,
      ok: submitted.summary.ok,
      batchId,
      status: submitted.value?.status ?? null,
      entries: Array.isArray(submitted.value?.entries) ? submitted.value.entries.map((entry) => ({
        entryKey: entry.entryKey,
        status: entry.status,
        issueCodes: Array.isArray(entry.issues) ? entry.issues.map((issue) => issue.code) : [],
      })) : [],
    };
    if (!batchId) {
      report.failures.push({ step: "submit_batch", reason: "未返回 batchId" });
    } else {
      const inspected = await callAndRecord("inspect_batch", { batchId, cursor: null, limit: 100 });
      const entries = Array.isArray(inspected.value?.entries) ? inspected.value.entries : [];
      report.lifecycle.inspect = {
        httpStatus: inspected.summary.httpStatus,
        ok: inspected.summary.ok,
        batchId,
        validationRevision: inspected.value?.validationRevision ?? null,
        status: inspected.value?.status ?? null,
        entries: entries.map((entry) => ({
          entryKey: entry.entryKey,
          status: entry.status,
          issueCodes: Array.isArray(entry.issues) ? entry.issues.map((issue) => issue.code) : [],
        })),
      };
      const entryKeys = entries.map((entry) => entry.entryKey).filter((entryKey) => typeof entryKey === "string");
      if (publishRequested) {
        if (process.env.CONTENT_PUBLISH_CONFIRM !== "YES") {
          throw new Error("--publish 必须同时设置 CONTENT_PUBLISH_CONFIRM=YES");
        }
        if (entryKeys.length === 0) {
          report.failures.push({ step: "publish_batch", reason: "inspect 没有条目" });
        } else {
          const published = await callAndRecord("publish_batch", {
            batchId,
            validationRevision: inspected.value?.validationRevision,
            entryKeys,
            idempotencyKey: `${batch.idempotencyKey}:publish`,
          });
          report.lifecycle.publish = {
            httpStatus: published.summary.httpStatus,
            ok: published.summary.ok,
            status: published.value?.status ?? null,
            entries: Array.isArray(published.value?.entries) ? published.value.entries.map((entry) => ({
              entryKey: entry.entryKey,
              status: entry.status,
              issueCodes: Array.isArray(entry.issues) ? entry.issues.map((issue) => issue.code) : [],
            })) : [],
          };
          if (!published.summary.ok || published.value?.status !== "completed") {
            report.failures.push({ step: "publish_batch", reason: "发布未完成" });
          }
          if (fullLifecycleRequested && fixtureRequested) {
            report.lifecycle.full = await runSyntheticFullLifecycle(batch, published.value);
          }
        }
      } else {
        report.lifecycle.publish = { skipped: true, reason: "默认停在人工审阅；需要 --publish + CONTENT_PUBLISH_CONFIRM=YES" };
      }
    }
  }

  if (initialRefresh) {
    const refreshed = await oauthForm(client, tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: initialRefresh,
      resource,
    });
    report.refresh = { httpStatus: refreshed.response.status, ok: refreshed.response.ok, token: tokenSummary(refreshed.body) };
    if (!refreshed.response.ok) {
      report.failures.push({ step: "refresh", ...safeHttpError(refreshed.response.status, refreshed.response.statusText) });
    } else {
      const refreshedTokens = object(refreshed.body, "refresh token response");
      const refreshedAccess = requiredString(refreshedTokens.access_token, "refreshed access_token");
      const reconnect = new McpClient(refreshedAccess);
      const reconnectCall = await reconnect.initialize();
      report.refresh.reconnect = summarizeRpc(reconnectCall);
      if (!reconnectCall.response.ok || !reconnectCall.body?.result) {
        report.failures.push({ step: "refresh_reconnect", reason: "刷新后的 token 无法重新连接 MCP" });
      }
      report.refresh.accessTokenAvailable = true;
      await savePrivateJson(paths.tokens, {
        clientId: client.client_id,
        resource,
        obtainedAt: new Date().toISOString(),
        initial: firstTokens,
        refreshed: refreshedTokens,
      });

      const tokensToRevoke = [
        { value: initialRefresh, hint: "refresh_token", label: "refresh" },
        { value: initialAccess, hint: "access_token", label: "initial_access" },
        { value: refreshedAccess, hint: "access_token", label: "refreshed_access" },
      ].filter((item) => item.value);
      const revocations = [];
      for (const token of tokensToRevoke) {
        const revoked = await oauthForm(client, revokeEndpoint, {
          token: token.value,
          token_type_hint: token.hint,
        });
        revocations.push({ label: token.label, httpStatus: revoked.response.status, ok: revoked.response.ok });
      }
      report.revoke.revocations = revocations;
      const refreshAfter = await oauthForm(client, tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: initialRefresh,
        resource,
      });
      report.revoke.refreshAfter = { httpStatus: refreshAfter.response.status, rejected: !refreshAfter.response.ok };
      if (refreshAfter.response.ok) report.failures.push({ step: "revoke_refresh", reason: "撤销 refresh token 后仍可刷新" });
      const revokedAccessCall = await new McpClient(refreshedAccess).initialize();
      report.revoke.mcpAfter = { httpStatus: revokedAccessCall.response.status, rejected: !revokedAccessCall.response.ok };
      if (revokedAccessCall.response.ok) report.failures.push({ step: "revoke_access", reason: "撤销 access token 后 MCP 仍接受旧 token" });
    }
  } else {
    report.refresh = { skipped: true, reason: "授权响应没有 refresh_token" };
    report.failures.push({ step: "refresh", reason: "IdP 未返回 refresh_token，无法完成撤销验收" });
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.failures.length === 0;
  await savePrivateJson(paths.report, report);
  // 仅输出不含 token / code 的摘要；详细结果保存在 0600 报告文件。
  console.log(JSON.stringify({
    ok: report.ok,
    reportFile: paths.report,
    protocol: {
      initialize: report.protocol.initialize?.ok ?? false,
      toolsList: report.protocol.toolsList?.ok ?? false,
      tools: ["get_data_contract", "search_content", "submit_batch", "inspect_batch", "publish_batch"].map((name) => ({
        name,
        ok: report.protocol[name]?.ok ?? false,
        businessError: report.protocol[name]?.businessError?.code ?? null,
      })),
    },
    lifecycle: report.lifecycle,
    fullLifecycle: report.lifecycle.full?.ok ?? null,
    refresh: { ok: report.refresh.ok ?? false, reconnect: report.refresh.reconnect?.ok ?? false },
    revoke: { refreshRejected: report.revoke.refreshAfter?.rejected ?? false, mcpRejected: report.revoke.mcpAfter?.rejected ?? false },
    failureCount: report.failures.length,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

await main().catch(async (error) => {
  // 错误文本只包含步骤和 HTTP 状态，不回显任何响应正文或凭证。
  console.error(error instanceof Error ? error.message : "OAuth/MCP 验收失败");
  process.exitCode = 1;
});
