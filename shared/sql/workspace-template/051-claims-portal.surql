-- 11.1 债权人令牌入口：令牌哈希、申报与附件元数据（只新增结构）。
-- 业务用户仅可读；写权限对业务会话关闭（WHERE false），由 root 门户写入。
-- 物理表名与 docs/claims-reconciliation/data-model.md / docs/adr/creditor-token-submit.md 对齐。

DEFINE TABLE IF NOT EXISTS claim_access_token SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select
      WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR create, update, delete
      WHERE false;
DEFINE FIELD IF NOT EXISTS roster_id ON TABLE claim_access_token TYPE record<creditor_roster>;
DEFINE FIELD IF NOT EXISTS token_hash ON TABLE claim_access_token TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS status ON TABLE claim_access_token TYPE string
  ASSERT $value INSIDE ["active", "revoked", "exhausted"];
DEFINE FIELD IF NOT EXISTS opened_at ON TABLE claim_access_token TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_attempt_at ON TABLE claim_access_token TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS failure_count ON TABLE claim_access_token TYPE int DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS locked_until ON TABLE claim_access_token TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_by ON TABLE claim_access_token TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 256;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE claim_access_token TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE claim_access_token TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS claim_access_token_hash_unique ON TABLE claim_access_token COLUMNS token_hash UNIQUE;
DEFINE INDEX IF NOT EXISTS claim_access_token_roster_status ON TABLE claim_access_token COLUMNS roster_id, status;

DEFINE TABLE IF NOT EXISTS claim_submission SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select
      WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR create, update, delete
      WHERE false;
DEFINE FIELD IF NOT EXISTS roster_id ON TABLE claim_submission TYPE record<creditor_roster>;
DEFINE FIELD IF NOT EXISTS identity_code ON TABLE claim_submission TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS principal ON TABLE claim_submission TYPE option<number>
  ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD IF NOT EXISTS rate_segments ON TABLE claim_submission TYPE option<array<object>> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS interest_start ON TABLE claim_submission TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS interest_end ON TABLE claim_submission TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS interest_method ON TABLE claim_submission TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ["simple"];
DEFINE FIELD IF NOT EXISTS penalty ON TABLE claim_submission TYPE option<number>
  ASSERT $value = NONE OR $value >= 0;
DEFINE FIELD IF NOT EXISTS statement ON TABLE claim_submission TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 8192;
DEFINE FIELD IF NOT EXISTS status ON TABLE claim_submission TYPE string
  ASSERT $value INSIDE ["draft", "submitted", "needs_info", "closed"];
DEFINE FIELD IF NOT EXISTS submitted_at ON TABLE claim_submission TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS manager_note ON TABLE claim_submission TYPE option<string>
  ASSERT $value = NONE OR string::len($value) <= 4096;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE claim_submission TYPE datetime VALUE time::now() READONLY;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE claim_submission TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS claim_submission_roster_unique ON TABLE claim_submission COLUMNS roster_id UNIQUE;

DEFINE TABLE IF NOT EXISTS claim_attachment SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select
      WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR create, update, delete
      WHERE false;
DEFINE FIELD IF NOT EXISTS submission_id ON TABLE claim_attachment TYPE record<claim_submission>;
DEFINE FIELD IF NOT EXISTS attachment_type ON TABLE claim_attachment TYPE string
  ASSERT $value INSIDE ["contract", "statement", "judgment"];
DEFINE FIELD IF NOT EXISTS file_name ON TABLE claim_attachment TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 512;
DEFINE FIELD IF NOT EXISTS content_type ON TABLE claim_attachment TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS byte_size ON TABLE claim_attachment TYPE int
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS storage_key ON TABLE claim_attachment TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 1024;
DEFINE FIELD IF NOT EXISTS uploaded_at ON TABLE claim_attachment TYPE datetime;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE claim_attachment TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX IF NOT EXISTS claim_attachment_submission ON TABLE claim_attachment COLUMNS submission_id;
