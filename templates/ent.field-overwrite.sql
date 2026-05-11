-- params: table_name, field_name, field_type, field_assert?
DEFINE FIELD OVERWRITE {{field_name}} ON TABLE {{table_name}} TYPE {{field_type}}{{field_assert}};
