-- DEFERRED RESIDUAL CLEANUP. Runs only when workspace.quota_migration_state is
-- native_verified or cleanup_done. Removes resource_quota_guard events still
-- attached to entity tables created after (or missed by) the 021 cleanup;
-- their table references no longer resolve once legacy quota tables are gone.
-- REMOVE EVENT needs concrete identifiers, so
-- server/src/db/workspace-migration-execution.ts materializes the real
-- transaction after validating every sheet.table_name.

RETURN "legacy-quota-guard-residual-runtime-materialization-required";
