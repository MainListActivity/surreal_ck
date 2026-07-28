-- Distinguish the 100% capacity threshold from an actual over-limit episode.
-- Delivery remains mutable and records the in-product read acknowledgement;
-- the notification outbox itself stays immutable.

DEFINE FIELD IF NOT EXISTS alert_kind ON TABLE quota_alert_state TYPE string
  DEFAULT "threshold"
  ASSERT $value INSIDE ["threshold", "over_limit"];

DEFINE FIELD IF NOT EXISTS read_at ON TABLE quota_notification_delivery TYPE option<datetime>;
