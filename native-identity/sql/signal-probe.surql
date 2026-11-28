-- 062 提供此只读函数。当前 fork 查询不存在的表也可能返回空数组。
RETURN [fn::signal_member_active($auth.id)];
