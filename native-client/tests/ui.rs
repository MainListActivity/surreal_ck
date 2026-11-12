use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;
#[cfg(not(feature = "github-manual-updates"))]
#[test]
fn production_entry_fails_closed() -> Result<(), String> {
    let mut app =
        Headless::start(EngineConfig::new(Root::of::<nsh_app_native_client::App>())).unwrap();
    app.wait_for("尚未配置可信更新服务，暂不能打开应用。")?;
    assert!(!app.shows("创建邀请"));
    Ok(())
}
const APP_TITLE: &str = "吉吉 · 团队协同";
const PREVIEW_BADGE: &str = "实验预览版";
const PREVIEW_LABEL: &str = "实验预览版 · 非正式发布，功能仍在验证，请勿用于正式工作";

fn collaboration(width: f32, height: f32) -> Result<Headless, String> {
    use nsh_core::prelude::{Size, px};
    let mut app = Headless::start(EngineConfig::new(Root::of::<
        nsh_app_native_client::Collaboration,
    >()))
    .unwrap();
    app.set_viewport(Size::new(px(width), px(height)))?;
    app.wait_for(APP_TITLE)?;
    Ok(app)
}

fn open_diagnostics(app: &mut Headless) -> Result<(), String> {
    app.press("设置")?;
    app.wait_for("当前版本：0.1.0")?;
    scroll_to(app, "打开开发者诊断")?;
    app.press("打开开发者诊断")?;
    scroll_top(app);
    app.wait_for("开发者诊断 · 手动直连")
}

/// 首屏只承载产品主路径；手动 P2P、连接码、STUN/TURN、指纹、更新和媒体/文件调试不在首屏。
const DEBUG_ONLY: &[&str] = &[
    "创建邀请",
    "复制连接码",
    "接受邀请并生成应答",
    "应用对方应答",
    "查看连接指纹",
    "高级连接设置：P2P 优先，TURN 仅手动备选",
    "改用 TURN 中继创建新邀请",
    "软件更新",
    "检查更新",
    "开发者诊断 · 手动直连",
    "原生媒体",
];

#[test]
fn collaboration_starts_offline() -> Result<(), String> {
    let mut app = collaboration(480.0, 800.0)?;
    app.wait_for("离线：当前没有已连接的会话")?;
    assert!(!app.shows("已连接 · P2P"));
    assert!(!app.shows("已连接"));
    Ok(())
}

#[test]
fn first_screen_shows_message_chrome_and_honest_empty_state() -> Result<(), String> {
    for (width, height) in [(480.0, 800.0), (1100.0, 760.0)] {
        let mut app = collaboration(width, height)?;
        app.wait_for("搜索成员或消息")?;
        app.wait_for("全部")?;
        app.wait_for("未读")?;
        app.wait_for("群聊")?;
        app.wait_for("企业身份：未配置（此构建未接入企业登录，不会模拟登录）")?;
        app.wait_for("暂无团队会话：企业登录未配置。此构建未接入企业登录，不会模拟登录。")?;
        app.wait_for("暂无消息。消息只保存在本次会话内存中。")?;
        app.wait_for("尚未选择会话。")?;
        assert!(app.screen().matches("text:输入消息，Enter 发送")?);
        for hidden in DEBUG_ONLY {
            assert!(!app.shows(hidden), "首屏不应显示调试入口：{hidden}");
        }
        // 未接入的会议能力不在消息页渲染为可用入口。
        for missing in ["发起会议", "加入会议", "共享屏幕", "开始共享"] {
            assert!(!app.shows(missing), "{missing} 不应出现在消息首屏");
            assert!(!app.screen().matches(&format!("role:button[{missing}]"))?);
        }
        assert!(!app.shows("正在共享"));
        assert!(!app.shows("5 人在线"));
        assert!(app.shows("断开并停止媒体"));
        assert_eq!(
            app.shows(PREVIEW_BADGE),
            cfg!(feature = "github-manual-updates")
        );
        if cfg!(feature = "github-manual-updates") {
            assert!(
                !app.shows(PREVIEW_LABEL),
                "完整预览说明不应在消息页做成通栏横幅"
            );
        }
    }
    let app = collaboration(1100.0, 760.0)?;
    assert!(
        app.screen().matches("id:conversation-heading")?,
        "宽窗口显示会话栏标题「消息」"
    );
    Ok(())
}

