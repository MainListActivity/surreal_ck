OPTION IMPORT;

DEFINE NAMESPACE IF NOT EXISTS main;
USE NS main DB docs;

DEFINE TABLE IF NOT EXISTS app_user SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE id = $auth.id,
    FOR create NONE;
DEFINE FIELD IF NOT EXISTS subject ON TABLE app_user TYPE string;
DEFINE FIELD IF NOT EXISTS email ON TABLE app_user TYPE option<string> ASSERT $value = NONE OR string::is_email($value);
DEFINE FIELD IF NOT EXISTS name ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS avatar ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON TABLE app_user TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE app_user TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE app_user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS app_user_subject_unique ON TABLE app_user COLUMNS subject UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS slug ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_slug_unique ON TABLE workspace COLUMNS slug UNIQUE;

DEFINE TABLE IF NOT EXISTS workbook SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name ON TABLE workbook TYPE string;
DEFINE FIELD IF NOT EXISTS template_key ON TABLE workbook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_viewed_sheet ON TABLE workbook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook TYPE datetime VALUE time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE workbook TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS workspace_member SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace_key ON TABLE workspace_member TYPE string;
DEFINE FIELD IF NOT EXISTS email ON TABLE workspace_member TYPE string ASSERT string::is_email($value);
DEFINE FIELD IF NOT EXISTS role ON TABLE workspace_member TYPE string ASSERT $value INSIDE ["admin", "editor", "viewer"];
DEFINE FIELD IF NOT EXISTS invited_at ON TABLE workspace_member TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_member_email_unique ON TABLE workspace_member COLUMNS workspace_key, email UNIQUE;

DEFINE TABLE IF NOT EXISTS mutation SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS command_id ON TABLE mutation TYPE string;
DEFINE FIELD IF NOT EXISTS params ON TABLE mutation TYPE object;
DEFINE FIELD IF NOT EXISTS client_id ON TABLE mutation TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE mutation TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS mutation_created_at ON TABLE mutation COLUMNS created_at;

DEFINE TABLE IF NOT EXISTS snapshot SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS data ON TABLE snapshot TYPE object;
DEFINE FIELD IF NOT EXISTS coordinator_client_id ON TABLE snapshot TYPE string;
DEFINE FIELD IF NOT EXISTS mutation_watermark ON TABLE snapshot TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE snapshot TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS snapshot_created_at ON TABLE snapshot COLUMNS created_at;

DEFINE TABLE IF NOT EXISTS presence SCHEMALESS;
DEFINE FIELD IF NOT EXISTS client_id ON TABLE presence TYPE string;
DEFINE FIELD IF NOT EXISTS expires_at ON TABLE presence TYPE datetime;
DEFINE INDEX IF NOT EXISTS presence_client_id ON TABLE presence COLUMNS client_id;

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
DEFINE FIELD IF NOT EXISTS workspace_key ON TABLE entity_type TYPE string;
DEFINE FIELD IF NOT EXISTS key ON TABLE entity_type TYPE string;
DEFINE FIELD IF NOT EXISTS label ON TABLE entity_type TYPE string;
DEFINE FIELD IF NOT EXISTS fields ON TABLE entity_type TYPE array<object>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE entity_type TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS entity_type_workspace_key_unique ON TABLE entity_type COLUMNS workspace_key, key UNIQUE;

DEFINE TABLE IF NOT EXISTS relation_type SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace_key ON TABLE relation_type TYPE string;
DEFINE FIELD IF NOT EXISTS key ON TABLE relation_type TYPE string;
DEFINE FIELD IF NOT EXISTS label ON TABLE relation_type TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE relation_type TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS relation_type_workspace_key_unique ON TABLE relation_type COLUMNS workspace_key, key UNIQUE;

DEFINE TABLE IF NOT EXISTS form_definition SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace_key ON TABLE form_definition TYPE string;
DEFINE FIELD IF NOT EXISTS title ON TABLE form_definition TYPE string;
DEFINE FIELD IF NOT EXISTS slug ON TABLE form_definition TYPE string;
DEFINE FIELD IF NOT EXISTS fields ON TABLE form_definition TYPE array<object>;
DEFINE FIELD IF NOT EXISTS conditional_rules ON TABLE form_definition TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS auto_relations ON TABLE form_definition TYPE array<object> DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at ON TABLE form_definition TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS form_definition_workspace_slug_unique ON TABLE form_definition COLUMNS workspace_key, slug UNIQUE;

DEFINE TABLE IF NOT EXISTS intake_submission SCHEMALESS;
DEFINE FIELD IF NOT EXISTS submission_token ON TABLE intake_submission TYPE string;
DEFINE FIELD IF NOT EXISTS payload ON TABLE intake_submission TYPE object;
DEFINE FIELD IF NOT EXISTS unverified ON TABLE intake_submission TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE intake_submission TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS intake_submission_token_unique ON TABLE intake_submission COLUMNS submission_token UNIQUE;

DEFINE TABLE IF NOT EXISTS client_error SCHEMALESS;
DEFINE FIELD IF NOT EXISTS client_id ON TABLE client_error TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_code ON TABLE client_error TYPE string;
DEFINE FIELD IF NOT EXISTS message ON TABLE client_error TYPE string;
DEFINE FIELD IF NOT EXISTS meta ON TABLE client_error TYPE option<object>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE client_error TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS workbook_file SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS bucket_path ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS original_name ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS mime_type ON TABLE workbook_file TYPE string;
DEFINE FIELD IF NOT EXISTS size_bytes ON TABLE workbook_file TYPE int;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook_file TYPE datetime VALUE time::now();

