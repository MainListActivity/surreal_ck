-- 手工执行前，把 ws_replace_me 替换为目标工作区的 database 名。
-- plan 可改为 resource_quota_plan:plus / :pro / :max。
USE NS main DB ws_replace_me;

UPDATE ONLY workspace_resource_quota:current SET
  plan = resource_quota_plan:plus
RETURN AFTER;
