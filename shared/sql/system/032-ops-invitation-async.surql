-- G2 邀请开通异步化：邀请链路（IdP 建用户 → workspace 供应 saga → 权益 → 额度）
-- 实测超过单次 HTTP 预算，客户端断连会使请求线程中止、行永久卡 processing。
-- 改为：POST 领取任务后在竞速窗内同步返回；超窗任务继续跑，调用方轮询 GET，
-- 完成后经 collect-delivery 一次性收取激活链接；超龄 processing 行支持同参续跑。
--
-- 凭证约定更新（替代 029 的「永不入库」）：activation_url 在签发后暂存本行，
-- 首次 collect 即从库中清除（activation_url = NONE）——在库生命周期反而更短。
DEFINE FIELD IF NOT EXISTS processing_since ON ops_invitation TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS activation_url ON ops_invitation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS activation_url_delivered_at ON ops_invitation TYPE option<datetime>;
