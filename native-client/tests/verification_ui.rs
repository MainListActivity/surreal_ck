use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;

#[test]
fn offline_fingerprint_inspection_is_explicit_cancellable_and_never_claims_identity()
-> Result<(), String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<
        nsh_app_native_client::Collaboration,
    >()))
    .unwrap();
    use nsh_core::prelude::{Size, px};
    app.set_viewport(Size::new(px(480.0), px(800.0)))?;
    app.wait_for("吉吉协同：团队消息、会议和屏幕共享")?;
    assert!(!app.shows("查看连接指纹"), "指纹核对位于开发者诊断，不在首屏");
    app.press("设置")?;
    for _ in 0..12 {
        if app.shows("打开开发者诊断") { break; }
        app.scroll("id:conversation-scroll", px(180.0))?;
    }
    app.press("打开开发者诊断")?;
    while app.scroll("id:conversation-scroll", px(-180.0)).is_ok() {}
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
