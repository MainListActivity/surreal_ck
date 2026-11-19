use nsh_app_native_client::enterprise_messages::{
    Action as ChatAction, Model as ChatModel, Person, Ui as ChatUi, Update as ChatUpdate,
};
use nsh_core::prelude::*;
use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;
use std::sync::Arc;
use surreal_ck_native_identity::chat::{
    ChatError, ChatMessage, ChatPeer, ChatSnapshot, ChatStatus, Conversation, ConversationKind,
};
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
const SEARCH: &str = "搜索成员或消息";
const OFFLINE: &str = "未连接";
const PREVIEW_BADGE: &str = "实验预览版";
const PREVIEW_LABEL: &str = "实验预览版 · 非正式发布，功能仍在验证，请勿用于正式工作";

fn collaboration(width: f32, height: f32) -> Result<Headless, String> {
    use nsh_core::prelude::{Size, px};
    let mut app = Headless::start(EngineConfig::new(Root::of::<
        nsh_app_native_client::Collaboration,
    >()))
    .unwrap();
    app.set_viewport(Size::new(px(width), px(height)))?;
    app.wait_for(SEARCH)?;
    Ok(app)
}

#[test]
fn selected_navigation_uses_the_app_theme_from_cold_start() -> Result<(), String> {
    use nsh_core::{Color, MountItem};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    let mounted = Arc::new(Mutex::new((HashMap::new(), HashMap::new())));
    let observed = mounted.clone();
    let mut app = Headless::start(EngineConfig::new(Root::of::<
        nsh_app_native_client::Collaboration,
    >()))
    .unwrap();
    app.observe(move |_, batch| {
        let mut mounted = observed.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::ViewProps { id, props } => {
                    mounted.0.insert(*id, props.accessibility.clone());
                }
                MountItem::ViewStyle { id, style } => {
                    mounted.1.insert(*id, style.background_color);
                }
                _ => {}
            }
        }
    });
    app.wait_for(SEARCH)?;
    let tokens = nsh_base::tokens_of(Some(include_str!("../theme.json")))?;
    let segment = app.screen().press_target("全部")?.unwrap();
    assert_eq!(
        mounted.lock().unwrap().1.get(&segment),
        Some(&Color::from(tokens.color("card").unwrap().light)),
        "分段控件应使用应用主题卡片色"
    );
    let expected = Color::from(tokens.color("primary").unwrap().light);
    for label in ["消息", "会议", "通讯录", "设置"] {
        if label != "消息" {
            app.press(label)?;
        }
        let mounted = mounted.lock().unwrap();
        let selected: Vec<_> = mounted
            .0
            .iter()
            .filter(|(_, a)| a.label.as_deref() == Some(label) && a.state.selected)
            .collect();
        assert!(!selected.is_empty(), "没有选中的导航项：{label}");
        for (id, _) in selected {
            assert_eq!(
                mounted.1.get(id),
                Some(&expected),
                "{label} 应使用主题选中色"
            );
        }
    }
    Ok(())
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
    app.wait_for(OFFLINE)?;
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
        app.wait_for("还没有团队会话")?;
        app.wait_for("企业登录尚未配置")?;
        app.wait_for("选择一个会话开始聊天")?;
        app.wait_for("企业消息保存在工作区，选择会话后加载历史记录。")?;
        // 首屏不再复述工程约束。
        for engineering in ["不会模拟登录", "不会生成示例联系人或聊天记录。"] {
            assert!(!app.screen().texts().join("\n").contains(engineering));
        }
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
        assert!(
            !app.shows("断开并停止媒体"),
            "未连接且没有媒体时不在首屏常驻停止按钮"
        );
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
    app.wait_for(OFFLINE)?;
    Ok(())
}