#[test]
fn offline_send_is_disabled_and_never_fakes_success() -> Result<(), String> {
    let mut app = collaboration(480.0, 800.0)?;
    app.type_text("text:输入消息，Enter 发送", "你好\n")?;
    assert!(app.press("发送消息").is_err(), "离线时发送按钮必须禁用");
    let texts = app.screen().texts().join("\n");
    assert!(
        !texts.contains("我（"),
        "离线时不应产生任何已发送/发送中的消息"
    );
    assert!(!texts.contains("已送出"));
    app.wait_for("离线：当前没有已连接的会话")?;
    Ok(())
}

#[test]
fn settings_and_diagnostics_hold_security_tools() -> Result<(), String> {
    let mut app = collaboration(480.0, 800.0)?;
    app.press("设置")?;
    app.wait_for("当前版本：0.1.0")?;
    assert!(!app.shows("搜索成员或消息"), "设置页不应残留消息会话栏");
    assert!(!app.shows("消息列表"));
    assert!(!app.shows("创建邀请"), "设置页本身不展开手动 P2P");
    open_diagnostics(&mut app)?;
    for tool in ["创建邀请", "复制连接码", "查看连接指纹"] {
        scroll_to(&mut app, tool)?;
    }
    scroll_to(&mut app, "高级连接设置：P2P 优先，TURN 仅手动备选")?;
    assert!(app.shows("断开并停止媒体"));
    scroll_top(&mut app);
    app.press("返回设置")?;
    app.wait_for("当前版本：0.1.0")?;
    app.press("消息")?;
    app.wait_for("搜索成员或消息")?;
    assert!(!app.shows("创建邀请"));
    Ok(())
}

#[test]
fn conversation_heading_is_not_stuck_on_settings() -> Result<(), String> {
    let mut app = collaboration(1100.0, 760.0)?;
    app.wait_for("搜索成员或消息")?;
    app.press("设置")?;
    app.wait_for("当前版本：0.1.0")?;
    assert!(!app.shows("搜索成员或消息"));
    assert!(!app.shows("消息列表"));
    assert!(app.shows("设置"));
    app.press("消息")?;
    app.wait_for("搜索成员或消息")?;
    Ok(())
}

#[test]
fn window_resize_keeps_navigation_usable() -> Result<(), String> {
    use nsh_core::prelude::{Size, px};
    let mut app = collaboration(1100.0, 760.0)?;
    app.press("设置")?;
    app.wait_for("当前版本：0.1.0")?;
    app.set_viewport(Size::new(px(360.0), px(560.0)))?;
    app.wait_for("当前版本：0.1.0")?;
    app.press("消息")?;
    app.wait_for("搜索成员或消息")?;
    app.set_viewport(Size::new(px(1280.0), px(800.0)))?;
    app.wait_for("搜索成员或消息")?;
    Ok(())
}

#[test]
fn preview_label_matches_build_channel() -> Result<(), String> {
    let mut app = collaboration(480.0, 800.0)?;
    assert_eq!(
        app.shows(PREVIEW_BADGE),
        cfg!(feature = "github-manual-updates")
    );
    if cfg!(feature = "github-manual-updates") {
        app.press("设置")?;
        app.wait_for(PREVIEW_LABEL)?;
    } else {
        assert!(!app.shows(PREVIEW_LABEL));
    }
    Ok(())
}

#[test]
fn enterprise_login_without_configuration_never_claims_success() -> Result<(), String> {
    let mut app = collaboration(480.0, 800.0)?;
    app.press("成员")?;
    app.wait_for("企业账号与成员")?;
    app.press("企业账号与成员")?;
    app.wait_for("企业原生登录尚未配置或平台回调未接入；不会模拟登录成功。")?;
    assert!(!app.shows("已验证登录"));
    Ok(())
}

