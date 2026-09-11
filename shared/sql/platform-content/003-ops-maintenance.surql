-- v3：运营维护与批次审计所需的来源许可快照。
-- 批次保存提交时生效的许可修订，后续来源变更不会改变历史校验依据。

DEFINE FIELD IF NOT EXISTS source_license_snapshot ON TABLE ingestion_batch TYPE object FLEXIBLE;

DEFINE INDEX IF NOT EXISTS ingestion_batch_received_at ON TABLE ingestion_batch COLUMNS received_at;
DEFINE INDEX IF NOT EXISTS platform_content_audit_event_occurred_at ON TABLE platform_content_audit_event COLUMNS occurred_at;
DEFINE INDEX IF NOT EXISTS platform_content_audit_event_kind ON TABLE platform_content_audit_event COLUMNS kind;