fn chat_rooms() -> Vec<Conversation> {
    vec![
        Conversation {
            id: "chat_conversation:direct".into(),
            kind: ConversationKind::Direct,
            title: None,
            peer: Some(ChatPeer {
                id: "user:b".into(),
                display_name: "柏林".into(),
            }),
            last_message: Some(chat_message("chat_conversation:direct", "last", "上条私聊")),
            unread_count: 2,
            member_count: 2,
        },
        Conversation {
            id: "chat_conversation:group".into(),
            kind: ConversationKind::Group,
            title: Some("研发组".into()),
            peer: None,
            last_message: Some(chat_message(
                "chat_conversation:group",
                "group-last",
                "群内消息",
            )),
            unread_count: 0,
            member_count: 3,
        },
    ]
}
fn chat_message(room: &str, id: &str, body: &str) -> ChatMessage {
    ChatMessage {
        id: format!("chat_message:{id}"),
        conversation: room.into(),
        sender: "user:b".into(),
        body: body.into(),
        client_id: id.into(),
        created_at: "2026-01-01T12:34:00Z".into(),
    }
}
#[component]
fn EnterpriseChatFixture() -> impl IntoElement {
    let model = ChatModel {
        member_id: "user:a".into(),
        rooms: chat_rooms(),
        people: vec![
            Person {
                id: "user:b".into(),
                name: "柏林".into(),
                pending: false,
            },
            Person {
                id: "user:c".into(),
                name: "陈辰".into(),
                pending: false,
            },
        ],
        connected: true,
        status: "企业聊天已连接".into(),
        ..ChatModel::default()
    };
    let (send, actions) = async_channel::bounded::<ChatAction>(16);
    let ui = ChatUi::injected(model, move |action| send.try_send(action).is_ok());
    let retry_verified = signal(false);
    let pending_receipt = signal(None::<String>);
    spawn(async move {
        let mut first_client = None;
        while let Ok(action) = actions.recv().await {
            match action {
                ChatAction::Open(room) => {
                    let mut rooms = ui.state.get_untracked().rooms;
                    for entry in &mut rooms {
                        if entry.id == room {
                            entry.unread_count = 0;
                        }
                    }
                    ui.apply(ChatUpdate::Snapshot(Arc::new(ChatSnapshot {
                        member_id: "user:a".into(),
                        conversations: rooms,
                    })));
                    ui.apply(ChatUpdate::History(
                        room.clone(),
                        vec![chat_message(&room, "history", "历史消息")],
                        true,
                    ));
                }
                ChatAction::Send {
                    room,
                    body,
                    client_id,
                } => {
                    if let Some(first) = &first_client {
                        retry_verified.set(first == &client_id);
                        let mut receipt = chat_message(&room, "receipt", &body);
                        receipt.sender = "user:a".into();
                        receipt.client_id = client_id.clone();
                        ui.apply(ChatUpdate::Receipt(client_id, Ok(receipt)));
                    } else {
                        first_client = Some(client_id.clone());
                        pending_receipt.set(Some(client_id));
                    }
                }
                ChatAction::Direct(peer) => {
                    let mut rooms = ui.state.get_untracked().rooms;
                    let room = "chat_conversation:new".to_owned();
                    rooms.push(Conversation {
                        id: room.clone(),
                        kind: ConversationKind::Direct,
                        title: None,
                        peer: Some(ChatPeer {
                            id: peer,
                            display_name: "陈辰".into(),
                        }),
                        last_message: None,
                        unread_count: 0,
                        member_count: 2,
                    });
                    ui.apply(ChatUpdate::Snapshot(Arc::new(ChatSnapshot {
                        member_id: "user:a".into(),
                        conversations: rooms,
                    })));
                    ui.apply(ChatUpdate::Opened(room));
                }
                ChatAction::Group(title, members) => {
                    let mut rooms = ui.state.get_untracked().rooms;
                    let room = "chat_conversation:new-group".to_owned();
                    rooms.push(Conversation {
                        id: room.clone(),
                        kind: ConversationKind::Group,
                        title: Some(title),
                        peer: None,
                        last_message: None,
                        unread_count: 0,
                        member_count: members.len() as u64 + 1,
                    });
                    ui.apply(ChatUpdate::Snapshot(Arc::new(ChatSnapshot {
                        member_id: "user:a".into(),
                        conversations: rooms,
                    })));
                    ui.apply(ChatUpdate::Opened(room));
                }
                _ => {}
            }
        }
    });
    view()
        .flex_1()
        .child(
            view()
                .flex_row()
                .flex_1()
                .child(view().w(px(300.0)).child(ui.list()))
                .child(ui.conversation()),
        )
        .child(text(move || {
            if retry_verified.get() {
                "重发沿用同一 client_id"
            } else {
                ""
            }
        }))
        .child(
            nsh_base::button()
                .on_press(move || {
                    let state = ui.state.get_untracked();
                    let Some(row) = state.outbox.first() else {
                        return;
                    };
                    let mut confirmed = chat_message(&row.room, "persisted", &row.body);
                    confirmed.sender = row.sender.clone();
                    confirmed.client_id = row.client_id.clone();
                    let room = row.room.clone();
                    let client = row.client_id.clone();
                    ui.apply(ChatUpdate::Status(ChatStatus::Reconnecting));
                    ui.apply(ChatUpdate::Receipt(client.clone(), Err(ChatError::Timeout)));
                    ui.apply(ChatUpdate::Opened("chat_conversation:other".into()));
                    ui.apply(ChatUpdate::Status(ChatStatus::Connected));
                    ui.apply(ChatUpdate::Opened(room.clone()));
                    ui.apply(ChatUpdate::History(room, vec![confirmed], true));
                    ui.apply(ChatUpdate::Receipt(client, Err(ChatError::Timeout)));
                    assert!(ui.state.get_untracked().outbox.is_empty());
                })
                .child(text("模拟落库成功后超时重连重开")),
        )
        .child(
            nsh_base::button()
                .on_press(move || {
                    if let Some(client_id) = pending_receipt.get_untracked() {
                        ui.apply(ChatUpdate::Receipt(client_id, Err(ChatError::Timeout)));
                    }
                })
                .child(text("模拟发送失败")),
        )
        .child(
            nsh_base::button()
                .on_press(move || ui.apply(ChatUpdate::Status(ChatStatus::Reconnecting)))
                .child(text("模拟重连")),
        )
        .child(
            nsh_base::button()
                .on_press(move || {
                    ui.apply(ChatUpdate::Status(ChatStatus::Ended(ChatError::Expired)))
                })
                .child(text("模拟过期")),
        )
}
fn enterprise_fixture() -> Result<Headless, String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<EnterpriseChatFixture>())).unwrap();
    app.set_viewport(Size::new(px(1100.0), px(900.0)))?;
    app.wait_for("上条私聊 · 12:34")?;
    Ok(app)
}
#[test]
fn enterprise_chat_lists_filters_and_searches_real_snapshot() -> Result<(), String> {
    let mut app = enterprise_fixture()?;
    app.wait_for("柏林 · 2 未读")?;
    app.wait_for("研发组 · 3 人")?;
    app.press("群聊")?;
    assert!(!app.shows("柏林 · 2 未读"));
    app.wait_for("研发组 · 3 人")?;
    app.press("未读")?;
    app.wait_for("柏林 · 2 未读")?;
    assert!(!app.shows("研发组 · 3 人"));
    app.press("全部")?;
    app.type_text("text:搜索成员或消息", "研发")?;
    app.wait_for("研发组 · 3 人")?;
    assert!(!app.shows("柏林 · 2 未读"));
    app.clear("text:研发")?;
    app.type_text("text:搜索成员或消息", "3")?;
    app.wait_for("没有匹配的会话")?;
    assert!(!app.shows("研发组 · 3 人"));
    Ok(())
}
#[test]
fn enterprise_chat_marks_read_and_retries_same_client_id() -> Result<(), String> {
    let mut app = enterprise_fixture()?;
    app.press("柏林 · 2 未读")?;
    app.wait_for("历史消息")?;
    assert!(!app.shows("柏林 · 2 未读"));
    app.type_text("text:输入消息，Enter 发送", "你好")?;
    app.press("发送消息")?;
    app.wait_for("发送中…")?;
    app.press("模拟发送失败")?;
    app.wait_for("发送失败，可重发")?;
    app.press("重发")?;
    app.wait_for("12:34 已送出")?;
    app.wait_for("重发沿用同一 client_id")?;
    assert!(!app.shows("发送失败，可重发"));
    Ok(())
}

