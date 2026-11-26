DEFINE TABLE IF NOT EXISTS meeting_evidence_archive SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS meeting ON TABLE meeting_evidence_archive TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS root_sha256 ON TABLE meeting_evidence_archive TYPE bytes READONLY;
DEFINE FIELD IF NOT EXISTS sealed_at ON TABLE meeting_evidence_archive TYPE datetime READONLY;
DEFINE FIELD IF NOT EXISTS retain_until ON TABLE meeting_evidence_archive TYPE datetime READONLY;
DEFINE EVENT IF NOT EXISTS meeting_evidence_archive_immutable ON TABLE meeting_evidence_archive
  WHEN $event INSIDE ["UPDATE", "DELETE"] THEN { THROW "meeting evidence archive: append only"; };
