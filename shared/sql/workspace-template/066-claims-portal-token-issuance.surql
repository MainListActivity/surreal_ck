DEFINE FIELD IF NOT EXISTS active_key ON TABLE claim_access_token TYPE option<string>
  VALUE IF $this.status = "active" { <string>$this.roster_id } ELSE { <string>$this.id };

-- Existing workspaces may contain duplicate active tokens from concurrent v1 issuance.
LET $active_groups = SELECT roster_id FROM claim_access_token WHERE status = "active" GROUP BY roster_id;
FOR $group IN $active_groups {
  LET $latest = (SELECT id, created_at FROM claim_access_token
    WHERE roster_id = $group.roster_id AND status = "active" ORDER BY created_at DESC, id DESC LIMIT 1)[0].id;
  UPDATE claim_access_token SET status = "revoked"
    WHERE roster_id = $group.roster_id AND status = "active" AND id != $latest;
};
UPDATE claim_access_token SET active_key = "";
DEFINE INDEX IF NOT EXISTS claim_access_token_one_active ON TABLE claim_access_token COLUMNS active_key UNIQUE;
