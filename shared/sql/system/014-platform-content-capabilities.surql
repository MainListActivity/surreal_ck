-- 平台内容维护能力与既有 platform_operator 身份共用，但不扩大客户 workspace 权限。
DEFINE FIELD OVERWRITE capability ON TABLE platform_operator_capability TYPE string
  ASSERT $value INSIDE [
    "quota.read",
    "subscription.manage",
    "override.manage",
    "reconcile.audit",
    "drift.manage",
    "ledger.rebuild",
    "content.read",
    "content.submit",
    "content.publish",
    "content.withdraw",
    "content.restore",
    "content.source.manage",
  ];
