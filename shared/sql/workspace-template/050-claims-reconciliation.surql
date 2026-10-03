-- 11.1 债权对账：债权人名册与企业账面（只新增结构）。
-- 管理人经浏览器直连读写；债权人无数据库账号，不能读这些表。
-- 物理表名与 docs/claims-reconciliation/data-model.md 对齐。

DEFINE TABLE IF NOT EXISTS creditor_roster SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create, update, delete
      WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE;
DEFINE FIELD IF NOT EXISTS subject_type ON TABLE creditor_roster TYPE string
  ASSERT $value INSIDE ["enterprise", "person"];
DEFINE FIELD IF NOT EXISTS name ON TABLE creditor_roster TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 512;
DEFINE FIELD IF NOT EXISTS identity_code ON TABLE creditor_roster TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS contact_name ON TABLE creditor_roster TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 256;
DEFINE FIELD IF NOT EXISTS contact_channel ON TABLE creditor_roster TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 256;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE creditor_roster TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE creditor_roster TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS creditor_roster_identity_code_unique ON TABLE creditor_roster COLUMNS identity_code UNIQUE;

DEFINE TABLE IF NOT EXISTS enterprise_ledger SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select, create, update, delete
      WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE;
DEFINE FIELD IF NOT EXISTS identity_code ON TABLE enterprise_ledger TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS principal ON TABLE enterprise_ledger TYPE number
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS book_interest ON TABLE enterprise_ledger TYPE number
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS contract_ref ON TABLE enterprise_ledger TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 512;
DEFINE FIELD IF NOT EXISTS note ON TABLE enterprise_ledger TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 2048;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE enterprise_ledger TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE enterprise_ledger TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS enterprise_ledger_identity_code ON TABLE enterprise_ledger COLUMNS identity_code;
