# 062真实fork验证结果

2026-11-10，本地loopback memory，固定fork `3.3.0-native-quota.1+sha.f30704bce914`。
二进制SHA256：`6f6bcc72f8c23848295ed32d6a265f5bf0baad11e7be446294a5ade1b06a84f2`。
062 SQL SHA256：`f315c68927897ecbecbbf6027b5611d0333be68a671500a783d687360478bbec`。

最终命令：`SURREAL_TEST_BINARY=<固定fork路径> bun native-signaling/tests/fork-rules.ts`。
最终输出：`PASS 32 checks; waiting real 121s for expiry`，随后`PASS 36 real-fork checks`，exit 0。

本轮加载061和062；创建两个独立database及最小成员fixture，使用真实RECORD SIGNIN会话。root仅建schema、fixture并模拟控制面撤销，没有用root执行业务创建/接受/答复。测试未用生产JWT或生产账号，也未探测旧schema漏洞或DDL升级路径。

覆盖：合法邀请/接受/答复/结束；服务端hash；同sender立即重发拒绝；八路并发创建只有一个成功；第三方冒名、读取、跨db同名成员读取拒绝；未接受answer、发送者接受、offer作为answer、重复answer、终态复活、DELETE拒绝；workspace/sender/recipient/nonce/generation/offer/hash修改拒绝；延长expires_at请求保留原期限；超48KiB、非ASCII、错误hash、非JSON、非成员接收者拒绝；双方之一停用后旧会话读/答复拒绝；真实121秒后不可读/接受；相同nonce/generation在过期后换新ID重放失败；新随机绑定在冷却后成功。

还运行：官方formatter write/check、固定fork CLI validate、git diff --check，均通过。没有整仓安装或Rust大型编译；临时依赖链接已删除。初轮仅062的27检查通过，最终36检查才包含061联合加载、JSON类型验证及扩展不可变字段验证。

明确未覆盖：生产JWKS/scope exchange；TLS/WSS；LIVE交付撤销；持久存储/重启/多节点；长时DoS；历史SDP清理；主客户端接线；120秒过期后的数据库end（当前fail-closed，不支持）；主客户端production availability未变。

## 独立完整模板集成复验

使用同一固定 fork，设置 `SURREAL_FULL_TEMPLATE=1`，先完整加载001–062到两个隔离database，再创建唯一email/subject的真人fixture，以真实RECORD会话执行同一36项行为测试。结果：36/36通过，exit 0，包含实际等待121秒。日志为 `full-template-regression.log`。这补齐历史模板组合验证，不扩展为生产JWKS、WSS或主客户端已接线。

同轮061真实JWT正反例和模板加载测试合计51项通过、342断言。初轮发现模板单测仍假定版本60和4个JWKS占位符，修正为62和6后复跑通过；没有放松安全断言。全仓typecheck/lint未运行，依赖环境仍不完整。
