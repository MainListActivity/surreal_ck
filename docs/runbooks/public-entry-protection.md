# 公开入口 Turnstile 与双层限流

| 入口 | Turnstile action | 会话内保护 |
| --- | --- | --- |
| 外部协作者门户开会话 | `claims_portal` | 查询及草稿按 IP 和链接目标限流；提交、补正和附件上传每次核验 claims_write，并验证会话与链接 |
| 会议访客打开邀请 | `meeting_guest` | 等候、获准入场与后续命令沿用访客会话，受公开流量预算 |
| 名册核验 | `roster_verify` | 名册会话轮询、凭证签发、表决和回执受公开流量预算 |
| 官网机构试用 | `trial_request` | 每次提交核验，反馈通道继续按请求键幂等处理 |

同一 Turnstile 托管小组件可配置两个生产主机。源站通过 Siteverify 校验 `success`、预期 action 与允许 hostname，4 秒超时，异常时拒绝。有效令牌按进程短期去重。Cloudflare Worker 限流按边缘位置近似计数，源站在单进程内计数，按 IP 及资源设置窗口。公开限流响应是 429 并附 `Retry-After`。身份核验失败按入口统一返回错误。

## 发布配置

- 在现有 Cloudflare 账户准备 widget，允许 `l.maplayer.top` 和 `www.maplayer.top`。生产 GitHub Environment Variable 为 `VITE_TURNSTILE_SITEKEY`。预览和测试使用单独 widget 或 Cloudflare 测试密钥。
- 生产 GitHub Environment Secrets 用 `ORIGIN_ENV_TURNSTILE_SECRET`、`ORIGIN_ENV_TURNSTILE_HOSTNAMES`、`ORIGIN_ENV_EDGE_PROXY_SECRET` 下发。最后一项与现有 Worker secret 同值，源站仅接受认证代理设置的客户端 IP。确认 Worker 使用的限流 namespace `27904` 与 `27905` 在同账户内独占。
- 官网试用配置 `ORIGIN_ENV_TRIAL_REQUEST_ORIGIN=https://www.maplayer.top` 和 `ORIGIN_ENV_TRIAL_FEEDBACK_URL`，使用公司现有反馈入口的完整 `https://…/api/feedback/<project>` 地址。反馈策略须允许该来源；联系人和联系方式发往已有 `contact` 字段。
- 旧版原生名册客户端不能提供 Turnstile 令牌。2026-11-28 UTC 产品（老板）已明确确认：首期试点阶段外部名册核验统一只在 Web 浏览器端完成（现有名册 Web 入口可直接打开专属参会链接并完成 Turnstile 校验），原生客户端衔接移交主线 1（M-08）。

## 独立验收

先使用测试 workspace、合成外部主体与专用反馈测试产品。浏览器分别打开门户、访客、名册和官网表单，完成一次真实验证并回读业务结果；用同一令牌再提交一次，核对拒绝且无二次写入。核对无令牌、跨 action、跨 hostname、错误访问码与无效链接。预发布环境验证缺 secret 和小流量窗口限流的 429 与 `Retry-After`，核对源站日志及线上路由。官网反馈以脱敏收件号回读并核对联系字段。验收后按 test-kit 清理并记录 SHA、部署 ID 和清理回执。

参考 [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) 与 [Workers 限流绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。
