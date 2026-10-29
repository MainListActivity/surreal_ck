-- funnel_event：漏斗埋点的每工作区原始事件（方案 A，任务 d70c3748 第 4 版）。
--
-- 追加式：只 CREATE，不更新。内容由 DEFINE EVENT 在写操作会话上下文里写入——
-- 前端零埋点，同 activity_event 先例（010:6-12、HR-15）。行只含事件名、日期与
-- 主体 record id，不含记录内容、文件名、金额、邮箱或 IP（禁止采集清单见方案 §4）。
--
-- 事件与触发点：
-- - first_login：真人 user 首次建立（001-access.surql 的 IF !$existing 分支创建）。
-- - template_created：workbook CREATE 且 template != NONE（前端 createFromTemplate 直连写入）。
-- - import_succeeded：import_batch 进入成功终态（completed/partial_failure）且该批次
--   至少一行 import_batch_row.status = "success"（activation-outcomes.ts:121-134 口径）。
-- - first_success：首个 import_succeeded（全库仅一条，跨天幂等）。
-- - ai_proposal_adopted：chat_write_fence 消费为 consumed + consumed_by = "write-confirmed"
--   （write-fence.ts:138、:225；写回本身产生 record.write，不产生 ai.write）。
--
-- 每行写入前先查重（同 event + subject 已存在则跳过），避免重复触发或唯一索引冲突
-- 回滚业务写入。跨 workspace 汇总由服务端聚合任务按日重算写入 _system.funnel_event_count，
-- 不在本库内跨库写入。

DEFINE TABLE IF NOT EXISTS funnel_event SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE,
    FOR create WHERE $auth != NONE,
    FOR update, delete WHERE $auth.is_admin = true;
DEFINE FIELD IF NOT EXISTS event ON TABLE funnel_event TYPE string
  ASSERT $value INSIDE [
    "first_login", "template_created", "import_succeeded", "first_success", "ai_proposal_adopted"
  ];
-- day：UTC 日期（time::now() 写入时刻的 %Y-%m-%d）。聚合任务按日重算，时区口径
-- 与 activation-outcomes 的浏览器本地日存在差异，待首次价值口径对齐时统一。
DEFINE FIELD IF NOT EXISTS day ON TABLE funnel_event TYPE string
  ASSERT $value != NONE AND string::len($value) = 10;
-- subject：触发主体 record id（user / workbook / import_batch / chat_write_fence 行）。
DEFINE FIELD IF NOT EXISTS subject ON TABLE funnel_event TYPE option<record>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE funnel_event TYPE datetime VALUE time::now() READONLY;
-- 主体级幂等：同一 event + subject 只落一行（事件内先查重，索引用作兜底）。
DEFINE INDEX IF NOT EXISTS funnel_event_subject_unique ON TABLE funnel_event COLUMNS event, subject UNIQUE;

DEFINE EVENT OVERWRITE user_first_login_funnel ON TABLE user
  WHEN $event = "CREATE" AND $after.kind = "human"
  THEN {
    LET $dup = (SELECT VALUE id FROM funnel_event WHERE event = "first_login" AND subject = $after.id LIMIT 1);
    IF !$dup {
      CREATE funnel_event CONTENT {
        event: "first_login",
        day: time::format(time::now(), "%Y-%m-%d"),
        subject: $after.id,
      };
    };
  };

DEFINE EVENT OVERWRITE workbook_template_funnel ON TABLE workbook
  WHEN $event = "CREATE" AND $after.template != NONE
  THEN {
    LET $dup = (SELECT VALUE id FROM funnel_event WHERE event = "template_created" AND subject = $after.id LIMIT 1);
    IF !$dup {
      CREATE funnel_event CONTENT {
        event: "template_created",
        day: time::format(time::now(), "%Y-%m-%d"),
        subject: $after.id,
      };
    };
  };

DEFINE EVENT OVERWRITE import_batch_funnel ON TABLE import_batch
  WHEN $event = "UPDATE"
    AND $after.status INSIDE ["completed", "partial_failure"]
    AND $before.status NOT IN ["completed", "partial_failure"]
  THEN {
    LET $hasSuccess = (SELECT VALUE id FROM import_batch_row WHERE batch = $after.id AND status = "success" LIMIT 1);
    IF $hasSuccess {
      LET $dup = (SELECT VALUE id FROM funnel_event WHERE event = "import_succeeded" AND subject = $after.id LIMIT 1);
      IF !$dup {
        CREATE funnel_event CONTENT {
          event: "import_succeeded",
          day: time::format(time::now(), "%Y-%m-%d"),
          subject: $after.id,
        };
      };
      LET $prevFirst = (SELECT VALUE id FROM funnel_event WHERE event = "first_success" LIMIT 1);
      IF !$prevFirst {
        CREATE funnel_event CONTENT {
          event: "first_success",
          day: time::format(time::now(), "%Y-%m-%d"),
          subject: $after.id,
        };
      };
    };
  };

DEFINE EVENT OVERWRITE chat_write_fence_funnel ON TABLE chat_write_fence
  WHEN $event = "UPDATE"
    AND $after.status = "consumed"
    AND $after.consumed_by = "write-confirmed"
    AND ($before.status != "consumed" OR $before.consumed_by != "write-confirmed")
  THEN {
    LET $dup = (SELECT VALUE id FROM funnel_event WHERE event = "ai_proposal_adopted" AND subject = $after.id LIMIT 1);
    IF !$dup {
      CREATE funnel_event CONTENT {
        event: "ai_proposal_adopted",
        day: time::format(time::now(), "%Y-%m-%d"),
        subject: $after.id,
      };
    };
  };