#[test]
fn opening_media_settings_does_not_enable_capture_or_playback() -> Result<(), String> {
    let mut app = collaboration(480.0, 800.0)?;
    assert!(!app.shows("原生媒体"), "媒体调试不在首屏");
    open_diagnostics(&mut app)?;
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

fn scroll_top(app: &mut Headless) {
    for _ in 0..40 {
        if app
            .scroll("id:conversation-scroll", nsh_core::prelude::px(-180.0))
            .is_err()
        {
            break;
        }
    }
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

#[cfg(not(feature = "github-manual-updates"))]
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
    let mut app = collaboration(480.0, 800.0)?;
    app.press("成员")?;
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

#[test]
fn meeting_page_is_reachable_and_does_not_claim_a_live_session() -> Result<(), String> {
    let mut app = collaboration(1100.0, 760.0)?;
    app.press("会议")?;
    app.wait_for("尚未接入企业会话，无法开始真实会议")?;
    app.wait_for("尚未加入会议，麦克风、摄像头和离开不可用。")?;
    assert!(app.shows("麦克风"));
    assert!(app.shows("摄像头"));
    assert!(app.shows("共享屏幕"));
    assert!(app.shows("离开会议"));
    assert!(!app.shows("正在共享"));
    assert!(!app.shows("停止共享"));
    assert!(app.press("麦克风").is_err());
    assert!(app.press("摄像头").is_err());
    assert!(app.press("离开会议").is_err());
    assert!(!app.shows("创建邀请"));
    assert!(!app.shows("软件更新"));
    assert!(!app.shows("查看连接指纹"));
    Ok(())
}

#[test]
fn share_picker_defaults_to_window_and_keeps_start_disabled() -> Result<(), String> {
    let mut app = collaboration(1100.0, 760.0)?;
    app.press("会议")?;
    app.press("共享屏幕")?;
    app.wait_for("选择要共享的内容")?;
    app.wait_for("尚未接入捕获")?;
    app.wait_for("共享整个屏幕时，通知和其他窗口可能被看到。")?;
    app.wait_for("尚未接入企业会话，无法开始共享")?;
    assert!(
        app.screen().selected("role:button[窗口]")?,
        "共享选择器默认选中窗口"
    );
    assert!(!app.screen().selected("role:button[整个屏幕]")?);
    assert!(
        app.press("开始共享").is_err(),
        "没有真实源和进行中的会议时不能开始共享"
    );
    app.press("整个屏幕")?;
    assert!(app.screen().selected("role:button[整个屏幕]")?);
    assert!(app.press("开始共享").is_err());
    app.press("取消")?;
    app.wait_for_gone("选择要共享的内容", std::time::Duration::from_secs(2))?;
    app.wait_for("尚未接入企业会话，无法开始真实会议")?;
    app.press("共享屏幕")?;
    app.wait_for("选择要共享的内容")?;
    app.back()?;
    app.wait_for_gone("选择要共享的内容", std::time::Duration::from_secs(2))?;
    app.wait_for("尚未接入企业会话，无法开始真实会议")?;
    Ok(())
}

#[cfg(feature = "github-manual-updates")]
#[test]
fn manual_update_preview_opens_and_offers_sources() -> Result<(), String> {
    use nsh_core::prelude::{Size, px};
    let mut app =
        Headless::start(EngineConfig::new(Root::of::<nsh_app_native_client::App>())).unwrap();
    app.set_viewport(Size::new(px(480.0), px(800.0)))?;
    app.wait_for(APP_TITLE)?;
    app.wait_for(PREVIEW_BADGE)?;
    assert!(!app.shows("软件更新"), "更新入口不在首屏");
    app.press("设置")?;
    app.wait_for("软件更新")?;
    app.wait_for(PREVIEW_LABEL)?;
    app.wait_for("本地版本：0.1.0")?;
    app.wait_for("远端版本：未知（尚未成功检查）")?;
    app.wait_for("安装方式：预览版仅下载并校验，需手动安装；不会自动升级。")?;
    app.wait_for("下载来源")?;
    app.wait_for("◉ GitHub")?;
    // 切换下载来源只是单选，不发起网络请求，也不改变检查结果。
    app.press("○ 第三方代理")?;
    app.wait_for("◉ 第三方代理")?;
    app.wait_for("○ GitHub")?;
    app.wait_for("尚未检查。点击“检查更新”联网查询 GitHub Release。")?;
    assert!(app.shows("检查更新"));
    assert!(app.press("下载并校验").is_err(), "未检查出新版本前不能下载");
    for forbidden in ["升级成功", "更新成功"] {
        assert!(!app.shows(forbidden));
    }
    Ok(())
}
