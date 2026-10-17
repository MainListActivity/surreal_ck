-- 提案确认写栅栏（PG-1 生产实测阻断缺陷）：
--
-- 背景：AI 提案卡的确认写过去是「浏览器直连无约束写 + resume」，写栅栏只是卡片实例的
-- 内存标志（writeCommitted）。run 终态 success 后，另一个标签页恢复出的同 run 暂停卡二次
-- 确认时内存标志看不见，于是真实写入业务行。本迁移把「哪个 run 的哪次 suspend 已被消费」
-- 落到服务端持久行，让确认写与消费在同一事务内原子判定（exactly-once）。
--
-- 行语义：每个待确认的 suspend 路径一行，状态机 pending → consumed → resumed：
-- - pending：suspend 待决策。提案确认写在同事务内把它置 consumed（写已落库、
--   resume 待送达）；任何终局决策的 resume 把它置 resumed（含 write-confirmed 的
--   收尾 resume，以及 write-rejected / 候选选择等非写决策——栅栏随之关闭）。
-- - consumed → resumed：仅 write-confirmed 的首次 resume 允许这一转移，保证
--   「写成功 + resume」的一次确认流完整；其余决策或重放一律具名幂等拒绝。
-- 后续任何实例（恢复卡 / 第二标签页 / 回放流）的确认与重复 resume 都在事务内
-- 看到非 pending 态，具名幂等拒绝、零写入、零状态推进。
--
-- 纯增量：只新建一张表与两个索引，不改写、不删除任何已有数据；PERMISSIONS 与
-- workflow_run / chat_delivery 同口径（归属走 fn::current_user()，DELETE 一律拒绝，
-- 消费痕迹只增不减）。写权限仍是调用者身份边界内的 DML，PERMISSIONS 语义不变。

DEFINE TABLE IF NOT EXISTS chat_write_fence SCHEMAFULL
  PERMISSIONS
    FOR select, create, update WHERE owner_user = fn::current_user()
      AND (SELECT VALUE disabled_at FROM ONLY fn::current_user()) = NONE,
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS owner_user ON chat_write_fence TYPE record<user> DEFAULT fn::current_user() READONLY;
-- 等待确认的 workflow run（routerWorkflow）。
DEFINE FIELD IF NOT EXISTS run_id ON chat_write_fence TYPE string;
-- suspend 载荷种类：await-write-confirm / ambiguous / resource-candidates /
-- manual-research / authorization_changed。
DEFINE FIELD IF NOT EXISTS suspend_kind ON chat_write_fence TYPE string
  ASSERT $value INSIDE ["await-write-confirm", "ambiguous", "resource-candidates", "manual-research", "authorization_changed"];
-- suspend 路径键：run 内区分「同一 run 的第几次暂停」。由 Mastra suspendedPaths
-- （stepId → foreach index）与 plan cursor 派生，同一次 suspend 重放恒等。
DEFINE FIELD IF NOT EXISTS suspend_path ON chat_write_fence TYPE string;
-- 结构化 suspend 载荷（仅供定位与诊断，不含明文 prompt 或凭证）。
DEFINE FIELD IF NOT EXISTS suspend_payload ON chat_write_fence TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS status ON chat_write_fence TYPE string
  ASSERT $value INSIDE ["pending", "consumed", "resumed", "abandoned"];
DEFINE FIELD IF NOT EXISTS consumed_at ON chat_write_fence TYPE option<datetime>;
-- 消费方：write-confirmed / write-rejected / 候选选择等 resume 决策 kind 的稳定串。
DEFINE FIELD IF NOT EXISTS consumed_by ON chat_write_fence TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON chat_write_fence TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON chat_write_fence TYPE datetime VALUE time::now();
-- exactly-once 的关键约束：同一 run 的同一 suspend 路径只可能存在一行。
DEFINE INDEX IF NOT EXISTS chat_write_fence_suspend_unique ON chat_write_fence COLUMNS run_id, suspend_path UNIQUE;
DEFINE INDEX IF NOT EXISTS chat_write_fence_owner_status ON chat_write_fence COLUMNS owner_user, status;
