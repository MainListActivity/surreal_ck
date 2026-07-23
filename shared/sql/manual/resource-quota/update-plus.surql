-- 手工执行前，把 ws_replace_me 替换为目标工作区的 database 名。
-- 该工作区若绑定 Plus，修改后下一次创建数据表立即使用 2 张上限。
USE NS main DB ws_replace_me;

UPDATE ONLY resource_quota_plan:plus SET max_sheets = 2 RETURN AFTER;
