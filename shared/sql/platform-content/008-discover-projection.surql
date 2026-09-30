-- LCA11 公开发现投影：访客可理解覆盖范围的安全数据面。
-- 三表全部只允许服务端身份（publisher 写、projection sync 读）；
-- 浏览器/客户会话永远够不到这张表，公开面由后端 API 收敛后输出。

-- discover 条目：只复制许可允许公开的安全元数据（标题/类别/法域/日期/
-- 集合/来源标签），正文、摘要、向量一律不进投影。
-- 许可失效、到期或内容撤回时 listed=false，不再出现在公开面。
DEFINE TABLE IF NOT EXISTS content_discover_item SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
    FOR create, update WHERE $auth = content_publisher_identity:server
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS item ON TABLE content_discover_item TYPE record<content_item>;
DEFINE FIELD IF NOT EXISTS version ON TABLE content_discover_item TYPE record<content_version>;
DEFINE FIELD IF NOT EXISTS public_id ON TABLE content_discover_item TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON TABLE content_discover_item TYPE string
  ASSERT $value INSIDE ["legislation", "judicial_document"];
DEFINE FIELD IF NOT EXISTS title ON TABLE content_discover_item TYPE string;
DEFINE FIELD IF NOT EXISTS jurisdiction ON TABLE content_discover_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS published_on ON TABLE content_discover_item TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source_key ON TABLE content_discover_item TYPE string;
DEFINE FIELD IF NOT EXISTS source_label ON TABLE content_discover_item TYPE string;
DEFINE FIELD IF NOT EXISTS collections ON TABLE content_discover_item TYPE array<string>;
DEFINE FIELD IF NOT EXISTS collections.* ON TABLE content_discover_item TYPE string;
DEFINE FIELD IF NOT EXISTS listed ON TABLE content_discover_item TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS license_revision ON TABLE content_discover_item TYPE record<source_license_revision>;
DEFINE FIELD IF NOT EXISTS listed_at ON TABLE content_discover_item TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS delisted_at ON TABLE content_discover_item TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS rebuilt_at ON TABLE content_discover_item TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS content_discover_item_unique ON TABLE content_discover_item COLUMNS item UNIQUE;
DEFINE INDEX IF NOT EXISTS content_discover_item_listed ON TABLE content_discover_item COLUMNS listed, kind;

-- 策划示例：运营显式登记的固定示例与可公开引用标签；不由正文生成。
DEFINE TABLE IF NOT EXISTS content_discover_example SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
    FOR create, update WHERE $auth = content_publisher_identity:server
    FOR delete NONE;
DEFINE FIELD IF NOT EXISTS example_key ON TABLE content_discover_example TYPE string;
DEFINE FIELD IF NOT EXISTS title ON TABLE content_discover_example TYPE string;
DEFINE FIELD IF NOT EXISTS summary ON TABLE content_discover_example TYPE string;
DEFINE FIELD IF NOT EXISTS citation_labels ON TABLE content_discover_example TYPE array<string>;
DEFINE FIELD IF NOT EXISTS citation_labels.* ON TABLE content_discover_example TYPE string;
DEFINE FIELD IF NOT EXISTS position ON TABLE content_discover_example TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS status ON TABLE content_discover_example TYPE string DEFAULT "active"
  ASSERT $value INSIDE ["active", "retired"];
DEFINE FIELD IF NOT EXISTS created_by_subject ON TABLE content_discover_example TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE content_discover_example TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE content_discover_example TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS content_discover_example_unique ON TABLE content_discover_example COLUMNS example_key UNIQUE;

-- 发现面产品事件：只记录结构化范围 / 套餐 / 模块标识与转化状态。
-- 表本身没有自由文本字段，问题原文、案件事实、私有摘录无处可写。
DEFINE TABLE IF NOT EXISTS discover_event SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth IN [content_publisher_identity:server, content_projection_identity:server]
    FOR create WHERE $auth = content_publisher_identity:server
    FOR update, delete NONE;
DEFINE FIELD IF NOT EXISTS kind ON TABLE discover_event TYPE string
  ASSERT $value INSIDE [
    "overview_view", "question", "evaluate",
    "suggestion_shown", "suggestion_dismissed", "entry_click", "entry_request"
  ];
DEFINE FIELD IF NOT EXISTS subject_kind ON TABLE discover_event TYPE string
  ASSERT $value INSIDE ["visitor", "member"];
DEFINE FIELD IF NOT EXISTS scope_kinds ON TABLE discover_event TYPE array<string>;
DEFINE FIELD IF NOT EXISTS scope_kinds.* ON TABLE discover_event TYPE string;
DEFINE FIELD IF NOT EXISTS scope_collections ON TABLE discover_event TYPE array<string>;
DEFINE FIELD IF NOT EXISTS scope_collections.* ON TABLE discover_event TYPE string;
DEFINE FIELD IF NOT EXISTS plan_key ON TABLE discover_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS module_key ON TABLE discover_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS conversion ON TABLE discover_event TYPE string DEFAULT "none"
  ASSERT $value INSIDE ["none", "viewed", "clicked", "requested", "dismissed"];
DEFINE FIELD IF NOT EXISTS workspace ON TABLE discover_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE discover_event TYPE datetime VALUE time::now() READONLY;