#[test]
fn enterprise_chat_persisted_message_wins_after_timeout_reconnect_and_reopen() -> Result<(), String>
{
    let mut app = enterprise_fixture()?;
    app.press("柏林 · 2 未读")?;
    app.wait_for("历史消息")?;
    app.type_text("text:输入消息，Enter 发送", "已落库但回执丢失")?;
    app.press("发送消息")?;
    app.wait_for("发送中…")?;
    app.press("模拟落库成功后超时重连重开")?;
    app.wait_for("已落库但回执丢失")?;
    app.wait_for("12:34 已送出")?;
    assert!(!app.shows("发送失败，可重发"));
    assert!(!app.shows("重发"));
    Ok(())
}

#[component]
fn WindowReadFixture() -> impl IntoElement {
    let messages = signal(true);
    view()
        .child(text(move || {
            if nsh_app_native_client::enterprise_messages::readable(messages.get()) {
                "允许推进已读"
            } else {
                "后台保留未读"
            }
        }))
        .child(
            nsh_base::button()
                .on_press(move || messages.set(false))
                .child(text("离开消息页")),
        )
}
#[test]
fn enterprise_chat_requires_active_visible_window_to_advance_read_cursor() -> Result<(), String> {
    use nsh_core::platform::Lifecycle;
    let mut app = Headless::start(EngineConfig::new(Root::of::<WindowReadFixture>())).unwrap();
    app.wait_for("允许推进已读")?;
    for state in [
        Lifecycle::Inactive,
        Lifecycle::Background,
        Lifecycle::Active,
    ] {
        app.set_environment("window lifecycle", |env| env.lifecycle = state)?;
        app.wait_for(if state == Lifecycle::Active {
            "允许推进已读"
        } else {
            "后台保留未读"
        })?;
    }
    app.press("离开消息页")?;
    app.wait_for("后台保留未读")?;
    Ok(())
}

