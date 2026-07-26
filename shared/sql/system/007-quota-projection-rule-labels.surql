-- Compiled projection selectors use the native INFO/operation DTO shape,
-- unlike product rules whose exact/regex payload shares one `value` field.
REMOVE FIELD IF EXISTS rules.*.selector.value ON TABLE quota_policy_projection;
REMOVE FIELD IF EXISTS rules.*.rule_key ON TABLE quota_policy_projection;
DEFINE FIELD IF NOT EXISTS rules.*.selector.table ON TABLE quota_policy_projection TYPE option<string>;
DEFINE FIELD IF NOT EXISTS rules.*.selector.pattern ON TABLE quota_policy_projection TYPE option<string>;

-- Customer-facing labels are immutable projection metadata. They map native
-- rule ids back to stable product rule keys without affecting policy digest.

DEFINE FIELD IF NOT EXISTS rule_labels ON TABLE quota_policy_projection TYPE array<object>;
DEFINE FIELD IF NOT EXISTS rule_labels.*.rule_id ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS rule_labels.*.rule_key ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS rule_labels.*.resource ON TABLE quota_policy_projection TYPE string
  ASSERT $value INSIDE ["table", "field", "record"];
DEFINE FIELD IF NOT EXISTS rule_labels.*.customer_label ON TABLE quota_policy_projection TYPE string;
DEFINE FIELD IF NOT EXISTS rule_labels.*.customer_description ON TABLE quota_policy_projection TYPE option<string>;
