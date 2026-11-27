DEFINE FIELD OVERWRITE sheet_defs.*.column_defs ON TABLE workbook_template
  TYPE array<object> FLEXIBLE DEFAULT [];
