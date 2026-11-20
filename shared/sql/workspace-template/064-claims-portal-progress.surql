DEFINE FIELD IF NOT EXISTS portal_stage ON TABLE claim_submission TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE [
    "submitted", "accepted", "needs_info", "under_review", "decision_published", "objected", "final"
  ];
DEFINE FIELD IF NOT EXISTS portal_stage_by ON TABLE claim_submission TYPE option<string>
  ASSERT $value = NONE OR string::len($value) INSIDE 1..=256;

DEFINE TABLE IF NOT EXISTS claim_progress_event SCHEMAFULL
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS submission_id ON TABLE claim_progress_event TYPE record<claim_submission> READONLY;
DEFINE FIELD IF NOT EXISTS stage ON TABLE claim_progress_event TYPE string READONLY
  ASSERT $value INSIDE ["submitted", "accepted", "needs_info", "under_review", "decision_published", "objected", "final"];
DEFINE FIELD IF NOT EXISTS actor ON TABLE claim_progress_event TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE claim_progress_event TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX IF NOT EXISTS claim_progress_event_timeline ON TABLE claim_progress_event COLUMNS submission_id, created_at;
DEFINE EVENT OVERWRITE claim_progress_event_immutable ON TABLE claim_progress_event
  WHEN $event INSIDE ["UPDATE", "DELETE"] THEN { THROW "claim progress event: append only"; };

DEFINE EVENT OVERWRITE claim_submission_portal_transition ON TABLE claim_submission
  WHEN $event = "UPDATE" AND $before.portal_stage != $after.portal_stage
  THEN {
    LET $previous = $before.portal_stage ?? IF $before.status = "draft" { NONE }
      ELSE IF $before.status = "closed" { "final" } ELSE { $before.status };
    LET $next = $after.portal_stage;
    LET $allowed = ($next = "submitted" AND $previous = NONE AND $after.status = "submitted")
      OR ($next = "accepted" AND $previous = "submitted")
      OR ($next = "needs_info" AND $previous INSIDE ["accepted", "under_review"])
      OR ($next = "under_review" AND $previous INSIDE ["accepted", "needs_info"])
      OR ($next = "decision_published" AND $previous INSIDE ["under_review", "objected"])
      OR ($next = "objected" AND $previous = "decision_published")
      OR ($next = "final" AND $previous = "decision_published");
    IF !$allowed OR $after.portal_stage_by = NONE {
      THROW "claim submission: invalid portal stage transition";
    };
    CREATE claim_progress_event SET
      submission_id = $after.id, stage = $next, actor = $after.portal_stage_by;
  };

DEFINE TABLE OVERWRITE claim_supplement SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE fn::current_user() != NONE AND fn::current_user().disabled_at = NONE
    FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS due_at ON TABLE claim_supplement TYPE option<datetime> READONLY;
DEFINE FIELD IF NOT EXISTS template_key ON TABLE claim_supplement TYPE option<string> READONLY
  ASSERT $value = NONE OR string::len($value) INSIDE 1..=128;
DEFINE FIELD IF NOT EXISTS request_id ON TABLE claim_supplement TYPE option<record<claim_supplement>> READONLY;
DEFINE FIELD IF NOT EXISTS attachment_ids ON TABLE claim_supplement TYPE option<array<record<claim_attachment>>> READONLY
  ASSERT $value = NONE OR array::len($value) <= 20;

DEFINE EVENT OVERWRITE claim_supplement_request_progress ON TABLE claim_supplement
  WHEN $event = "CREATE" AND $after.direction = "manager_request"
  THEN {
    LET $submission = $after.submission_id;
    LET $prior = $submission.portal_stage ?? $submission.status;
    IF $prior NOTINSIDE ["submitted", "accepted", "needs_info", "under_review"] {
      THROW "claim supplement: submission is not under review";
    };
    IF $prior = "submitted" {
      UPDATE $submission SET portal_stage = "accepted", portal_stage_by = $after.actor;
    };
    IF $prior != "needs_info" {
      UPDATE $submission SET portal_stage = "needs_info", portal_stage_by = $after.actor;
    };
  };
