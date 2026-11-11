use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;
#[test]
fn production_entry_fails_closed() -> Result<(), String> {
    let mut app =
        Headless::start(EngineConfig::new(Root::of::<nsh_app_native_client::App>())).unwrap();
    app.wait_for("尚未配置可信更新服务，暂不能打开应用。")?;
    assert!(!app.shows("创建邀请"));
    Ok(())
}
#[test]
fn collaboration_starts_offline() -> Result<(), String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<
        nsh_app_native_client::Collaboration,
    >()))
    .unwrap();
    app.wait_for("离线")?;
    app.wait_for("创建邀请")?;
    assert!(!app.shows("已连接 · P2P"));
    Ok(())
}

#[test]
fn enterprise_login_without_configuration_never_claims_success() -> Result<(), String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<
        nsh_app_native_client::Collaboration,
    >()))
    .unwrap();
    app.wait_for("企业账号与成员")?;
    app.press("企业账号与成员")?;
    app.wait_for("企业原生登录尚未配置或平台回调未接入；不会模拟登录成功。")?;
    assert!(!app.shows("已验证登录"));
    Ok(())
}

#[test]
fn opening_media_settings_does_not_enable_capture_or_playback() -> Result<(), String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<
        nsh_app_native_client::Collaboration,
    >()))
    .unwrap();
    app.wait_for("直连会话")?;
    scroll_to(&mut app, "原生媒体")?;
    app.wait_for("麦克风 · 未启用")?;
    app.wait_for("摄像头 · 未启用")?;
    app.wait_for("屏幕共享 · 未启用")?;
    app.press("展开/收起媒体设备与接收设置")?;
    scroll_to(&mut app, "允许远端音频")?;
    scroll_to(&mut app, "允许远端视频")?;
    app.wait_for("麦克风 · 未启用")?;
    assert!(app.shows("断开并停止媒体"));
    assert!(!app.shows("已收到真实解码帧"));
    Ok(())
}

fn scroll_to(app: &mut Headless, text: &str) -> Result<(), String> {
    for _ in 0..12 {
        if app.shows(text) {
            return Ok(());
        }
        app.scroll("id:conversation-scroll", nsh_core::prelude::px(180.0))?;
    }
    app.wait_for(text)
}

#[test]
fn update_gate_can_scroll_and_retry_in_a_small_window() -> Result<(), String> {
    use nsh_core::prelude::{Size, px};
    let mut app =
        Headless::start(EngineConfig::new(Root::of::<nsh_app_native_client::App>())).unwrap();
    app.set_viewport(Size::new(px(240.0), px(120.0)))?;
    app.wait_for("尚未配置可信更新服务，暂不能打开应用。")?;
    app.scroll("id:update-scroll", px(300.0))?;
    app.wait_for("更新完成前不可进入协作空间。")?;
    app.press("重新检查更新")?;
    app.wait_for("尚未配置可信更新服务，暂不能打开应用。")?;
    assert!(!app.shows("创建邀请"));
    app.scroll("id:update-scroll", px(-300.0))?;
    app.wait_for("吉吉 · 安全更新")?;
    app.set_viewport(Size::new(px(1100.0), px(760.0)))?;
    app.wait_for("重新检查更新")?;
    assert!(!app.shows("创建邀请"));
    Ok(())
}

#[test]
fn folding_enterprise_settings_keeps_unconfigured_login_offline() -> Result<(), String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<
        nsh_app_native_client::Collaboration,
    >()))
    .unwrap();
    app.wait_for("企业账号与成员")?;
    for _ in 0..2 {
        app.press("企业账号与成员")?;
        app.wait_for("企业原生登录尚未配置或平台回调未接入；不会模拟登录成功。")?;
        app.press("企业账号与成员")?;
    }
    assert!(!app.shows("已验证登录"));
    assert!(!app.shows("采集已启动，向当前对端发送已启用"));
    Ok(())
}
