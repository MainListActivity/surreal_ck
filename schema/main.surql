OPTION IMPORT;

DEFINE NAMESPACE IF NOT EXISTS surreal_ck;
USE NS surreal_ck DB app;

DEFINE TABLE IF NOT EXISTS user SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS email ON TABLE user TYPE string ASSERT string::is_email($value);
DEFINE FIELD IF NOT EXISTS name ON TABLE user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS password_hash ON TABLE user TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS user_email_unique ON TABLE user COLUMNS email UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS slug ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS owner ON TABLE workspace TYPE record<user>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_slug_unique ON TABLE workspace COLUMNS slug UNIQUE;

DEFINE TABLE IF NOT EXISTS workbook SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE workbook TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS name ON TABLE workbook TYPE string;
DEFINE FIELD IF NOT EXISTS template_key ON TABLE workbook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_viewed_sheet ON TABLE workbook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workbook TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS workspace_member SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE workspace_member TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS user ON TABLE workspace_member TYPE record<user>;
DEFINE FIELD IF NOT EXISTS email ON TABLE workspace_member TYPE string ASSERT string::is_email($value);
DEFINE FIELD IF NOT EXISTS role ON TABLE workspace_member TYPE string ASSERT $value INSIDE ["admin", "editor", "viewer"];
DEFINE FIELD IF NOT EXISTS invited_at ON TABLE workspace_member TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_member_unique ON TABLE workspace_member COLUMNS workspace, user UNIQUE;
DEFINE INDEX IF NOT EXISTS workspace_member_email_unique ON TABLE workspace_member COLUMNS workspace, email UNIQUE;

DEFINE TABLE IF NOT EXISTS mutation SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workbook ON TABLE mutation TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE mutation TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS command_id ON TABLE mutation TYPE string;
DEFINE FIELD IF NOT EXISTS params ON TABLE mutation TYPE object;
DEFINE FIELD IF NOT EXISTS client_id ON TABLE mutation TYPE string;
DEFINE FIELD IF NOT EXISTS actor ON TABLE mutation TYPE option<record<user>>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE mutation TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS mutation_by_workbook_ts ON TABLE mutation COLUMNS workbook, created_at;

DEFINE TABLE IF NOT EXISTS snapshot SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workbook ON TABLE snapshot TYPE record<workbook>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE snapshot TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS data ON TABLE snapshot TYPE object;
DEFINE FIELD IF NOT EXISTS coordinator_client_id ON TABLE snapshot TYPE string;
DEFINE FIELD IF NOT EXISTS mutation_watermark ON TABLE snapshot TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE snapshot TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS snapshot_by_workbook_ts ON TABLE snapshot COLUMNS workbook, created_at;

DEFINE TABLE IF NOT EXISTS presence SCHEMALESS;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE presence TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS workbook ON TABLE presence TYPE option<record<workbook>>;
DEFINE FIELD IF NOT EXISTS client_id ON TABLE presence TYPE string;
DEFINE FIELD IF NOT EXISTS user ON TABLE presence TYPE option<record<user>>;
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE presence TYPE datetime;
DEFINE INDEX IF NOT EXISTS presence_by_workbook ON TABLE presence COLUMNS workbook, client_id;

DEFINE TABLE IF NOT EXISTS field_type SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS key ON TABLE field_type TYPE string;
DEFINE FIELD IF NOT EXISTS label ON TABLE field_type TYPE string;
DEFINE FIELD IF NOT EXISTS supports_options ON TABLE field_type TYPE bool;
DEFINE FIELD IF NOT EXISTS supports_relations ON TABLE field_type TYPE bool;
DEFINE INDEX IF NOT EXISTS field_type_key_unique ON TABLE field_type COLUMNS key UNIQUE;

UPSERT field_type:text CONTENT { key: "text", label: "Text", supports_options: false, supports_relations: false };
UPSERT field_type:number CONTENT { key: "number", label: "Number", supports_options: false, supports_relations: false };
UPSERT field_type:date CONTENT { key: "date", label: "Date", supports_options: false, supports_relations: false };
UPSERT field_type:single_select CONTENT { key: "single_select", label: "Single Select", supports_options: true, supports_relations: false };
UPSERT field_type:multi_select CONTENT { key: "multi_select", label: "Multi Select", supports_options: true, supports_relations: false };
UPSERT field_type:file CONTENT { key: "file", label: "File", supports_options: false, supports_relations: false };

