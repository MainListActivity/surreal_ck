DEFINE TABLE IF NOT EXISTS claim_supplement_template SCHEMAFULL
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS key ON TABLE claim_supplement_template TYPE string
  ASSERT string::len($value) INSIDE 1..=128;
DEFINE FIELD IF NOT EXISTS label ON TABLE claim_supplement_template TYPE string
  ASSERT string::len(string::trim($value)) INSIDE 1..=100;
DEFINE FIELD IF NOT EXISTS body ON TABLE claim_supplement_template TYPE string
  ASSERT string::len(string::trim($value)) INSIDE 1..=4000;
DEFINE INDEX IF NOT EXISTS claim_supplement_template_key ON TABLE claim_supplement_template COLUMNS key UNIQUE;
