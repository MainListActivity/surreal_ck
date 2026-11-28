Status: ready-for-agent

# 04 · 外部公开入口防滥用（Turnstile + 双层限流）

**目标**：为所有面向未登录外部人员的公开入口（外部协作者门户、外部会议访客/名册核验入口、官网试用申请表单）补齐 Cloudflare Turnstile 服务端核验与边缘/源站双层限流，防止凭证爆破、垃圾提交与恶意占满配额。

## 范围

1. **统一服务端 Turnstile 校验中间件**：在 Bun origin 封装可复用的 Turnstile Siteverify 校验模块（显式超时、校验 hostname 与 action、支持测试环境显式注入夹具、生产缺 secret 时 fail-closed）。
2. **覆盖全部外部入口**：
   - 外部协作者门户打开/核验与高频提交入口；
   - 外部会议访客与名册主体核验入口（联动 `meeting-and-collaboration` `06`、`08`）；
   - 官网试用申请提交入口（联动 `03`）。
3. **双层限流与统一错误契约**：Cloudflare Edge 与 Bun origin 协同按 IP + 目标资源键限流，超限返回明确 `429` 与 `Retry-After`；确保令牌枚举场景仍保持统一报错文案，不因限流或验证顺序差异泄漏令牌存在性。

## 非目标

- 不对已登录工作区内部成员的正常 OIDC 会话操作弹人机校验。

## 独立验收标准

- [x] 缺少、伪造、过期或跨 action/hostname 的 Turnstile 令牌在服务端一律被拒绝，测试覆盖完整正反例。
- [x] 生产配置未注入 Turnstile secret 时拒绝按“绕过校验”放行（fail-closed 单测覆盖）。
- [x] 高频请求触发限流返回 `429` 且不消耗业务表配额或生成垃圾记录；无效令牌与错访问码响应形态保持不可区分。
- [x] 生产试用页渲染 Turnstile。试用 API 拒绝缺失及伪造令牌与非法 Origin，门户开会话接口拒绝缺失令牌。
- [ ] 前端外部门户与表单完成真实浏览器端到端核验（官网试用表单已于 2026-11-28T06:38:43Z 由真人浏览器通过生产 Turnstile 完成提交、落库隔离校验与清理，回执 `7db09d49a4a7f226cbb1925b0daf1049cc4e553bb648ca7ef7705f73ecf24a07`；外部门户浏览器实测并入 `06` 生产 QA 结案）。
- [x] 外部名册核验客户端策略定稿：2026-11-28 UTC 老板确认首期试点外部名册核验统一走 Web 浏览器端（`web/src/lib/meeting/roster.ts` 已支持 Turnstile），旧版 Rust 原生名册客户端不再承担首期外部名册核验，后续原生衔接移交主线 1 M-08。

**依赖**：无。Cloudflare Turnstile 生产配置已部署。

**验证方式**：服务端单元/集成测试 + Cloudflare/origin 实测限流与 Turnstile 正反例。

## 2026-11-27 / 2026-11-28 UTC 生产实测

- 生产 Widget `surreal-ck-maplayer` 及 GitHub `production` 的 6 项运行配置已部署，`https://www.maplayer.top/trial/` 可渲染真实小组件。
- `POST /api/public/trial-request` 在缺令牌、伪造令牌或非法 Origin 时均返回 `403`。`POST /api/claims-portal/…/session` 缺令牌与无效令牌均统一返回 `401`（`claims-open-failed`）。
- 2026-11-28 UTC 生产限流实测：向 `POST https://l.maplayer.top/api/public/trial-request`（`Origin: https://www.maplayer.top`，合法 UUID `requestKey` + 伪造 `turnstileToken`）连续发起请求，第 1–12 次均返回 `HTTP 403`（`trial-verification-failed`，带 `Access-Control-Expose-Headers: Retry-After`），**第 13 次精确触发 `HTTP 429`（`public-rate-limited`，`Retry-After: 3`，`Access-Control-Allow-Origin: https://www.maplayer.top`）**，零垃圾记录入库。
- 2026-11-28T06:38:43Z 老板在真实浏览器访问 `https://www.maplayer.top/trial/` 完成真人 Cloudflare Turnstile 勾选提交，获取收件回执 `7db09d49a4a7f226cbb1925b0daf1049cc4e553bb648ca7ef7705f73ecf24a07`，生产库回读确认 `product_feedback` 与自动生成 `product_requirement` 均正确落库且联系方式零泄漏，随后完成双表清理归零。
- 2026-11-28 UTC 老板确认首期试点外部名册核验统一走 Web 浏览器端，旧版原生名册客户端 Turnstile 衔接移交主线 1（M-08）。
- 单测已覆盖失败关闭、跨 action 与 hostname、重放和边缘/源站限流。唯一余项为外部门户浏览器端复测（并入 `06` 生产 QA 结案）。[发布与验收手册](../../../docs/runbooks/public-entry-protection.md)