DEFINE TABLE IF NOT EXISTS entity_type SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE entity_type TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS key ON TABLE entity_type TYPE string;
DEFINE FIELD IF NOT EXISTS label ON TABLE entity_type TYPE string;
DEFINE FIELD IF NOT EXISTS fields ON TABLE entity_type TYPE array<object>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE entity_type TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS entity_type_workspace_key_unique ON TABLE entity_type COLUMNS workspace, key UNIQUE;

DEFINE TABLE IF NOT EXISTS relation_type SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE relation_type TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS key ON TABLE relation_type TYPE string;
DEFINE FIELD IF NOT EXISTS label ON TABLE relation_type TYPE string;
DEFINE FIELD IF NOT EXISTS from_entity_type ON TABLE relation_type TYPE string;
DEFINE FIELD IF NOT EXISTS to_entity_type ON TABLE relation_type TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE relation_type TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS relation_type_workspace_key_unique ON TABLE relation_type COLUMNS workspace, key UNIQUE;

DEFINE TABLE IF NOT EXISTS form_definition SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE form_definition TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS title ON TABLE form_definition TYPE string;
DEFINE FIELD IF NOT EXISTS slug ON TABLE form_definition TYPE string;
DEFINE FIELD IF NOT EXISTS target_table ON TABLE form_definition TYPE string;
DEFINE FIELD IF NOT EXISTS fields ON TABLE form_definition TYPE array<object>;
DEFINE FIELD IF NOT EXISTS conditional_rules ON TABLE form_definition TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS auto_relations ON TABLE form_definition TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE form_definition TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS form_definition_workspace_slug_unique ON TABLE form_definition COLUMNS workspace, slug UNIQUE;

DEFINE TABLE IF NOT EXISTS intake_submission SCHEMALESS;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE intake_submission TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS form_definition ON TABLE intake_submission TYPE option<record<form_definition>>;
DEFINE FIELD IF NOT EXISTS submission_token ON TABLE intake_submission TYPE string;
DEFINE FIELD IF NOT EXISTS payload ON TABLE intake_submission TYPE object;
DEFINE FIELD IF NOT EXISTS unverified ON TABLE intake_submission TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE intake_submission TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS intake_submission_token_unique ON TABLE intake_submission COLUMNS submission_token UNIQUE;

DEFINE TABLE IF NOT EXISTS client_error SCHEMALESS;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE client_error TYPE option<record<workspace>>;
DEFINE FIELD IF NOT EXISTS workbook ON TABLE client_error TYPE option<record<workbook>>;
DEFINE FIELD IF NOT EXISTS client_id ON TABLE client_error TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_code ON TABLE client_error TYPE string;
DEFINE FIELD IF NOT EXISTS message ON TABLE client_error TYPE string;
DEFINE FIELD IF NOT EXISTS meta ON TABLE client_error TYPE option<object>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE client_error TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS workbook_file SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE workbook_file TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS bucket_path ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS original_name ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS mime_type ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS size_bytes ON TABLE workbook_file TYPE int;
DEFINE FIELD IF NOT EXISTS uploaded_by ON TABLE workbook_file TYPE option<record<user>>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook_file TYPE datetime VALUE time::now();

DEFINE BUCKET IF NOT EXISTS spreadsheet_files BACKEND "file:/data/uploads" PERMISSIONS FULL;

DEFINE ACCESS lawyer_access ON DATABASE TYPE RECORD
  SIGNIN (
    SELECT VALUE {
      access: "placeholder-access",
      refresh: "placeholder-refresh"
    }
  )
  SIGNUP (
    CREATE user CONTENT {
      email: $email,
      password_hash: crypto::argon2::generate($password),
      name: $name
    }
  );

DEFINE ACCESS form_submit ON DATABASE TYPE RECORD
  SIGNIN (SELECT VALUE { access: "form-submit-access", refresh: NONE })
  SIGNUP NONE;
