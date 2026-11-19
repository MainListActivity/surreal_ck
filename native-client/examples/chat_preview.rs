//! 开发专用，无身份客户端、网络连接或真实发送，不进入发布产物。
//! cargo run --locked --offline --features desktop --example chat_preview
#[cfg(feature = "desktop")]
#[allow(dead_code)]
#[path = "../src/ui/icons.rs"]
mod icons;

#[cfg(feature = "desktop")]
mod desktop {
    use super::icons::{INK, Icon, MUTED};
    use nsh_app_native_client::enterprise_messages::{
        Action, Delivery, Model, Person, Row, Ui, Update,
    };
    use nsh_base::{button, theme};
    use nsh_core::{platform::Appearance, prelude::*};
    use surreal_ck_native_identity::chat::{ChatMessage, ChatPeer, Conversation, ConversationKind};

    #[cfg(target_os = "linux")]
    use nsh_platform_linux as platform;
    #[cfg(target_os = "macos")]
    use nsh_platform_macos as platform;
    #[cfg(target_os = "windows")]
    use nsh_platform_windows as platform;

    const GROUP: &str = "chat_conversation:design";
    const DIRECT: &str = "chat_conversation:lin";
    const LABEL: &str = "界面预览·示例数据";

    fn message(room: &str, id: &str, sender: &str, body: &str) -> ChatMessage {
        ChatMessage {
            id: format!("chat_message:{id}"),
            conversation: room.into(),
            sender: sender.into(),
            body: body.into(),
            client_id: id.into(),
            created_at: "2026-11-19T10:24:00Z".into(),
        }
    }

    fn rows(room: &str) -> Vec<Row> {
        let mut rows: Vec<Row> = [
            (
                "lin",
                "user:lin",
                "新版聊天和会议的设计稿准备好了，大家一起看一下。",
            ),
            (
                "chen",
                "user:chen",
                "我先确认一下，屏幕共享可以只选一个窗口吗？",
            ),
            (
                "me",
                "user:me",
                "可以，只共享选中的窗口，其他内容不会展示。",
            ),
            ("sending", "user:me", "正在整理本周的设计评审记录。"),
            (
                "failed",
                "user:me",
                "补充说明稍后同步，这是一条模拟发送失败的消息。",
            ),
        ]
        .into_iter()
        .map(|(id, sender, body)| message(room, id, sender, body).into())
        .collect();
        rows[3].delivery = Delivery::Sending;
        rows[4].delivery = Delivery::Failed;
        if room != GROUP {
            rows.retain(|row| row.sender != "user:chen");
        }
        rows
    }

    fn model() -> Model {
        let rows = rows(GROUP);
        Model {
            member_id: "user:me".into(),
            rooms: vec![
                Conversation {
                    id: GROUP.into(),
                    kind: ConversationKind::Group,
                    title: Some("产品设计组".into()),
                    peer: None,
                    last_message: Some(message(
                        GROUP,
                        "group-last",
                        "user:lin",
                        "新版聊天和会议的设计稿准备好了，大家一起看一下。",
                    )),
                    unread_count: 3,
                    member_count: 8,
                },
                Conversation {
                    id: DIRECT.into(),
                    kind: ConversationKind::Direct,
                    title: None,
                    peer: Some(ChatPeer {
                        id: "user:lin".into(),
                        display_name: "林晓".into(),
                    }),
                    last_message: Some(message(
                        DIRECT,
                        "direct-last",
                        "user:lin",
                        "我稍后把修改后的页面发你。",
                    )),
                    unread_count: 2,
                    member_count: 2,
                },
            ],
            people: [
                ("user:me", "周然（我）"),
                ("user:lin", "林晓"),
                ("user:chen", "陈默"),
                ("user:wang", "王琪"),
            ]
            .into_iter()
            .map(|(id, name)| Person {
                id: id.into(),
                name: name.into(),
                pending: false,
            })
            .collect(),
            active: Some(GROUP.into()),
            outbox: rows[3..].to_vec(),
            rows,
            connected: true,
            status: "示例演示 · 不连接服务器，所有发送均为本地模拟".into(),
            more: false,
            ..Model::default()
        }
    }

    fn control(label: &'static str, press: impl Fn() + 'static) -> impl IntoElement {
        button()
            .on_press(press)
            .px_3()
            .py_2()
            .rounded(px(8.0))
            .border_1()
            .border_color(move || theme().border)
            .child(text(label).text_size(px(12.0)))
    }

    fn nav(
        label: &'static str,
        icon: Icon,
        selected: bool,
        press: impl Fn() + 'static,
    ) -> impl IntoElement {
        button()
            .accessibility_label(label)
            .disabled(!selected)
            .on_press(press)
            .w(px(58.0))
            .py_2()
            .gap_1()
            .items_center()
            .rounded(px(12.0))
            .bg(move || {
                if selected {
                    theme().primary
                } else {
                    theme().sidebar
                }
            })
            .disabled_style(|s| s.opacity(0.5))
            .child(icon.view(if selected { INK } else { MUTED }, 22.0))
            .child(text(label).text_size(px(11.0)).text_color(move || {
                if selected {
                    theme().primary_foreground
                } else {
                    theme().muted_foreground
                }
            }))
    }

