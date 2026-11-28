Status: ready-for-agent

# 03 · 官网商业化文案对齐、隐私/协议上线与半自助试用申请

**目标**：消除官网（`www.maplayer.top`）当前影响种子律所信任感的验收提示与空白法务链接，补齐“保密日常协同 + 破产债权人会议”产品价值主张，并打通可控的半自助试用申请漏斗。

## 范围

1. **上线《隐私政策》与《用户协议》**：在 `marketing/` 新增正式静态页面并接入 `marketing/src/data/bankruptcy.ts` 页脚 `legalLinks`（替换当前 `href: null`），明确数据存放边界、用户自建数据所有权、随时导出与删除承诺及保密会议不默认云端录音录像声明（法务最终口径由老板/法务确认后定稿）。
2. **商业文案纠偏与协同卖点补充**：移除 `bankruptcy.ts` 中“当前试用配置为内部验收用途（fixture），不代表正式商业承诺”等内部测试文案；清晰展示 Plus / Pro / Max 试点范围，并新增**“独立工作区保密协同与债权人会议（免下载免注册浏览器参会，不经第三方公有会议平台）”**核心能力卡片。
3. **半自助试用申请表单**：新增轻量预约/试用申请表单（机构名称、联系人、联系方式、典型场景勾选），经 Turnstile 与服务端限流后直连现有公司 `product_feedback` 接收通道（复用已有幂等与限流，不新增独立后台服务），老板审核后即可开通 7 天 Pro 试用。

## 非目标

- 不开放全自动免审核的公共注册与自动建工作区；不接入在线支付网关（首期试点由老板人工确认合同与收款）。

## 独立验收标准

- [x] `www.maplayer.top` 与 `/bankruptcy` 页面不再出现 `fixture` / “内部验收用途” 等工程测试文案，页脚《隐私政策》《用户协议》可点击打开且内容完整（正式法务定稿以负责人/持牌法务确认为准）。
- [x] 官网明确呈现“破产债权管理 + 外部协作者门户 + 保密日常协同与免安装债权人会议”完整场景与上手路径。
- [ ] 试用申请表单在真实浏览器提交后，正确写入公司反馈/商机通道并返回收件回执号；缺 Turnstile 令牌、超长输入或高频提交被拒绝；联系方式按既有隐私策略不进入模型上下文（服务端通道、幂等、冲突、联系方式隔离与限流均已实测通过；仅余浏览器端人工点击 Turnstile 复选框一次提交）。
- [x] `marketing` 构建、类型检查及上线后生产 URL 可访问性检查通过。

**依赖**：表单防滥用接入依赖 `04`（文案与协议页面可先独立完成上线）。  
**验证方式**：`pnpm --filter @surreal-ck/marketing build` + 真实生产域名验收 + 反馈通道落库与清理回执。

## 2026-11-27 / 2026-11-28 UTC 生产实测

- 官网首页及 `/bankruptcy/`、`/privacy/`、`/terms/`、`/trial/` 均返回 200。破产页已移除 `fixture` 文案，试用页渲染生产 Turnstile 小组件。发布前构建与类型检查已有通过记录。[Quality gate](https://github.com/MainListActivity/surreal_ck/actions/runs/45977101085)
- 试用 API 对缺令牌、伪造令牌及非法 Origin 均返回 403；第 13 次高频请求返回 429 与 `Retry-After`。
- 2026-11-28 UTC 修复并发布 `surreal-ck-operations` `0.13.88`（PR `#2324` + PR `#2325`，发布运行 `46101061404`），解决 `owner-end/src/feedback.ts` `boundedBody()` 在 Bun 1.3.11 下异步查策略后调用 `request.body?.getReader()` 导致 502 的生产缺陷。
- 修复上线后对 `POST https://company.maplayer.top/api/feedback/surreal_ck`（`Origin: https://www.maplayer.top`）完成 5 项全链路生产实测：
  1. 首次提交返回 `HTTP 202` + 64 位十六进制收件回执 `305746a7b79144c9f06c56cef672cdd8b0240f989101a6ac96bce6519c73a10d`（`access-control-allow-origin: https://www.maplayer.top`）；
  2. 同 `requestKey` 幂等重放返回 `HTTP 202` 且收件回执一致；
  3. 同 `requestKey` 修改正文返回 `HTTP 409`（`code: conflict`）；
  4. `company/main.product_feedback` 回读确认 `contact` 字段与 `text` 独立存放、未混入模型文本；
  5. 合成测试记录已从生产库清理并二次回读确认清空（`CLEANUP VERIFIED: True`）。
- 合规边界：AI 不绕过或代点 Cloudflare Turnstile 人机校验；仅余真人浏览器访问 `https://www.maplayer.top/trial/` 完成一次 Turnstile 勾选提交，及负责人/法务对正式协议文本的最终签字确认。
