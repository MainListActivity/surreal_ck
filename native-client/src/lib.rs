//! Surreal 协作客户端：NSH 原生界面，无 WebView。
#[cfg(all(target_os = "android", feature = "android-native-media"))]
mod android_call_bridge;
#[cfg(all(target_os = "android", feature = "android-auto-update"))]
pub mod android_documents;
#[cfg(all(target_os = "android", feature = "android-native-oauth"))]
pub mod android_oauth;
mod bridge;
mod call_bridge;
mod call_ui;
#[cfg(feature = "experimental-enterprise-files")]
mod enterprise_file_tools;
#[cfg(feature = "experimental-enterprise-files")]
mod enterprise_files;
#[cfg(feature = "experimental-enterprise-signaling")]
pub mod enterprise_peer;
#[cfg(feature = "experimental-enterprise-media")]
mod enterprise_tools;
mod file_dialogs;
mod file_ui;
mod first_screen;
#[cfg(feature = "github-manual-updates")]
mod github_update_ui;
mod identity_ui;
pub mod model;
mod network_config;
mod network_ui;
#[cfg_attr(feature = "github-manual-updates", allow(dead_code))]
mod startup;
mod ui;
mod verification_ui;
use bridge::{Command, Update};
use nsh_base::theme;
use nsh_core::prelude::*;
#[native_module("surreal-collaboration/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
    registry.assets(assets!());
}
#[cfg(target_os = "linux")]
#[nsh_core::element::native_components(linux)]
fn video_components(components: &surreal_ck_native_video_view::linux::Components) {
    surreal_ck_native_video_view::linux::register(components);
}
// 实验目标宿主必须与Cargo feature、手写入口注册及renderer门闩同时启用。
#[cfg(all(target_os = "macos", feature = "experimental-macos-video"))]
#[nsh_core::element::native_components(macos)]
fn video_components(components: &surreal_ck_native_video_view::macos::Components) {
    surreal_ck_native_video_view::macos::register(components);
}
#[cfg(all(target_os = "windows", feature = "experimental-windows-video"))]
#[nsh_core::element::native_components(windows)]
fn video_components(components: &surreal_ck_native_video_view::windows::Components) {
    surreal_ck_native_video_view::windows::register(components);
}
#[cfg(feature = "github-manual-updates")]
fn update_panel() -> impl IntoElement {
    github_update_ui::github_update_panel()
}
#[cfg(not(feature = "github-manual-updates"))]
fn update_panel() -> impl IntoElement {
    view()
}
#[component]
pub fn Collaboration() -> impl IntoElement {
    use first_screen::{ConversationFilter, Page, Session, ShareKind};
    use ui::DockKind;
    use ui::icons::{INK, Icon};
    apply_theme();
    let page = signal(Page::Messages);
    let draft = signal(String::new());
    let remote = signal(String::new());
    let local = signal(String::new());
    let connected = signal(false);
    let busy = signal(false);
    let sending = signal(false);
    let status = signal("离线".to_owned());
    let session = signal(Session::Offline);
    let identity = signal(first_screen::IdentitySummary::default());
    let messages = signal(Vec::<first_screen::Message>::new());
    let query = signal(String::new());
    let filter = signal(ConversationFilter::All);
    let share = signal(first_screen::SharePicker::default());
    let (commands, updates, verification_gate) = bridge::start();
    let verification = verification_ui::VerificationUi::new(verification_gate, connected, busy);
    let verification_commands = commands.clone();
    let network = network_ui::NetworkUi::new();
    let network_commands = commands.clone();
    let files = file_ui::Files::new();
    let call = call_ui::CallUi::new();
    let call_commands = commands.clone();
    cleanup(move || files.cleanup());
    let file_commands = commands.clone();
    let cleanup_commands = commands.clone();
    cleanup(move || {
        cleanup_commands.close();
    });
    spawn(async move {
        while let Ok(update) = updates.recv().await {
            verification.sync();
            match update {
                Update::Verification(notice) => verification.event(notice),
                Update::Media(event) => call.event(event),
                Update::FileOffered(id) => files.offered(id),
                Update::File(event) => files.event(event),
                Update::Code(code) => {
                    local.set(code);
                    busy.set(false);
                    status.set("连接码已生成，请复制给对方。".into());
                }
                Update::DirectFailed => network.direct_failed(),
                Update::Connected(mode) => {
                    connected.set(true);
                    busy.set(false);
                    session.set(Session::Connected);
                    status.set(mode.label().into());
                }
                Update::Text(text) => messages.update(|m| first_screen::received(m, text)),
                Update::Queued(text) => {
                    sending.set(false);
                    if draft.get_untracked() == text {
                        draft.set(String::new());
                    }
                    messages.update(|m| first_screen::queued(m, &text));
                }
                Update::Status(s) => {
                    if s == "failed" || s == "disconnected" || s == "closed" {
                        connected.set(false);
                        busy.set(false);
                        session.set(if s == "failed" {
                            Session::Failed(format!("连接状态 {s}"))
                        } else {
                            Session::Offline
                        });
                    }
                    status.set(format!("连接状态：{s}"));
                }
                Update::Error(s) => {
                    files.failed();
                    sending.set(false);
                    busy.set(false);
                    messages.update(|m| first_screen::failed(m));
                    if !connected.get_untracked() {
                        session.set(Session::Failed(s.clone()));
                    }
                    status.set(format!("失败：{s}"));
                }
                Update::Closed => {
                    files.disconnected();
                    call.disconnected();
                    sending.set(false);
                    busy.set(false);
                    connected.set(false);
                    messages.update(|m| first_screen::failed(m));
                    session.set(Session::Offline);
                    status.set("离线".into());
                }
            }
        }
    });
    let offer = commands.clone();
    let answer = commands.clone();
    let accept = commands.clone();
    let send = commands.clone();
    let emergency_close = commands.clone();
    let close = commands;
    let send_message = std::rc::Rc::new(move || {
        let text = draft.get_untracked();
        if !connected.get_untracked() || sending.get_untracked() || text.trim().is_empty() {
            return;
        }
        sending.set(true);
        messages.update(|m| first_screen::pending(m, text.clone()));
        if send.try_send(Command::Send(text)).is_err() {
            sending.set(false);
            messages.update(|m| first_screen::failed(m));
            status.set("发送队列已满，请重试".into());
        }
    });
    let submit_message = send_message.clone();
    let wide = || window().width >= px(960.0);
    let in_meeting = move || page.get() == Page::Meeting;
    let conversation_list = move || {
        let visible = move || {
            first_screen::visible_conversations(connected.get(), &query.get(), filter.get())
        };
        view()
            .gap_4()
            .child(
                text("消息")
                    .text_size(px(24.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .test_id("conversation-heading"),
            )
            .child(ui::field(query, first_screen::SEARCH_PLACEHOLDER))
            .child(
                view()
                    .flex_row()
                    .gap_2()
                    .child(ui::chip(
                        ConversationFilter::All.label(),
                        move || filter.get() == ConversationFilter::All,
                        move || filter.set(ConversationFilter::All),
                    ))
                    .child(ui::chip(
                        ConversationFilter::Unread.label(),
                        move || filter.get() == ConversationFilter::Unread,
                        move || filter.set(ConversationFilter::Unread),
                    ))
                    .child(ui::chip(
                        ConversationFilter::Group.label(),
                        move || filter.get() == ConversationFilter::Group,
                        move || filter.set(ConversationFilter::Group),
                    )),
            )
            .child(ui::note(move || identity.get().line()))
            .child(
                text(move || session.get().line())
                    .test_id("session-state")
                    .text_size(px(13.0))
                    .text_color(move || theme().muted_foreground),
            )
            .child(when(
                move || visible().is_empty(),
                move || {
                    view()
                        .p_4()
                        .gap_2()
                        .rounded(px(10.0))
                        .bg(move || theme().muted)
                        .child(ui::note(move || {
                            if connected.get() {
                                first_screen::filter_empty_placeholder(filter.get(), &query.get())
                            } else {
                                first_screen::conversation_placeholder(&identity.get(), 0)
                                    .unwrap_or_default()
                            }
                        }))
                },
            ))
            .child(when(
                move || !visible().is_empty(),
                move || {
                    view()
                        .p_4()
                        .gap_1()
                        .rounded(px(10.0))
                        .bg(move || theme().muted)
                        .child(text(move || {
                            visible()
                                .first()
                                .map(|conversation| conversation.title.clone())
                                .unwrap_or_default()
                        }))
                        .child(ui::note(move || session.get().line()))
                },
            ))
    };
    // 消息页：会话栏 + 气泡记录 + 底部输入，空状态保持诚实。
    let messages_page = view()
        .flex_1()
        .style_when(move || page.get() != Page::Messages, |style| style.hidden())
        .child(
            view()
                .flex_row()
                .items_center()
                .justify_between()
                .px_5()
                .py_4()
                .border_b_1()
                .border_color(move || theme().border)
                .child(
                    view()
                        .gap_1()
                        .child(
                            text(move || {
                                if connected.get() {
                                    first_screen::direct_conversation().title
                                } else {
                                    first_screen::NO_CONVERSATION.to_owned()
                                }
                            })
                            .text_size(px(22.0))
                            .font_weight(FontWeight::SEMIBOLD),
                        )
                        .child(ui::note(move || {
                            if connected.get() {
                                session.get().line()
                            } else {
                                identity.get().line()
                            }
                        })),
                )
                .child(when(first_screen::is_preview, || {
                    ui::badge(first_screen::PREVIEW_BADGE)
                })),
        )
        .child(when(move || !wide(), conversation_list))
        .child(when(
            move || messages.get().is_empty(),
            || {
                view()
                    .flex_1()
                    .px_5()
                    .py_4()
                    .child(ui::note(|| first_screen::EMPTY_MESSAGES.to_owned()))
            },
        ))
        .child(
            virtual_list(
                move || messages.get().len(),
                move |at| {
                    let index = at.index();
                    view()
                        .flex_row()
                        .px_5()
                        .py_2()
                        .style_when(
                            move || {
                                messages
                                    .get()
                                    .get(index)
                                    .map(|message| message.mine)
                                    .unwrap_or(false)
                            },
                            |style| style.justify_end(),
                        )
                        .child(
                            view()
                                .label(move || {
                                    messages
                                        .get()
                                        .get(index)
                                        .map(|message| message.label())
                                        .unwrap_or_default()
                                })
                                .max_w(px(480.0))
                                .px_4()
                                .py_3()
                                .gap_1()
                                .rounded(px(10.0))
                                .bg(move || {
                                    if messages
                                        .get()
                                        .get(index)
                                        .map(|message| message.mine)
                                        .unwrap_or(false)
                                    {
                                        theme().primary
                                    } else {
                                        theme().muted
                                    }
                                })
                                .child(
                                    text(move || {
                                        messages
                                            .get()
                                            .get(index)
                                            .map(|message| message.text.clone())
                                            .unwrap_or_default()
                                    })
                                    .text_size(px(15.0)),
                                )
                                .child(
                                    text(move || {
                                        messages
                                            .get()
                                            .get(index)
                                            .and_then(|message| message.status().map(str::to_owned))
                                            .unwrap_or_default()
                                    })
                                    .text_size(px(12.0))
                                    .text_color(move || theme().muted_foreground)
                                    .style_when(
                                        move || {
                                            messages
                                                .get()
                                                .get(index)
                                                .map(|message| !message.mine)
                                                .unwrap_or(true)
                                        },
                                        |style| style.hidden(),
                                    ),
                                ),
                        )
                },
            )
            .estimated_item_size(px(72.0))
            .flex_1(),
        )
        .child(
            view().px_5().py_4().child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .border_1()
                    .border_color(move || theme().input)
                    .rounded(px(12.0))
                    .child(ui::icon_action(
                        "附件尚未接入",
                        Icon::Attach,
                        INK,
                        || true,
                        || {},
                    ))
                    .child(ui::icon_action(
                        "表情尚未接入",
                        Icon::Emoji,
                        INK,
                        || true,
                        || {},
                    ))
                    .child(ui::composer(
                        draft,
                        first_screen::COMPOSER_PLACEHOLDER,
                        move || submit_message(),
                    ))
                    .child(ui::send_control(
                        first_screen::SEND_LABEL,
                        move || !connected.get() || sending.get() || draft.get().trim().is_empty(),
                        move || send_message(),
                    )),
            ),
        );
    let emergency_meeting = emergency_close.clone();
    // 会议页：深色舞台与底部坞；控件默认禁用，不假装正在开会或共享。
    let meeting_page = view()
        .flex_1()
        .bg(rgb(0x161513).to_hsla())
        .style_when(move || page.get() != Page::Meeting, |style| style.hidden())
        .child(
            view()
                .flex_row()
                .items_center()
                .px_4()
                .py_3()
                .gap_3()
                .border_b_1()
                .border_color(rgb(0x2A2825).to_hsla())
                .child(
                    view()
                        .gap_1()
                        .child(
                            text("会议")
                                .text_size(px(22.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(rgb(0xFAF9F6).to_hsla()),
                        )
                        .child(
                            text(first_screen::MEETING_EMPTY_STAGE)
                                .text_size(px(12.0))
                                .text_color(rgb(0xB8B2A8).to_hsla()),
                        ),
                )
                .child(view().flex_1())
                .child(call.privacy_on_dark())
                .child(ui::secondary_on_dark(
                    "断开并停止媒体",
                    move || !connected.get() && !busy.get() && !call.needs_stop(),
                    move || {
                        verification.cancel();
                        if emergency_meeting.try_send(Command::Close).is_ok() {
                            network.reset();
                            connected.set(false);
                            busy.set(true);
                            session.set(Session::Offline);
                            status.set("正在关闭连接和媒体，等待设备确认…".into());
                        } else {
                            status.set("关闭请求尚未送达，请重试；设备状态未改变。".into());
                        }
                    },
                ))
                .child(when(first_screen::is_preview, || {
                    ui::badge(first_screen::PREVIEW_BADGE)
                }))
                .child(ui::toolbar_item("布局", Icon::Layout, || true, || {}))
                .child(ui::toolbar_item("全屏", Icon::Fullscreen, || true, || {})),
        )
        .child(
            view()
                .flex_1()
                .flex_row()
                .child(
                    view().flex_1().items_center().justify_center().child(
                        text(first_screen::MEETING_EMPTY_STAGE)
                            .text_size(px(18.0))
                            .text_color(rgb(0xFAF9F6).to_hsla()),
                    ),
                )
                .child(
                    view()
                        .w(px(200.0))
                        .gap_2()
                        .p_3()
                        .border_l_1()
                        .border_color(rgb(0x2A2825).to_hsla())
                        .child(
                            text("参会人")
                                .text_size(px(14.0))
                                .text_color(rgb(0xFAF9F6).to_hsla()),
                        )
                        .child(ui::empty_tile_dark(88.0))
                        .child(ui::empty_tile_dark(88.0))
                        .child(ui::empty_tile_dark(88.0))
                        .child(ui::empty_tile_dark(88.0))
                        .child(ui::note(|| "暂无参会人。不会生成示例成员或头像。".into())),
                ),
        )
        .child(
            view()
                .gap_2()
                .p_4()
                .items_center()
                .child(
                    view()
                        .flex_row()
                        .gap_2()
                        .child(ui::dock_item(
                            "麦克风",
                            Icon::Mic,
                            DockKind::Normal,
                            || true,
                            || {},
                        ))
                        .child(ui::dock_item(
                            "摄像头",
                            Icon::Camera,
                            DockKind::Normal,
                            || true,
                            || {},
                        ))
                        .child(ui::dock_item(
                            "共享屏幕",
                            Icon::Share,
                            DockKind::Normal,
                            || false,
                            move || share.set(first_screen::SharePicker::open_for_review()),
                        ))
                        .child(ui::dock_item(
                            "参会人",
                            Icon::People,
                            DockKind::Normal,
                            || true,
                            || {},
                        ))
                        .child(ui::dock_item(
                            "聊天",
                            Icon::Chat,
                            DockKind::Normal,
                            || true,
                            || {},
                        ))
                        .child(ui::dock_item(
                            "离开会议",
                            Icon::Leave,
                            DockKind::Danger,
                            || true,
                            || {},
                        )),
                )
                .child(
                    text(first_screen::MEETING_CONTROLS_DISABLED)
                        .text_size(px(12.0))
                        .text_color(rgb(0xB8B2A8).to_hsla()),
                )
                .child(
                    text(first_screen::SHARE_PICKER_REVIEW)
                        .text_size(px(12.0))
                        .text_color(rgb(0xB8B2A8).to_hsla()),
                ),
        );
    // 设置：版本与更新；开发者诊断入口。不再复用「消息」会话栏。
    let settings_page = view()
        .gap_4()
        .p_2()
        .style_when(move || page.get() != Page::Settings, |style| style.hidden())
        .child(ui::page_title("设置"))
        .child(ui::note(|| first_screen::PURPOSE.to_owned()))
        .child(
            view()
                .gap_3()
                .p_4()
                .rounded(px(12.0))
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().background)
                .child(
                    text("版本")
                        .text_size(px(16.0))
                        .font_weight(FontWeight::MEDIUM),
                )
                .child(text(concat!("当前版本：", env!("CARGO_PKG_VERSION"))).text_size(px(15.0)))
                .child(when(first_screen::is_preview, || {
                    ui::note(|| first_screen::PREVIEW_LABEL.to_owned())
                })),
        )
        .child(
            view()
                .gap_3()
                .p_4()
                .rounded(px(12.0))
                .border_1()
                .border_color(move || theme().border)
                .child(update_panel()),
        )
        .child(
            view()
                .gap_3()
                .p_4()
                .rounded(px(12.0))
                .border_1()
                .border_color(move || theme().border)
                .child(
                    text(first_screen::DIAGNOSTICS_TITLE)
                        .text_size(px(16.0))
                        .font_weight(FontWeight::MEDIUM),
                )
                .child(ui::note(|| first_screen::DIAGNOSTICS_NOTICE.to_owned()))
                .child(ui::action(
                    "打开开发者诊断",
                    || false,
                    move || page.set(Page::Diagnostics),
                )),
        );
    let members_page = view()
        .gap_4()
        .p_2()
        .style_when(move || page.get() != Page::Members, |style| style.hidden())
        .child(ui::page_title("成员"))
        .child(
            view()
                .gap_3()
                .p_4()
                .rounded(px(12.0))
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().muted)
                .child(ui::note(move || {
                    first_screen::members_placeholder(&identity.get())
                })),
        )
        .child(identity_ui::enterprise_identity(identity));
    // 开发者诊断：手动 P2P、STUN/TURN、连接指纹、媒体与文件调试。安全能力保留，只是不在首屏。
    let diagnostics_page = view()
        .gap_3()
        .style_when(
            move || page.get() != Page::Diagnostics,
            |style| style.hidden(),
        )
        .child(
            text("开发者诊断 · 手动直连")
                .text_size(px(24.0))
                .font_weight(FontWeight::SEMIBOLD),
        )
        .child(ui::note(|| first_screen::DIAGNOSTICS_NOTICE.to_owned()))
        .child(text(move || status.get()).text_color(move || theme().muted_foreground))
        .child(verification.panel(verification_commands, busy))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(ui::action(
                    "创建邀请",
                    move || busy.get(),
                    move || {
                        let settings = match network.direct_settings() {
                            Ok(s) => s,
                            Err(e) => {
                                status.set(e);
                                return;
                            }
                        };
                        verification.cancel();
                        network.reset();
                        busy.set(true);
                        connected.set(false);
                        session.set(Session::Connecting);
                        local.set(String::new());
                        status.set("正在生成邀请…".into());
                        if offer.try_send(Command::Offer(settings)).is_err() {
                            busy.set(false);
                            session.set(Session::Failed("操作繁忙".into()));
                            status.set("操作繁忙，请重试".into());
                        }
                    },
                ))
                .child(ui::action(
                    "复制连接码",
                    move || local.get().is_empty(),
                    move || set_clipboard(local.get_untracked()),
                ))
                .child(ui::action(
                    "断开",
                    move || false,
                    move || {
                        verification.cancel();
                        network.reset();
                        connected.set(false);
                        session.set(Session::Offline);
                        let _ = close.try_send(Command::Close);
                        local.set(String::new());
                    },
                )),
        )
        .child(ui::field(remote, "粘贴对方的完整连接码"))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(ui::action(
                    "接受邀请并生成应答",
                    move || busy.get() || remote.get().trim().is_empty(),
                    move || {
                        let settings = match network.direct_settings() {
                            Ok(s) => s,
                            Err(e) => {
                                status.set(e);
                                return;
                            }
                        };
                        verification.cancel();
                        network.reset();
                        busy.set(true);
                        connected.set(false);
                        session.set(Session::Connecting);
                        local.set(String::new());
                        if answer
                            .try_send(Command::Answer(remote.get_untracked(), settings))
                            .is_err()
                        {
                            busy.set(false);
                            session.set(Session::Failed("操作繁忙".into()));
                        }
                    },
                ))
                .child(ui::action(
                    "应用对方应答",
                    move || busy.get() || remote.get().trim().is_empty(),
                    move || {
                        verification.cancel();
                        if accept
                            .try_send(Command::Accept(remote.get_untracked()))
                            .is_err()
                        {
                            status.set("操作繁忙，请重试".into());
                        }
                    },
                )),
        )
        .child(network.panel(network_commands, remote, local, connected, busy, status))
        .child(call.view(call_commands, connected))
        .child(files.panel(file_commands, connected));
    let nav = move || {
        view()
            .gap_3()
            .child(ui::nav_item(
                "消息",
                Icon::Chat,
                move || page.get() == Page::Messages,
                in_meeting,
                move || page.set(Page::Messages),
            ))
            .child(ui::nav_item(
                "会议",
                Icon::Video,
                move || page.get() == Page::Meeting,
                in_meeting,
                move || page.set(Page::Meeting),
            ))
            .child(ui::nav_item(
                "成员",
                Icon::People,
                move || page.get() == Page::Members,
                in_meeting,
                move || page.set(Page::Members),
            ))
    };
    let settings_nav = move || {
        ui::nav_item(
            "设置",
            Icon::Gear,
            move || matches!(page.get(), Page::Settings | Page::Diagnostics),
            in_meeting,
            move || page.set(Page::Settings),
        )
    };
    let stop_media = move || {
        ui::secondary(
            "断开并停止媒体",
            move || !connected.get() && !busy.get() && !call.needs_stop(),
            move || {
                verification.cancel();
                if emergency_close.try_send(Command::Close).is_ok() {
                    network.reset();
                    connected.set(false);
                    busy.set(true);
                    session.set(Session::Offline);
                    status.set("正在关闭连接和媒体，等待设备确认…".into());
                } else {
                    status.set("关闭请求尚未送达，请重试；设备状态未改变。".into());
                }
            },
        )
    };
    view()
        .flex_1()
        .child(
            view()
                .flex_1()
                .flex_row()
                .p_safe_area()
                .bg(move || {
                    if in_meeting() {
                        rgb(0x161513).to_hsla()
                    } else {
                        rgb(0xFAF9F6).to_hsla()
                    }
                })
                .text_color(move || theme().foreground)
                .child(when(wide, move || {
                    view()
                        .w(px(72.0))
                        .p_3()
                        .gap_4()
                        .items_center()
                        .border_r_1()
                        .border_color(move || {
                            if in_meeting() {
                                rgb(0x2A2825).to_hsla()
                            } else {
                                rgb(0xE3E0DA).to_hsla()
                            }
                        })
                        .bg(move || {
                            if in_meeting() {
                                rgb(0x161513).to_hsla()
                            } else {
                                rgb(0xFAF9F6).to_hsla()
                            }
                        })
                        .child(ui::brand_mark(40.0))
                        .child(nav())
                        .child(view().flex_1())
                        .child(settings_nav())
                }))
                .child(when(
                    move || wide() && page.get().shows_conversation_column(),
                    move || {
                        view()
                            .w(px(300.0))
                            .px_5()
                            .py_5()
                            .gap_4()
                            .border_r_1()
                            .border_color(move || theme().border)
                            .bg(move || theme().background)
                            .child(conversation_list())
                    },
                ))
                .child(
                    view()
                        .flex_1()
                        .child(
                            view()
                                .flex_row()
                                .flex_wrap()
                                .items_center()
                                .px_4()
                                .py_2()
                                .gap_3()
                                .border_b_1()
                                .border_color(move || theme().border)
                                .bg(move || theme().muted)
                                .style_when(in_meeting, |style| style.hidden())
                                .child(when(
                                    move || !wide(),
                                    move || {
                                        view()
                                            .flex_row()
                                            .flex_wrap()
                                            .gap_2()
                                            .child(nav().flex_row())
                                            .child(settings_nav())
                                    },
                                ))
                                .child(
                                    text(first_screen::APP_TITLE)
                                        .text_size(px(13.0))
                                        .font_weight(FontWeight::MEDIUM),
                                )
                                .child(call.privacy_compact())
                                .child(view().flex_1())
                                .child(stop_media()),
                        )
                        .child(
                            scroll()
                                .test_id("conversation-scroll")
                                .flex_1()
                                .style_when(
                                    move || !page.get().uses_content_scroll(),
                                    |style| style.hidden(),
                                )
                                .child(
                                    view()
                                        .p_6()
                                        .gap_4()
                                        .child(when(
                                            move || page.get() == Page::Diagnostics,
                                            move || {
                                                ui::secondary(
                                                    "返回设置",
                                                    || false,
                                                    move || page.set(Page::Settings),
                                                )
                                            },
                                        ))
                                        .child(members_page)
                                        .child(settings_page)
                                        .child(diagnostics_page),
                                ),
                        )
                        .child(
                            view()
                                .flex_1()
                                .style_when(
                                    move || page.get().uses_content_scroll(),
                                    |style| style.hidden(),
                                )
                                .child(messages_page)
                                .child(meeting_page),
                        ),
                ),
        )
        .child(when(
            move || share.get().open,
            move || {
                nsh_base::dialog()
                    .close_on_escape(true)
                    .on_cancel(move || share.update(|state| *state = state.close()))
                    .child(
                        view().flex_1().items_center().justify_center().child(
                            view()
                                .w(px(720.0))
                                .p_6()
                                .gap_4()
                                .rounded(px(16.0))
                                .bg(move || theme().background)
                                .border_1()
                                .border_color(move || theme().border)
                                .child(
                                    view()
                                        .flex_row()
                                        .items_center()
                                        .child(
                                            text("选择要共享的内容")
                                                .text_size(px(22.0))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .flex_1(),
                                        )
                                        .child(ui::icon_action(
                                            "关闭选择器",
                                            Icon::Close,
                                            INK,
                                            || false,
                                            move || share.update(|state| *state = state.close()),
                                        )),
                                )
                                .child(ui::note(|| "仅向会议成员展示所选内容".into()))
                                .child(
                                    view()
                                        .flex_row()
                                        .p_1()
                                        .rounded(px(12.0))
                                        .bg(move || theme().muted)
                                        .child(ui::segment(
                                            ShareKind::Window.label(),
                                            move || share.get().kind == ShareKind::Window,
                                            move || {
                                                share.update(|state| state.kind = ShareKind::Window)
                                            },
                                        ))
                                        .child(ui::segment(
                                            ShareKind::Display.label(),
                                            move || share.get().kind == ShareKind::Display,
                                            move || {
                                                share
                                                    .update(|state| state.kind = ShareKind::Display)
                                            },
                                        )),
                                )
                                .child(
                                    view()
                                        .gap_2()
                                        .child(
                                            view()
                                                .flex_row()
                                                .gap_2()
                                                .child(ui::empty_tile(120.0))
                                                .child(ui::empty_tile(120.0)),
                                        )
                                        .child(
                                            view()
                                                .flex_row()
                                                .gap_2()
                                                .child(ui::empty_tile(120.0))
                                                .child(ui::empty_tile(120.0)),
                                        )
                                        .child(ui::note(move || {
                                            share.get().empty_copy().to_owned()
                                        })),
                                )
                                .child(ui::warning_card(first_screen::SHARE_SCREEN_WARNING))
                                .child(
                                    view()
                                        .flex_row()
                                        .items_center()
                                        .gap_3()
                                        .child(
                                            view()
                                                .w(px(16.0))
                                                .h(px(16.0))
                                                .rounded(px(4.0))
                                                .border_1()
                                                .border_color(move || theme().input)
                                                .bg(move || theme().muted),
                                        )
                                        .child(ui::note(|| {
                                            "同时共享系统音频取决于系统支持，当前尚未接入。".into()
                                        })),
                                )
                                .child(ui::note(move || {
                                    share
                                        .get()
                                        .start_reason(false, false)
                                        .unwrap_or("")
                                        .to_owned()
                                }))
                                .child(
                                    view()
                                        .flex_row()
                                        .gap_2()
                                        .justify_end()
                                        .child(ui::secondary(
                                            "取消",
                                            || false,
                                            move || share.update(|state| *state = state.close()),
                                        ))
                                        .child(ui::action(
                                            "开始共享",
                                            move || !share.get().can_start(false, false),
                                            || {},
                                        )),
                                ),
                        ),
                    )
            },
        ))
}