#[test]
fn enterprise_chat_creates_group_with_selected_members() -> Result<(), String> {
    let mut app = enterprise_fixture()?;
    app.press("新建")?;
    app.press("群聊模式")?;
    assert!(app.press("创建对话").is_err());
    app.press("id:new-conversation-dialog >> 柏林")?;
    app.press("id:new-conversation-dialog >> 陈辰")?;
    assert!(app.press("创建对话").is_err());
    app.type_text("text:群聊标题", &"群".repeat(201))?;
    assert!(app.press("创建对话").is_err());
    app.clear(&format!("text:{}", "群".repeat(201)))?;
    app.type_text("text:群聊标题", "远程协作")?;
    app.press("创建对话")?;
    app.wait_for("远程协作 · 3 人")?;
    assert!(!app.shows("新建对话"));
    Ok(())
}
#[test]
fn enterprise_chat_new_direct_and_terminal_states_are_honest() -> Result<(), String> {
    let mut app = enterprise_fixture()?;
    app.press("新建")?;
    app.wait_for("新建对话")?;
    app.press("id:new-conversation-dialog >> 陈辰")?;
    app.press("创建对话")?;
    app.wait_for("陈辰")?;
    assert!(!app.shows("新建对话"));
    app.press("模拟重连")?;
    app.wait_for("连接中断，正在重连并同步消息…")?;
    app.type_text("text:输入消息，Enter 发送", "不能发送")?;
    assert!(app.press("发送消息").is_err());
    app.press("模拟过期")?;
    app.wait_for("聊天会话已过期，请重新登录")?;
    assert!(app.press("发送消息").is_err());
    Ok(())
}
#[test]
fn enterprise_chat_expiry_fails_pending_send_without_faking_receipt() -> Result<(), String> {
    let mut app = enterprise_fixture()?;
    app.press("柏林 · 2 未读")?;
    app.wait_for("历史消息")?;
    app.type_text("text:输入消息，Enter 发送", "待确认消息")?;
    app.press("发送消息")?;
    app.wait_for("发送中…")?;
    app.press("模拟过期")?;
    app.wait_for("发送失败，可重发")?;
    assert!(app.press("重发").is_err());
    assert!(!app.shows("12:34 已送出"));
    Ok(())
}
#[test]
fn local_insecure_identity_fixture_is_not_a_production_configuration() {
    use surreal_ck_native_identity::{IdentityConfig, SurrealConfig};
    assert!(
        IdentityConfig::new(
            "http://127.0.0.1:9876",
            "http://127.0.0.1:9877",
            "native-local",
            "local",
            "http://127.0.0.1:43123/auth/callback"
        )
        .is_err()
    );
    assert!(SurrealConfig::new("ws://127.0.0.1:8000/rpc", "local").is_err());
}

