# 工作区认证信令协议预备层

**当前未启用企业身份信令。** `availability()` 永远返回
`BlockedPendingDatabaseRulesAndForkVerification`。现增加仅接受身份层真实 `SignalConnection` 的实验 `Signaling` actor；客户端有默认关闭的
`experimental-enterprise-signaling` 后台聊天桥，实验成员/邀请确认/文字聊天UI已接线并通过状态与Headless测试；本地真实RECORD信令到真实UDP聊天、撤销及积压消息的三项后台端到端通过。生产登录和实际双端GUI仍待验证。不可据此宣称成员认证的端到端通话已经完成。
现有手工 SDP 路径仍然是手工测试模式，不能附加企业成员认证标记。

## 已实现并可本地验证

- 不可公共构造、不可反序列化、不可 Clone 的 `AuthenticatedOffer` / `AuthenticatedAnswer`
  类型；Debug 不打印 SDP。只能在已认证数据库操作和完整绑定校验成功后构造。
- 测试专用协议模型：随机 256 位邀请 ID / nonce / 连接 generation；工作区、发送成员、
  接收成员、邀请 ID、nonce、原始 SDP SHA-256、到期时间、generation 全绑定。
- SDP 限制 48 KiB ASCII，区分 offer/answer，要求 SDP 基础结构、ICE 和 DTLS fingerprint。
  此检查只是信令输入检查，不替代 WebRTC 引擎对 SDP 与指纹的解析/协商。
- 邀请 TTL 120 秒；明确接受具体邀请后才能写 answer。拒绝不可改成接受，answer 不可替换，
  结束不可复活。邀请 TTL 只约束协商；已建立会话超过 TTL 仍允许双方结束。
- 模型限制同一发送者每 10 秒一次邀请；客户端每 3 秒最多一次轮询；客户端最多一个活动邀请，
  answer 仅消费一次，重置或换工作区后迟到消息不能覆盖新邀请。
- 非成员、移除成员、第三人、其他工作区同名成员、错误发送者、hash/nonce/ID/generation
  变化、过期、拒绝/结束重放、未接受即 answer 等负例。

Rust crate中的数据库对象/认证调用者均为 `#[cfg(test)]` 模型；新独立数据库测试不属于该模型。模型成员集合是测试夹具，不是身份权威。
它不证明真实 SurrealDB 的认证、事务并发、PERMISSIONS、READONLY、VALUE 或唯一索引行为。

## 本地数据库候选（2026-11-10更新）

SurrealQL技能现已真实转移并读取。新增061成员身份保护与062低流量信令候选，
旧001–060迁移未改。062在固定用户fork的loopback memory实例上以普通RECORD身份验证，
涵盖服务端约束和并发；不是仅模型或schema存在性证明。
详见[数据库合同](DATABASE-CONTRACT.md)及[测试结果](FORK-RULES-RESULT.md)。

仍未实现生产WSS适配器、客户端桥、服务器SDP清理/防重放墓碑分离、生产完整身份链与持久存储验证。
没有登录真实账号、注册OAuth、创建凭据、更新线上schema或部署。availability仍无条件阻断。
候选规则在过期后拒绝所有数据库更新（包括end），客户端仍应本地结束媒体和清理状态；
这比上方Rust模型的会话结束语义更严格，接线前必须决定是否增加独立终止寿命。

## 待实现的固定接口与边界（设计，不是现有功能）

后台 actor 持有 `Arc<Session>`，UI 只拿真实成员目录和非敏感邀请摘要。
待完成数据库规则并验证后，连接必须重新读取真实工作区列表并核对当前 token scope，
只向预配置 WSS `/rpc` 端点发送当前用户 token。连接建立时走 use → authenticate；
之后仅执行固定的信令操作，不向 UI 暴露 token、通用执行函数或可伪造的“已认证”对象。

拟定操作：

- invite：用户显式选择一个已激活真人成员后，创建不可替换的邀请。发送者由数据库认证身份派生，
  不接受 payload 自报 sender。客户端只提供目标成员 record ID、随机 ID/nonce 与 offer。
- inbox：只列出当前工作区当前用户涉及、仍有效且未处理的邀请摘要；有界返回与请求节流。
- accept/reject：重新读取具体邀请并原子创建一次决定；不得仅信任 UI 缓存的摘要。
  accept 才返回 opaque `AuthenticatedOffer`，该类型保留完整绑定供随后 answer 校验。
- answer：只允许已接受邀请的接收者写一次 SDP；绑定原始 offer hash 与单次邀请，不能替换。
- poll-answer：发起者按本次完整绑定校验并仅消费一次 `AuthenticatedAnswer`。
- end：任一参与者可结束当前完整绑定的会话；不能用于重开旧邀请。

未来 schema 必须是 `shared/sql/workspace-template/` 新增版本，不回写旧迁移：

- 工作区物理 database 隔离；当前 active 真人与对端 active 真人资格在数据库检查。
- 邀请不可变、决定不可变、answer 不可变、结束单调；记录与唯一约束构成事务级防重放，
  不能用客户端时间戳或“先 SELECT 再写入”的非原子检查替代。
- 强制短 TTL、大小与每发送成员的限频槽唯一约束；客户端节流不是服务端防滥用保障。
- 明确禁止普通参与者删除/覆盖历史决定后重放；过期 SDP 的服务器清理与防重放墓碑独立设计，
  不无限保留 ICE 地址/SDP。清理的维护身份、保留期限与部署需单独审查。
- 错误消息不返回原始数据库 response/SQL/token；媒体、聊天正文、文件块、TURN secret
  均不得进入信令记录。只传低流量 SDP、成员 record ID、状态和随机绑定值。

