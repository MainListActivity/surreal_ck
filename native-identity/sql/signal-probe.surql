-- 只读结构探测：062 未应用时 native_signal 不存在（NotFound）；存在时恒为空。
-- 不能用 `WHERE false`：fork 会在找表之前短路，表缺失也返回空。
SELECT VALUE id FROM native_signal WHERE recipient = $auth.id AND status = 'probe' LIMIT 1;