#[cfg(feature = "github-manual-updates")]
#[component]
pub fn App() -> impl IntoElement {
    collaboration()
}

/// 发布入口：在验证并持久化可信更新策略之前，不创建协作会话或网络线程。
#[cfg(not(feature = "github-manual-updates"))]
#[component]
pub fn App() -> impl IntoElement {
    apply_theme();
    let ready = signal(false);
    let status = signal("正在验证更新…".to_owned());
    let can_retry = signal(false);
    let update_viewport_height = signal(0.0_f32);
    check_update(ready, status, can_retry);
    view()
        .flex_1()
        .child(when(
            move || !ready.get(),
            move || {
                view()
                    .flex_1()
                    .p_safe_area()
                    .bg(move || theme().background)
                    .text_color(move || theme().foreground)
                    .child(
                        scroll()
                            .test_id("update-scroll")
                            .flex_1()
                            .on_layout(move |bounds: &Bounds<Points>| {
                                let height = bounds.size.height.0;
                                if update_viewport_height.get_untracked() != height {
                                    update_viewport_height.set(height);
                                }
                            })
                            .child(
                                view()
                                    // Center when space permits; grow and scroll on short windows.
                                    .min_h(move || px(update_viewport_height.get()))
                                    .p_4()
                                    .justify_center()
                                    .items_center()
                                    .gap_4()
                                    .child(image(ui::brand()).w(px(64.0)).h(px(64.0)))
                                    .child(text("吉吉 · 安全更新").text_size(px(24.0)))
                                    .child(text(move || status.get()))
                                    .child(ui::action(
                                        "重新检查更新",
                                        move || !can_retry.get(),
                                        move || check_update(ready, status, can_retry),
                                    ))
                                    .child(
                                        text("更新完成前不可进入协作空间。")
                                            .text_color(move || theme().muted_foreground),
                                    ),
                            ),
                    )
            },
        ))
        .child(when(move || ready.get(), collaboration))
}

#[cfg(not(feature = "github-manual-updates"))]
fn check_update(ready: Signal<bool>, status: Signal<String>, can_retry: Signal<bool>) {
    ready.set(false);
    can_retry.set(false);
    status.set("正在验证更新…".into());
    let events = startup::start(startup::private_data_dir());
    spawn(async move {
        while let Ok(event) = events.recv().await {
            match event {
                startup::Event::Status(text) => status.set(text),
                startup::Event::Ready => ready.set(true),
            }
        }
        can_retry.set(!ready.get_untracked());
    });
}

fn apply_theme() {
    if let Ok(tokens) = nsh_base::tokens_of(Some(include_str!("../theme.json"))) {
        nsh_core::element::set_tokens(tokens);
    }
}

/// 仅供已打包媒体Provider的Android实验宿主保留JNI导出。
#[cfg(all(target_os = "android", feature = "android-native-media"))]
pub fn ensure_android_media_linked() {
    surreal_ck_native_media_platform::android::ensure_linked();
}
