-- 只有测试工具服务写入此标记，运营代办开通不能触发失败自动清理。
DEFINE FIELD IF NOT EXISTS test_kit_managed ON ops_invitation TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS test_kit_cancellation_token ON ops_invitation TYPE option<string>;
