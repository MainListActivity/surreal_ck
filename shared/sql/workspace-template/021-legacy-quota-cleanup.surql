-- DEFERRED LEGACY CLEANUP. Only run when workspace.quota_migration_state is
-- native_verified (or cleanup_done retry). See WORKSPACE_MIGRATION_REQUIREMENTS.
-- This file is an intentionally harmless marker. REMOVE EVENT requires
-- concrete identifiers, so server/src/db/workspace-migration-execution.ts
-- materializes the real transaction after validating every sheet.table_name.
-- Never replace this marker with a partial static cleanup.

RETURN "legacy-quota-cleanup-runtime-materialization-required";