    #[component]
    fn Preview() -> impl IntoElement {
        if let Ok(tokens) = nsh_base::tokens_of(Some(include_str!("../theme.json"))) {
            nsh_core::element::set_tokens(tokens);
        }
        let show_list = signal(false);
        let target = signal_with(None::<Ui>, SignalEquals::Never);
        let chat = Ui::injected(model(), move |action| {
            if let Some(chat) = target.get_untracked() {
                match action {
                    Action::Open(room) => {
                        chat.state.update(|s| {
                            s.rows = rows(&room);
                            s.outbox = s
                                .rows
                                .iter()
                                .filter(|r| r.delivery != Delivery::Sent)
                                .cloned()
                                .collect();
                            s.more = false;
                            for entry in &mut s.rooms {
                                if entry.id == room {
                                    entry.unread_count = 0;
                                }
                            }
                        });
                        show_list.set(false);
                    }
                    Action::Send {
                        room,
                        body,
                        client_id,
                    } => {
                        let mut receipt = message(&room, "local-receipt", "user:me", &body);
                        receipt.id = format!("chat_message:{client_id}");
                        receipt.client_id = client_id.clone();
                        chat.apply(Update::Receipt(client_id, Ok(receipt)));
                    }
                    Action::Direct(peer) => {
                        let name = chat
                            .state
                            .get_untracked()
                            .people
                            .into_iter()
                            .find(|p| p.id == peer)
                            .map(|p| p.name)
                            .unwrap_or_default();
                        let room = format!("chat_conversation:preview-{peer}");
                        chat.state.update(|s| {
                            if !s.rooms.iter().any(|r| r.id == room) {
                                s.rooms.push(Conversation {
                                    id: room.clone(),
                                    kind: ConversationKind::Direct,
                                    title: None,
                                    peer: Some(ChatPeer {
                                        id: peer,
                                        display_name: name,
                                    }),
                                    last_message: None,
                                    unread_count: 0,
                                    member_count: 2,
                                });
                            }
                        });
                        chat.apply(Update::Opened(room));
                        chat.state.update(|s| s.more = false);
                    }
                    Action::Group(title, members) => {
                        let room = format!(
                            "chat_conversation:preview-group-{}",
                            chat.state.get_untracked().rooms.len()
                        );
                        chat.state.update(|s| {
                            s.rooms.push(Conversation {
                                id: room.clone(),
                                kind: ConversationKind::Group,
                                title: Some(title),
                                peer: None,
                                last_message: None,
                                unread_count: 0,
                                member_count: members.len() as u64 + 1,
                            })
                        });
                        chat.apply(Update::Opened(room));
                        chat.state.update(|s| s.more = false);
                    }
                    _ => {}
                }
                true
            } else {
                false
            }
        });
        target.set(Some(chat));
        let wide = || window().width >= px(960.0);
        view()
            .flex_1()
            .bg(move || theme().background)
            .text_color(move || theme().foreground)
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .p_3()
                    .border_b_1()
                    .border_color(move || theme().border)
                    .child(text(LABEL).font_weight(FontWeight::SEMIBOLD).flex_1())
                    .child(control("浅色", || {
                        nsh_core::element::set_color_scheme(Appearance::Light)
                    }))
                    .child(control("暗色", || {
                        nsh_core::element::set_color_scheme(Appearance::Dark)
                    })),
            )
            .child(
                view()
                    .flex_1()
                    .flex_row()
                    .child(when(wide, move || {
                        view()
                            .w(px(76.0))
                            .py_4()
                            .gap_2()
                            .items_center()
                            .bg(move || theme().sidebar)
                            .border_r_1()
                            .border_color(move || theme().sidebar_border)
                            .child(
                                image(nsh_core::element::ImageSrc::svg_markup(include_str!(
                                    "../assets/brand.svg"
                                )))
                                .w(px(40.0))
                                .h(px(40.0)),
                            )
                            .child(nav("消息", Icon::Chat, true, move || {
                                show_list.set(!show_list.get_untracked())
                            }))
                            .child(nav("会议", Icon::Video, false, || {}))
                            .child(nav("通讯录", Icon::People, false, || {}))
                            .child(view().flex_1())
                            .child(nav("设置", Icon::Gear, false, || {}))
                    }))
                    .child(when(
                        move || wide() || show_list.get(),
                        move || {
                            view()
                                .w(move || if wide() { px(300.0) } else { window().width })
                                .p_4()
                                .border_r_1()
                                .border_color(move || theme().border)
                                .child(chat.list())
                        },
                    ))
                    .child(when(
                        move || wide() || !show_list.get(),
                        move || chat.conversation(),
                    )),
            )
            .child(when(
                move || !wide(),
                move || {
                    view()
                        .flex_row()
                        .justify_around()
                        .p_2()
                        .border_t_1()
                        .border_color(move || theme().border)
                        .bg(move || theme().sidebar)
                        .child(nav("消息", Icon::Chat, true, move || {
                            show_list.set(!show_list.get_untracked())
                        }))
                        .child(nav("会议", Icon::Video, false, || {}))
                        .child(nav("通讯录", Icon::People, false, || {}))
                        .child(nav("设置", Icon::Gear, false, || {}))
                },
            ))
    }

    pub fn run() -> impl std::process::Termination {
        platform::run_app(
            platform::AppSource::Rust(platform::Root::of::<Preview>()),
            platform::AppOptions {
                title: format!("吉吉 · {LABEL}"),
                size: (1100, 820),
                ..Default::default()
            },
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use nsh_engine::{EngineConfig, Root};
        use nsh_testing::Headless;

        #[test]
        fn sample_rows_keep_direct_participants_and_pending_delivery_separate() {
            let state = model();
            assert_eq!(state.rooms.len(), 2);
            assert_eq!(state.outbox.len(), 2);
            assert!(state.rooms.iter().all(|r| r.unread_count > 0));
            let direct = rows(DIRECT);
            assert!(
                direct
                    .iter()
                    .all(|r| r.sender == "user:lin" || r.sender == "user:me")
            );
            assert_eq!(
                direct
                    .iter()
                    .filter(|r| r.delivery == Delivery::Failed)
                    .count(),
                1
            );
        }

        #[test]
        fn conversation_heading_keeps_its_line_box_and_reactive_color() -> Result<(), String> {
            for width in [1100.0, 480.0] {
                let mut app = Headless::start(EngineConfig::new(Root::of::<Preview>())).unwrap();
                app.set_viewport(Size::new(px(width), px(820.0)))?;
                if width < 960.0 {
                    app.press("消息")?;
                }
                let mut colors = Vec::new();
                for mode in ["浅色", "暗色", "浅色"] {
                    app.press(mode)?;
                    app.wait_for("id:conversation-heading")?;
                    let style = app
                        .screen()
                        .span_style("id:conversation-heading >> text:消息")?;
                    assert_eq!(style.font_size, px(22.0));
                    assert_eq!(style.line_height, px(30.0));
                    colors.push(style.color);
                }
                assert_ne!(colors[0], colors[1]);
                assert_eq!(colors[0], colors[2]);
            }
            Ok(())
        }

        #[test]
        fn preview_uses_real_chat_controls_for_empty_search_dialogs_and_local_retry()
        -> Result<(), String> {
            let mut app = Headless::start(EngineConfig::new(Root::of::<Preview>())).unwrap();
            app.set_viewport(Size::new(px(1100.0), px(820.0)))?;
            app.wait_for(LABEL)?;
            app.wait_for("我先确认一下，屏幕共享可以只选一个窗口吗？")?;
            app.press("林晓 · 2 未读")?;
            app.wait_for_gone(
                "我先确认一下，屏幕共享可以只选一个窗口吗？",
                std::time::Duration::from_secs(2),
            )?;
            app.wait_for("新版聊天和会议的设计稿准备好了，大家一起看一下。")?;
            app.wait_for("10:24 发送失败，可重发")?;
            app.press("重发")?;
            app.wait_for_gone("10:24 发送失败，可重发", std::time::Duration::from_secs(2))?;
            app.type_text("text:搜索成员或消息", "没有这样的会话")?;
            app.wait_for("没有匹配的会话")?;
            app.press("新建")?;
            app.wait_for("新建对话")?;
            assert!(app.press("创建对话").is_err());
            app.press("群聊模式")?;
            app.wait_for("text:群聊标题")?;
            app.type_text("text:群聊标题", "预览测试群")?;
            app.press("id:new-conversation-dialog >> 王琪")?;
            app.press("id:new-conversation-dialog >> 陈默")?;
            app.press("创建对话")?;
            app.wait_for("预览测试群 · 3 人")?;
            app.press("新建")?;
            app.press("取消新建")?;
            app.wait_for_gone("新建对话", std::time::Duration::from_secs(2))?;
            app.set_viewport(Size::new(px(480.0), px(820.0)))?;
            app.wait_for("会议")?;
            app.press("消息")?;
            app.wait_for("id:conversation-heading")?;
            Ok(())
        }
    }
}

#[cfg(feature = "desktop")]
fn main() -> impl std::process::Termination {
    desktop::run()
}

#[cfg(not(feature = "desktop"))]
fn main() {
    eprintln!("此示例需要 --features desktop");
}
