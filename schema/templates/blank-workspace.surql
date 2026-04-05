-- Blank Workspace template provisioning script.
-- Creates a workspace + workbook with no entity types, no sample data.
-- The guided setup panel in the app shell walks the admin through first actions.
-- Idempotent: safe to re-run.
-- Variables injected by the client before execution:
--   $ws  -- record<workspace>
--   $wb  -- record<workbook>

-- No entity types, relation types, or sample data to provision.
-- The workbook record is created by the client before calling this script.
-- This file is intentionally minimal — the blank workspace is empty by design.

SELECT "Blank workspace ready. Open the guided setup panel to create your first entity type." AS message;