#[test]
fn settings_and_diagnostics_hold_security_tools() -> Result<(), String> {
    let mut app = collaboration(480.0, 800.0)?;
    app.press("设置")?;
    app.wait_for("当前版本：0.1.0")?;
    app.wait_for(APP_TITLE)?;
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
    app.press("通讯录")?;
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
    assert!(!app.screen().enabled("允许远端音频")?);
    scroll_to(&mut app, "远端音频：关闭")?;
    scroll_to(&mut app, "远端视频：关闭")?;
    let video_supported = (cfg!(target_os = "linux")
        || cfg!(all(
            target_os = "macos",
            feature = "experimental-macos-video"
        ))
        || cfg!(all(
            target_os = "windows",
            feature = "experimental-windows-video"
        )))
        && surreal_ck_native_video_view::rendering_supported();
    if video_supported {
        scroll_to(&mut app, "允许远端视频")?;
        assert!(!app.screen().enabled("允许远端视频")?);
    } else {
        scroll_to(
            &mut app,
            "此平台尚未实现原生视频纹理，不能接收显示远端视频；不会用占位图冒充视频。",
        )?;
        assert!(!app.shows("允许远端视频"));
    }
    app.wait_for("麦克风 · 未启用")?;
    app.wait_for("摄像头 · 未启用")?;
    app.wait_for("屏幕共享 · 未启用")?;
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
    app.press("通讯录")?;
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
    app.wait_for("开始新会议")?;
    app.wait_for("当前没有进行中的会议")?;
    app.wait_for("此版本未接入企业登录，暂时不能发起或加入会议。")?;
    assert!(app.press("开始").is_err(), "会议能力接入前不能开始会议");
    assert!(app.press("加入").is_err(), "会议能力接入前不能加入会议");
    for missing in [
        "正在共享",
        "停止共享",
        "离开会议",
        "创建邀请",
        "软件更新",
        "查看连接指纹",
    ] {
        assert!(!app.shows(missing), "{missing} 不应出现在会议首页");
    }
    app.press("消息")?;
    app.wait_for(SEARCH)?;
    app.wait_for("选择一个会话开始聊天")?;
    Ok(())
}

#[cfg(feature = "github-manual-updates")]
#[test]
fn manual_update_preview_opens_and_offers_sources() -> Result<(), String> {
    use nsh_core::prelude::{Size, px};
    let mut app =
        Headless::start(EngineConfig::new(Root::of::<nsh_app_native_client::App>())).unwrap();
    app.set_viewport(Size::new(px(480.0), px(800.0)))?;
    app.wait_for(SEARCH)?;
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
