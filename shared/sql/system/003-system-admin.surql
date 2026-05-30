DEFINE TABLE IF NOT EXISTS system_admin SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS subject ON TABLE system_admin TYPE string;
DEFINE FIELD IF NOT EXISTS email ON TABLE system_admin TYPE option<string>;
DEFINE FIELD IF NOT EXISTS note ON TABLE system_admin TYPE option<string>;
DEFINE FIELD IF NOT EXISTS added_at ON TABLE system_admin TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS system_admin_subject_unique ON TABLE system_admin COLUMNS subject UNIQUE;
