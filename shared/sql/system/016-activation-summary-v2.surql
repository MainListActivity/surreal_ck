-- 数据完善成效摘要 v2；v1 投影继续可读。
DEFINE FIELD OVERWRITE contract_version ON TABLE workspace_activation_summary TYPE string
  ASSERT $value INSIDE ["1", "2"];
