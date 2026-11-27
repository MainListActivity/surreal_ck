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

- [ ] 缺少、伪造、过期或跨 action/hostname 的 Turnstile 令牌在服务端一律被拒绝，测试覆盖完整正反例。
- [ ] 生产配置未注入 Turnstile secret 时拒绝按“绕过校验”放行（fail-closed 单测覆盖）。
- [ ] 高频请求触发限流返回 `429` 且不消耗业务表配额或生成垃圾记录；无效令牌与错访问码响应形态保持不可区分。
- [x] 生产试用页渲染 Turnstile。试用 API 拒绝缺失及伪造令牌与非法 Origin，门户开会话接口拒绝缺失令牌。
- [ ] 前端外部门户与表单完成真实浏览器端到端核验。试用申请需人工通过生产 Turnstile，核对提交回执和落库。
- [ ] 现有原生名册客户端接入 Turnstile 令牌并完成生产衔接验收。

**依赖**：无。Cloudflare Turnstile 生产配置已部署。

**验证方式**：服务端单元/集成测试 + Cloudflare/origin 实测限流与 Turnstile 正反例。

## 2026-11-27 UTC 生产实测

- 生产 Widget `surreal-ck-maplayer` 及 GitHub `production` 的 6 项运行配置已部署，`https://www.maplayer.top/trial/` 可渲染真实小组件。
- `POST /api/public/trial-request` 在缺令牌、伪造令牌或非法 Origin 时均返回 403。`POST /api/claims-portal/…/session` 缺令牌时统一返回 401。
- 单测已覆盖失败关闭、跨 action 与 hostname、重放和限流。生产仍待真实验证码正向提交、边缘与源站限流验收及原生名册衔接。[发布与验收手册](../../../docs/runbooks/public-entry-protection.md)
