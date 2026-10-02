-- 只追加结构；不回填旧订阅/额度桶。正常商业转换事务记录精确旧来源。
DEFINE FIELD IF NOT EXISTS converted_trial_source ON quota_subscription_item TYPE option<record<quota_subscription>>;
DEFINE FIELD IF NOT EXISTS converted_trial_at ON quota_subscription_item TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS converted_trial_event ON quota_subscription_item TYPE option<string>;
DEFINE EVENT OVERWRITE ai_trial_conversion_immutable ON quota_subscription_item
  WHEN $event = "UPDATE" AND $before.converted_trial_source != NONE
  THEN {
    IF $after.converted_trial_source != $before.converted_trial_source
      OR $after.converted_trial_at != $before.converted_trial_at
      OR $after.converted_trial_event != $before.converted_trial_event {
      THROW "trial conversion identity is immutable";
    };
  };
