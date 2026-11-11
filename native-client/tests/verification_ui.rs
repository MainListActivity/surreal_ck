use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;

#[test]
fn offline_fingerprint_inspection_is_explicit_cancellable_and_never_claims_identity()
-> Result<(), String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<
        nsh_app_native_client::Collaboration,
    >()))
    .unwrap();
    app.wait_for("查看连接指纹")?;
    assert!(!app.shows("已通过可信渠道对照完整材料"));
    app.press("查看连接指纹")?;
    app.wait_for("请先与对方建立连接，再查看实际连接指纹。")?;
    app.wait_for(
        "这里只记录此次快照的人工断言，不是持续连接认证，也不代表企业身份、成员资格或角色。",
    )?;
    assert!(!app.shows("已记录：你声明通过可信渠道对照了此次快照的完整材料。"));
    app.press("取消并清除核对")?;
    assert!(!app.shows("已通过可信渠道对照完整材料"));
    app.press("查看连接指纹")?;
    app.wait_for("请先与对方建立连接，再查看实际连接指纹。")?;
    app.press("取消并清除核对")?;
    assert!(!app.shows("已通过可信渠道对照完整材料"));
    Ok(())
}
