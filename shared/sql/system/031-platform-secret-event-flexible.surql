-- 修正 030 的结构缺陷：platform_secret_event.detail 声明为 option<object>
-- 但 SCHEMAFULL 下 object 为严格模式——未逐字段声明的子键（如
-- detail.verifiedAgainst）会被引擎拒绝，导致轮换审计事件写入失败并使
-- rotate 端点 500。审计 detail 是开放元数据，应为 FLEXIBLE object。
-- 结构级修正，不改写数据。

DEFINE FIELD OVERWRITE detail ON platform_secret_event TYPE option<object> FLEXIBLE;