DEFINE TABLE IF NOT EXISTS owns_workspace TYPE RELATION IN app_user OUT workspace SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE owns_workspace TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS owns_workspace_unique ON TABLE owns_workspace COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_workbook TYPE RELATION IN workspace OUT workbook SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_workbook TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_workbook_unique ON TABLE workspace_has_workbook COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_member TYPE RELATION IN workspace OUT workspace_member SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_member TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_member_unique ON TABLE workspace_has_member COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS member_identifies_user TYPE RELATION IN workspace_member OUT app_user SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE member_identifies_user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS member_identifies_user_unique ON TABLE member_identifies_user COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_entity_type TYPE RELATION IN workspace OUT entity_type SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_entity_type TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_entity_type_unique ON TABLE workspace_has_entity_type COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_relation_type TYPE RELATION IN workspace OUT relation_type SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_relation_type TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_relation_type_unique ON TABLE workspace_has_relation_type COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS relation_from_type TYPE RELATION IN relation_type OUT entity_type SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE relation_from_type TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS relation_from_type_unique ON TABLE relation_from_type COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS relation_to_type TYPE RELATION IN relation_type OUT entity_type SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE relation_to_type TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS relation_to_type_unique ON TABLE relation_to_type COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_form_definition TYPE RELATION IN workspace OUT form_definition SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_form_definition TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_form_definition_unique ON TABLE workspace_has_form_definition COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS form_targets_entity_type TYPE RELATION IN form_definition OUT entity_type SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE form_targets_entity_type TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS form_targets_entity_type_unique ON TABLE form_targets_entity_type COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_submission TYPE RELATION IN workspace OUT intake_submission SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_submission TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_submission_unique ON TABLE workspace_has_submission COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS submission_uses_form TYPE RELATION IN intake_submission OUT form_definition SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE submission_uses_form TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS submission_uses_form_unique ON TABLE submission_uses_form COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_client_error TYPE RELATION IN workspace OUT client_error SCHEMALESS;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_client_error TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_client_error_unique ON TABLE workspace_has_client_error COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workbook_has_client_error TYPE RELATION IN workbook OUT client_error SCHEMALESS;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook_has_client_error TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_has_client_error_unique ON TABLE workbook_has_client_error COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_file TYPE RELATION IN workspace OUT workbook_file SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_file TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_file_unique ON TABLE workspace_has_file COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS file_uploaded_by_user TYPE RELATION IN workbook_file OUT app_user SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE file_uploaded_by_user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS file_uploaded_by_user_unique ON TABLE file_uploaded_by_user COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_presence TYPE RELATION IN workspace OUT presence SCHEMALESS;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_presence TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_presence_unique ON TABLE workspace_has_presence COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workbook_has_presence TYPE RELATION IN workbook OUT presence SCHEMALESS;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook_has_presence TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_has_presence_unique ON TABLE workbook_has_presence COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS presence_user TYPE RELATION IN presence OUT app_user SCHEMALESS;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE presence_user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS presence_user_unique ON TABLE presence_user COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_mutation TYPE RELATION IN workspace OUT mutation SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_mutation TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_mutation_unique ON TABLE workspace_has_mutation COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workbook_has_mutation TYPE RELATION IN workbook OUT mutation SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook_has_mutation TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_has_mutation_unique ON TABLE workbook_has_mutation COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS mutation_actor_user TYPE RELATION IN mutation OUT app_user SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE mutation_actor_user TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS mutation_actor_user_unique ON TABLE mutation_actor_user COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workspace_has_snapshot TYPE RELATION IN workspace OUT snapshot SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workspace_has_snapshot TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workspace_has_snapshot_unique ON TABLE workspace_has_snapshot COLUMNS in, out UNIQUE;

DEFINE TABLE IF NOT EXISTS workbook_has_snapshot TYPE RELATION IN workbook OUT snapshot SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE workbook_has_snapshot TYPE datetime VALUE time::now();
DEFINE INDEX IF NOT EXISTS workbook_has_snapshot_unique ON TABLE workbook_has_snapshot COLUMNS in, out UNIQUE;

DEFINE BUCKET IF NOT EXISTS spreadsheet_files BACKEND "file:/data/uploads" PERMISSIONS FULL;

DEFINE ACCESS OVERWRITE madocs ON DATABASE TYPE RECORD WITH JWT URL 'https://o.maplayer.top/t/ck/jwks.json' AUTHENTICATE {

	IF type::is_array($token.aud) AND $token.aud CONTAINS 'https://auth.maplayer.top' OR $token.aud = 'https://auth.maplayer.top'
	{

IF !$token.sub {
      THROW 'Missing sub claim';
    };

    LET $user_id = type::record('app_user', $token.sub);

    IF (SELECT VALUE id FROM ONLY $user_id) {
      RETURN $user_id;
    };

    LET $display_name = IF $token.name {
      <string>$token.name
    } ELSE IF $token.preferred_username {
      <string>$token.preferred_username
    } ELSE IF $token.email {
      <string>$token.email
    } ELSE {
      <string>$token.sub
    };

    RETURN CREATE $user_id CONTENT {
      display_name: $display_name,
      email: $token.email,
        subject:$token.sub,
      avatar: IF $token.picture { <string>$token.picture } ELSE { NONE },
      status: 'active',
      created_at: time::now(),
      updated_at: time::now()
    };
	
}
ELSE
	{ THROW 'not allowed' }
} DURATION FOR TOKEN 1h, FOR SESSION NONE;
