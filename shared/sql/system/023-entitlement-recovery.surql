-- LCA13 运营解释、临时授权与交付修复。
-- 只新增结构：撤销以追加记录表达（content_grant 行不可变，UPDATE/DELETE 被表事件拒绝），
-- 不改写既有生产数据；权益解析在读取时排除已撤销来源。

DEFINE TABLE IF NOT EXISTS content_grant_revocation SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE content_grant_revocation TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS grant ON TABLE content_grant_revocation TYPE record<content_grant>;
DEFINE FIELD IF NOT EXISTS reason ON TABLE content_grant_revocation TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 500;
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE content_grant_revocation TYPE string;
DEFINE FIELD IF NOT EXISTS idempotency_key ON TABLE content_grant_revocation TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE content_grant_revocation TYPE datetime DEFAULT time::now();
-- 每个赠送最多一次撤销：同一 grant 的重复撤销请求幂等返回既有记录。
DEFINE INDEX IF NOT EXISTS content_grant_revocation_grant_unique ON TABLE content_grant_revocation COLUMNS grant UNIQUE;
DEFINE INDEX IF NOT EXISTS content_grant_revocation_idempotency ON TABLE content_grant_revocation COLUMNS workspace, idempotency_key UNIQUE;
DEFINE EVENT IF NOT EXISTS content_grant_revocation_immutable ON TABLE content_grant_revocation
  WHEN $event = "UPDATE" OR $event = "DELETE" THEN {
    THROW "immutable-control-plane-record:content_grant_revocation";
  };