**信任边界：** workspace `admin` JWT access 的 Owner 身份可以绕过普通表 PERMISSIONS 并修改
schema。数据库管理员属于可信管理域；此设计不宣称防御恶意 workspace Owner、root、IdP
或数据库服务端篡改。普通成员 RECORD access 的隔离与不可冒名必须由真实 fork 负例证明。
若产品要求抵御恶意数据库管理员，还需要独立端到端身份密钥验证协议，本模块不提供该能力。

## 最小 identity 窄 API（暂不新增）

后续可以由 native-identity 内部提供认证 WSS 连接，验证 `Session`、当前 `Workspace`、配置端点，
只保留认证后的 socket，不导出 bearer token。信令 adapter 留在后台层，不能给 UI 增加执行任意
查询能力。当前 `Member.id` 与 `pending` 已够选择真实成员；绑定可用 workspace 内 user record，
不必把 OIDC subject 暴露给 UI。新增 API 前需与 identity owner 协调。

## 本地验证

在既有 Rust 环境执行：

```sh
cargo test --manifest-path native-signaling/Cargo.toml --offline -j 1
cargo clippy --manifest-path native-signaling/Cargo.toml --offline --all-targets -- -D warnings
```

测试仅覆盖 Rust 协议与状态模型；没有网络、真实数据库身份、真实成员账号、真实权限证明或设备访问。

## 既有表复用审查（只读源码）

没有找到同时具备真人双方 ACL、不可冒名、单次邀请/答复、短 TTL 与限频的现成对象。
不能通过固定 JSON-RPC 记录操作复用来解除 schema 门禁：

- `031-office-domain.surql:62-74` 的 office_message：author 绑定且 append-only，但所有已认证
  成员均可读，没有按 to 限制读取，也没有信令 TTL/决定约束。不得把 SDP 写入办公室历史消息。
- `041-office-request-resolution.surql:17-25` 的 user_notification：有收发两端读取和终态守卫，
  但创建仅允许 virtual 员工，不允许真人发起；没有短 TTL/信令限频。044 只变更 purpose 默认值。
- `048-chat-delivery.surql:2-16` 和 `058-chat-write-fence.surql:21-25`：仅 owner_user 授权，
  分别用于 AI 输出交付与提案写栅栏，不提供双方信令读取/回答资格。
- `005-mastra-runtime-storage.surql:37-54` 的 memory_message：owner/admin 读写删除的历史 AI 消息，
  不是两成员邀请，且没有短 TTL。observability 表虽有 expires_at，仍只有 owner/admin ACL，
  可编辑删除且是遥测用途，不能作为邀请状态机。
- `022-resource-library-current-user.surql:5-10` 的 research_session：owner/admin 管理的研究记录，
  无双方协商资格、单次回应与短 TTL。
- `shared/sql/system/029-ops-invitation.surql:8` 的 ops_invitation：控制面 PERMISSIONS NONE，
  用于运营开户/激活，不在 workspace 数据库，不允许普通客户端访问，不能借 root 复用。

审查没有查询线上数据库或修改任何既有 schema/API。

## 成员撤销的防护要求（2026-11-10）

隔离fork实测发现：对fixture真人记录设置disabled_at后，该participant仍能重新认证；其自身SDK更新能清除disabled_at并改写is_admin。该结果只涉及测试库与被测试schema，不证明生产部署一致、JWT access升级、DDL权限或reconciler已复活成员索引。进一步影响验证已停止，不以猜测填补。

在安全修复与回归验收前，维持`availability()`的无条件阻断。不得把“能列出workspace”或旧scope token当成撤销权威，不在UI展示企业已认证会话，也不借root代理完成业务请求。

原防护设计要求（061已提供本地候选修复，尚未部署）：

- 普通成员只能修改明确允许的个人资料字段；subject、kind、is_admin、disabled_at及成员角色只能由既有受权控制面管理，不能用前端隐藏字段代替引擎约束。
- 认证入口和每次成员敏感操作必须识别停用状态，既有会话与重新认证都纳入撤销语义；身份签名有效不等于成员仍有权限。
- 成员移除需保留权威撤销记录。reconciler只修复由权威控制面确认的合法状态，不能根据成员可改的用户记录自动恢复授权。
- 所有新增规则必须按仓库要求加载SurrealQL技能后追加版本化迁移，并在用户fork上验证。此次已新增061/062本地候选，未修改任何线上配置。
- 完成上述防护和对应正反例后，再评审精确subject控制面索引是否可作为低流量信令准入；不能先开放后补安全证明。

## 实验客户端接线（尚未交付）

`Signaling`持有身份层固定操作的WSS连接，发送/接受/答复按完整绑定核对；一次答复消费与3秒轮询限制；服务端剩余寿命转为保守单调期限，响应耗时不能延长寿命。客户端 `enterprise_peer` 将已验证offer/answer送入真实WebRTC Chat，连接错误先停止本地通道。仅支持当前实验直连聊天，不包含媒体轨或文件UI；不得称为已完成通话。宿主在退出登录、切换工作区和撤销时await唯一close任务，失效lease使排队UI事件不可用；区分本地关闭结果和远端end错误。feature默认关闭。

本轮adapter 11单元测试+2编译负例及严格clippy通过，client实验feature真实cargo check通过。实际固定fork的身份连接正反例通过；原样源码harness在cloud desktop完成真实UDP三项端到端，证据见native-client/validation/enterprise-signaling-e2e-r2。TLS/生产IdP/公网尚未验证，模型和fixture不构成生产准入。管理员Owner access并不等于RECORD真人身份；连接必须取得数据库实际身份，不接受UI声称的sender。没有生产配置变更。
