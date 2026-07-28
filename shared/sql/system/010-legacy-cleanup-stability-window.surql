-- Existing workspaces retain legacy quota rollback protection for the
-- configured stability window after native verification. Greenfield
-- provisioning sets this to time::now() because it never served legacy data.

DEFINE FIELD IF NOT EXISTS legacy_cleanup_after ON TABLE workspace TYPE option<datetime>;
