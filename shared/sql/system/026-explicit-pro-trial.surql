-- LCA10: additive control-plane structures only; no commercial defaults/seed grants.
DEFINE TABLE IF NOT EXISTS pro_trial_revision SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS product_revision ON pro_trial_revision TYPE record<product_plan_revision>;
DEFINE FIELD IF NOT EXISTS research_rate ON pro_trial_revision TYPE int ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS rate_revision ON pro_trial_revision TYPE int ASSERT $value >= 2;
DEFINE FIELD IF NOT EXISTS duration_days ON pro_trial_revision TYPE int ASSERT $value = 7;
DEFINE FIELD IF NOT EXISTS reminder_hours ON pro_trial_revision TYPE array<int>;
DEFINE FIELD IF NOT EXISTS reminder_hours.* ON pro_trial_revision TYPE int ASSERT $value > 0 AND $value < 168;
DEFINE FIELD IF NOT EXISTS fixture ON pro_trial_revision TYPE bool;
DEFINE FIELD IF NOT EXISTS approved_by ON pro_trial_revision TYPE string;
DEFINE FIELD IF NOT EXISTS approval_reason ON pro_trial_revision TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON pro_trial_revision TYPE datetime DEFAULT time::now();
DEFINE EVENT IF NOT EXISTS pro_trial_revision_immutable ON pro_trial_revision
  WHEN $event = "UPDATE" OR $event = "DELETE" THEN { THROW "immutable-control-plane-record:pro_trial_revision"; };

DEFINE TABLE IF NOT EXISTS pro_trial_configuration SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS revision ON pro_trial_configuration TYPE record<pro_trial_revision>;
DEFINE FIELD IF NOT EXISTS enabled ON pro_trial_configuration TYPE bool;
DEFINE FIELD IF NOT EXISTS updated_by ON pro_trial_configuration TYPE string;
DEFINE FIELD IF NOT EXISTS updated_at ON pro_trial_configuration TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS pro_trial_eligibility SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS billing_account ON pro_trial_eligibility TYPE record<billing_account>;
DEFINE FIELD IF NOT EXISTS enabled ON pro_trial_eligibility TYPE bool;
DEFINE FIELD IF NOT EXISTS reason ON pro_trial_eligibility TYPE string;
DEFINE FIELD IF NOT EXISTS approved_by ON pro_trial_eligibility TYPE string;
DEFINE FIELD IF NOT EXISTS updated_at ON pro_trial_eligibility TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS pro_trial_eligibility_account ON pro_trial_eligibility COLUMNS billing_account UNIQUE;

DEFINE TABLE IF NOT EXISTS pro_trial_claim SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS billing_account ON pro_trial_claim TYPE record<billing_account>;
DEFINE FIELD IF NOT EXISTS subject ON pro_trial_claim TYPE string;
DEFINE FIELD IF NOT EXISTS name ON pro_trial_claim TYPE string;
DEFINE FIELD IF NOT EXISTS slug ON pro_trial_claim TYPE string;
DEFINE FIELD IF NOT EXISTS request_key ON pro_trial_claim TYPE string;
DEFINE FIELD IF NOT EXISTS started_at ON pro_trial_claim TYPE datetime;
DEFINE FIELD IF NOT EXISTS ends_at ON pro_trial_claim TYPE datetime ASSERT $value = started_at + 7d;
DEFINE FIELD IF NOT EXISTS offer ON pro_trial_claim TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS state ON pro_trial_claim TYPE string ASSERT $value INSIDE ["provisioning", "active"];
DEFINE FIELD IF NOT EXISTS lease ON pro_trial_claim TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lease_until ON pro_trial_claim TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON pro_trial_claim TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS pro_trial_claim_request ON pro_trial_claim COLUMNS billing_account, request_key UNIQUE;
DEFINE INDEX IF NOT EXISTS pro_trial_claim_slug ON pro_trial_claim COLUMNS slug UNIQUE;

DEFINE TABLE IF NOT EXISTS pro_trial_slot SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS billing_account ON pro_trial_slot TYPE record<billing_account>;
DEFINE FIELD IF NOT EXISTS current_claim ON pro_trial_slot TYPE record<pro_trial_claim>;
DEFINE INDEX IF NOT EXISTS pro_trial_slot_account ON pro_trial_slot COLUMNS billing_account UNIQUE;
