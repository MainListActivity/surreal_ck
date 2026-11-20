DEFINE TABLE IF NOT EXISTS claim_portal_audit SCHEMAFULL
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS action ON TABLE claim_portal_audit TYPE string READONLY
  ASSERT $value INSIDE ["decision_published", "token_issued", "token_revoked"];
DEFINE FIELD IF NOT EXISTS target ON TABLE claim_portal_audit TYPE record READONLY;
DEFINE FIELD IF NOT EXISTS actor ON TABLE claim_portal_audit TYPE string READONLY
  ASSERT string::len($value) INSIDE 1..=256;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE claim_portal_audit TYPE datetime DEFAULT time::now() READONLY;
DEFINE EVENT OVERWRITE claim_portal_audit_immutable ON TABLE claim_portal_audit
  WHEN $event INSIDE ["UPDATE", "DELETE"] THEN { THROW "claim portal audit: append only"; };

DEFINE TABLE IF NOT EXISTS claim_decision SCHEMAFULL
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS submission_id ON TABLE claim_decision TYPE record<claim_submission> READONLY;
DEFINE FIELD IF NOT EXISTS version ON TABLE claim_decision TYPE int READONLY ASSERT $value > 0;
DEFINE FIELD IF NOT EXISTS confirmed_principal ON TABLE claim_decision TYPE number READONLY ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS confirmed_interest ON TABLE claim_decision TYPE number READONLY ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS confirmed_penalty ON TABLE claim_decision TYPE number READONLY ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS unconfirmed_amount ON TABLE claim_decision TYPE number READONLY ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS reason ON TABLE claim_decision TYPE string READONLY
  ASSERT string::len(string::trim($value)) INSIDE 1..=4000;
DEFINE FIELD IF NOT EXISTS published_by ON TABLE claim_decision TYPE string
  VALUE <string>fn::current_user() READONLY
  ASSERT string::len($value) INSIDE 1..=256;
DEFINE FIELD IF NOT EXISTS published_at ON TABLE claim_decision TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX IF NOT EXISTS claim_decision_version ON TABLE claim_decision COLUMNS submission_id, version UNIQUE;

DEFINE EVENT OVERWRITE claim_decision_immutable ON TABLE claim_decision
  WHEN $event INSIDE ["UPDATE", "DELETE"] THEN { THROW "claim decision: append only"; };
DEFINE EVENT OVERWRITE claim_submission_requires_decision ON TABLE claim_submission
  WHEN $event = "UPDATE" AND $before.portal_stage != $after.portal_stage AND $after.portal_stage = "decision_published"
  THEN {
    IF !array::len(SELECT id FROM claim_decision WHERE submission_id = $after.id LIMIT 1) {
      THROW "claim decision: no published version";
    };
  };
DEFINE EVENT OVERWRITE claim_decision_publish ON TABLE claim_decision WHEN $event = "CREATE" THEN {
  LET $submission = $after.submission_id;
  LET $stage = $submission.portal_stage;
  IF $stage NOTINSIDE ["under_review", "decision_published", "objected"] {
    THROW "claim decision: submission is not under review";
  };
  LET $latest = (SELECT VALUE version FROM claim_decision
    WHERE submission_id = $submission AND id != $after.id ORDER BY version DESC LIMIT 1)[0] ?? 0;
  IF $after.version != $latest + 1 { THROW "claim decision: version changed"; };
  IF $stage = "decision_published" {
    CREATE claim_progress_event SET
      submission_id = $submission, stage = "decision_published", actor = $after.published_by;
  } ELSE {
    UPDATE $submission SET portal_stage = "decision_published", portal_stage_by = $after.published_by;
  };
  CREATE claim_portal_audit SET action = "decision_published", target = $after.id, actor = $after.published_by;
};
