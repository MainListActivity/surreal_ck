-- v2：为真实发布适配器补齐公开 ID、请求快照、状态修订和可变发布结果。
-- 所有语句均可重复执行，旧的 v1 安装可安全增量升级。

-- v1 把 publication_request 当成不可变事件，但发布完成需要写回 pending 状态；
-- 真正的不可变历史由 publication_event / audit_event 保证。
REMOVE EVENT IF EXISTS publication_request_immutable ON TABLE publication_request;

DEFINE FIELD IF NOT EXISTS publication_revision ON TABLE content_item TYPE int
  DEFAULT 1
  ASSERT $value > 0;

DEFINE FIELD IF NOT EXISTS candidates ON TABLE content_citation TYPE array<object> FLEXIBLE;

DEFINE FIELD IF NOT EXISTS public_id ON TABLE content_version TYPE string;
DEFINE INDEX IF NOT EXISTS content_version_public_id_unique ON TABLE content_version COLUMNS public_id
  UNIQUE;

DEFINE FIELD IF NOT EXISTS public_id ON TABLE ingestion_batch TYPE string;
DEFINE FIELD IF NOT EXISTS request ON TABLE ingestion_batch TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS validation_revision ON TABLE ingestion_batch TYPE int
  DEFAULT 1
  ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS issues ON TABLE ingestion_entry TYPE array<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS publication_status ON TABLE ingestion_entry TYPE option<string>;
DEFINE INDEX IF NOT EXISTS ingestion_batch_public_id_unique ON TABLE ingestion_batch COLUMNS public_id
  UNIQUE;

DEFINE FIELD IF NOT EXISTS public_id ON TABLE publication_request TYPE string;
DEFINE FIELD IF NOT EXISTS response ON TABLE publication_request TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE publication_request TYPE datetime
  VALUE time::now();
DEFINE INDEX IF NOT EXISTS publication_request_public_id_unique ON TABLE publication_request COLUMNS public_id
  UNIQUE;
