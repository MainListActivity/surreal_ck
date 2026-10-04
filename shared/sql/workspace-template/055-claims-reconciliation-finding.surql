-- 11.1 债权对账：差异结论 reconciliation_finding 与补充往返 claim_supplement
-- （只新增结构）。契约见 docs/claims-reconciliation/data-model.md §6。
-- finding 每债权人一行（identity_code 唯一）：管理人对该债权人差异的结论；
-- supplement 为追加式往返日志：管理人补充要求 / 债权人回复，
-- 记录会话只读+追加，不可改行删行，全部业务字段 READONLY。
-- admin 会话（RL=Owner）绕过 PERMISSIONS；债权人不直连、经 root 门户读写
-- 本人申报相关的 supplement 行；债权人对 finding 无任何权限。

DEFINE TABLE IF NOT EXISTS reconciliation_finding SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create, update
      WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR delete
      WHERE false;

DEFINE FIELD IF NOT EXISTS identity_code ON TABLE reconciliation_finding
  TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
-- 四类差异枚举集合，由计算侧给出；元素合法性在字段断言与实现侧双重约束。
DEFINE FIELD IF NOT EXISTS categories ON TABLE reconciliation_finding
  TYPE array<string>
  ASSERT array::len($value) <= 4
    AND $value ALLINSIDE ["amount_mismatch", "interest_mismatch", "missing_evidence", "identity_mismatch"];
DEFINE FIELD IF NOT EXISTS manager_note ON TABLE reconciliation_finding
  TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 4096;
DEFINE FIELD IF NOT EXISTS state ON TABLE reconciliation_finding
  TYPE string
  ASSERT $value INSIDE ["open", "waiting_creditor", "resolved"];
DEFINE FIELD IF NOT EXISTS linked_submission_id ON TABLE reconciliation_finding
  TYPE option<record<claim_submission>>;
DEFINE FIELD IF NOT EXISTS updated_by ON TABLE reconciliation_finding
  TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 256;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE reconciliation_finding
  TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE reconciliation_finding
  TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS reconciliation_finding_identity_unique
  ON TABLE reconciliation_finding COLUMNS identity_code UNIQUE;

DEFINE TABLE IF NOT EXISTS claim_supplement SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create
      WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR update, delete
      WHERE false;

DEFINE FIELD IF NOT EXISTS submission_id ON TABLE claim_supplement
  TYPE record<claim_submission> READONLY;
DEFINE FIELD IF NOT EXISTS direction ON TABLE claim_supplement
  TYPE string READONLY
  ASSERT $value INSIDE ["manager_request", "creditor_reply"];
DEFINE FIELD IF NOT EXISTS body ON TABLE claim_supplement
  TYPE string READONLY
  ASSERT string::len($value) > 0 AND string::len($value) <= 4000;
DEFINE FIELD IF NOT EXISTS actor ON TABLE claim_supplement
  TYPE string READONLY
  ASSERT string::len($value) > 0 AND string::len($value) <= 256;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE claim_supplement
  TYPE datetime READONLY;
DEFINE INDEX IF NOT EXISTS claim_supplement_submission
  ON TABLE claim_supplement COLUMNS submission_id, created_at;
