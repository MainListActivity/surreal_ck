# FV06 受控目录认证探针（零推理、默认关闭）

`POST /api/ops/internal-ai/endpoint-probe`

用于回答一个**很窄**的问题：**服务进程当前持有的产品身份，能否在固定目标端点读取模型目录**。
它不发送任何推理请求，也不是端点切换开关。

## 边界

| 项 | 约束 |
| --- | --- |
| 目标 | 固定 `https://data.maplayer.top/ofm/v1`，只发 `GET /models` |
| 身份 | 只用服务进程自己的 `AI_API_KEY`（来自运行中的 `server.env`），不读 env 文件、不 SSH |
| 调用方输入 | 不接受 URL / key / header / 模型 / 查询串 / 请求体；带任何查询串或请求体即 400 |
| 端点来源 | **不**使用当前 `AI_BASE_URL`（切换前它仍是 loopback），避免用错目标自证 |
| 方法 | 只 `GET`；不访问任何对话、补全、embedding 端点；不重试；不跟随重定向 |
| 限制 | 超时 5s、响应上限 64 KiB、进程内并发 1、两次探测间隔 ≥ 60s |
| 默认 | 关闭（`INTERNAL_AI_ENDPOINT_PROBE_ENABLED=0`） |

## 鉴权

按顺序判定：

1. 运营 OIDC 会话（ops audience）→ 否则 401；
2. 能力 `internal-ai.endpoint-probe` → 缺失即 403 `platform-operator-capability-missing`；
3. 探针开关 → 关闭即 503 `internal-ai-endpoint-probe-disabled`；
4. 限流 → 429 `internal-ai-endpoint-probe-busy` / `internal-ai-endpoint-probe-throttled`。

该能力是新增的专用能力，**不随生产运营能力 CSV 自动配置**；授予须经上线申请明确影响主体。

## 响应

```json
{
  "endpointHost": "data.maplayer.top",
  "endpointPath": "/ofm/v1",
  "checkedAt": "2026-11-02T05:31:08.226Z",
  "status": "catalog-readable",
  "errorType": null,
  "latencyMs": 42,
  "requestId": "9f0f…"
}
```

- `status`：`catalog-readable` / `rejected` / `unknown`。
- `errorType`：`not-configured` / `unauthorized` / `forbidden` / `rate-limited` / `timeout` / `connection-failed` / `redirected` / `invalid-json` / `response-too-large` / `unexpected-catalog` / `unexpected-status`。
- `requestId` 是随机关联 ID，**不对凭证或 Authorization 做哈希**；响应不含上游正文、错误原文、密钥或 header。
- 审计行（`[ops-audit] internal-ai.endpoint-probe`）只写调用者 subject、固定端点、时间、结果、关联 ID 与延迟。

## 判定

- `catalog-readable` **只**说明「该身份在该端点可读目录」。
- 401/403/429/超时/连接失败/重定向/非 JSON/内容不符/未知：一律不放行，也不据此推断密钥类型。
- 不得把本结果当作 `group/work` 推理权限、免费计费、流式兼容或客户会话兼容的证明，也不得据此自动打开窗口。

## 发布边界

- 本页描述的**只是探针代码**。批准该代码上线不等于批准切换 `AI_BASE_URL`、不等于授权生产推理、也不等于开窗。
- 生产启用需独立上线审批：写明影响主体、配置 `INTERNAL_AI_ENDPOINT_PROBE_ENABLED=1`、并按审批授予 `internal-ai.endpoint-probe` 能力。
- 部署 QA 先验「默认关闭」与「无权限拒绝」，**不自动执行真实上游探针**。
