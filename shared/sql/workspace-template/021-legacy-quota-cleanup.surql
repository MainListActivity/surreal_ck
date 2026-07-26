-- DEFERRED LEGACY CLEANUP. Only run when workspace.quota_migration_state is
-- native_verified (or cleanup_done retry). See WORKSPACE_MIGRATION_REQUIREMENTS.
-- Removes event-based enforcement after native policy has been read back.
-- Do not run this migration on workspaces that still rely on 020 dual protection.

REMOVE EVENT IF EXISTS resource_quota_guard ON TABLE sheet;

REMOVE TABLE IF EXISTS sheet_resource_usage;
REMOVE TABLE IF EXISTS workspace_resource_quota;
REMOVE TABLE IF EXISTS resource_quota_plan;
