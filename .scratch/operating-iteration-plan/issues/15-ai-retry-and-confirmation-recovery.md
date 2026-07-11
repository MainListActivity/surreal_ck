Status: ready-for-agent
Label: ready-for-agent

# OIP-15 — AI 失败重试与确认卡恢复

## Parent

`.scratch/operating-iteration-plan/PRD.md`

## What to build

统一 AI 未配置、请求超时、stream 中断、tool 写入失败和 workflow resume 失败的用户体验。失败信息翻译为中文可执行提示；读取任务可重发原请求，写任务失败后保留原确认卡和用户已确认参数，允许安全地再次提交而不制造重复写入。

## Acceptance criteria

- [ ] 未配置模型服务时显示“当前环境未配置 AI 服务”，不展示 provider 堆栈。
- [ ] stream 超时或中断后退出 loading，保留用户消息并提供重试。
- [ ] 写入失败时确认卡不消失，失败原因和再次提交入口同时可见。
- [ ] resume 失败可以再次提交同一决定，并通过既有运行标识避免重复执行成功步骤。
- [ ] 权限、校验、网络、服务未配置和未知错误拥有可区分的中文文案。
- [ ] 测试覆盖断流、超时、写失败后重试、resume 重试及幂等保护。

## Blocked by

None - can start immediately
