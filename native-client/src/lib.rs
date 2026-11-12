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
    use first_screen::{Page, Session};
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
    let conversation_list = move || {
        view()
            .gap_2()
            .child(ui::note(move || identity.get().line()))
            .child(when(
                move || connected.get(),
                move || {
                    view()
                        .p_3()
                        .gap_1()
                        .rounded(move || theme().radius)
                        .bg(move || theme().muted)
                        .child(text("直连会话（开发者诊断）"))
                        .child(ui::note(move || session.get().line()))
                },
            ))
            .child(ui::note(move || {
                first_screen::conversation_placeholder(&identity.get(), usize::from(connected.get()))
                    .unwrap_or_default()
            }))
    };
    // 首屏：用途、实验标注、企业身份/工作区、会话列表与消息输入。
    let messages_page = view()
        .gap_3()
        .style_when(move || page.get() != Page::Messages, |style| style.hidden())
        .child(text(first_screen::PURPOSE).text_size(px(24.0)))
        .child(when(
            || first_screen::is_preview(),
            || {
                view()
                    .p_2()
                    .rounded(move || theme().radius)
                    .border_1()
                    .border_color(move || theme().primary)
                    .child(text(first_screen::PREVIEW_LABEL))
            },
        ))
        .child(identity_ui::enterprise_identity(identity))
        .child(when(move || !wide(), conversation_list))
        .child(ui::note(|| first_screen::MEETING_NOT_CONNECTED.to_owned()))
        .child(text(move || session.get().line()).test_id("session-state"))
        .child(when(
            move || messages.get().is_empty(),
            || ui::note(|| first_screen::EMPTY_MESSAGES.to_owned()),
        ))
        .child(
            virtual_list(
                move || messages.get().len(),
                move |at| {
                    text(move || {
                        messages.get().get(at.index()).map(|m| m.label()).unwrap_or_default()
                    })
                    .p_3()
                },
            )
            .estimated_item_size(px(52.0))
            .h(px(180.0)),
        )
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(ui::composer(draft, "输入消息，Enter 发送", move || submit_message()))
                .child(ui::action(
                    "发送消息",
                    move || !connected.get() || sending.get() || draft.get().trim().is_empty(),
                    move || send_message(),
                )),
        );
    // 设置：版本与更新；开发者诊断入口。
    let settings_page = view()
        .gap_3()
        .style_when(move || page.get() != Page::Settings, |style| style.hidden())
        .child(text("设置").text_size(px(24.0)))
        .child(text(concat!("当前版本：", env!("CARGO_PKG_VERSION"))))
        .child(when(
            || first_screen::is_preview(),
            || ui::note(|| first_screen::PREVIEW_LABEL.to_owned()),
        ))
        .child(update_panel())
        .child(text(first_screen::DIAGNOSTICS_TITLE).text_size(px(20.0)))
        .child(ui::note(|| first_screen::DIAGNOSTICS_NOTICE.to_owned()))
        .child(ui::action("打开开发者诊断", || false, move || page.set(Page::Diagnostics)));
    // 开发者诊断：手动 P2P、STUN/TURN、连接指纹、媒体与文件调试。安全能力保留，只是不在首屏。
    let diagnostics_page = view()
        .gap_3()
        .style_when(move || page.get() != Page::Diagnostics, |style| style.hidden())
        .child(text("开发者诊断 · 手动直连").text_size(px(24.0)))
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
            .gap_2()
            .child(ui::action("消息", || false, move || page.set(Page::Messages)))
            .child(ui::action("设置", || false, move || page.set(Page::Settings)))
    };
    view()
        .flex_1()
        .flex_row()
        .p_safe_area()
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .child(when(wide, move || {
            view()
                .w(px(88.0))
                .p_3()
                .gap_4()
                .items_center()
                .border_1()
                .border_color(move || theme().border)
                .child(image(ui::brand()).w(px(44.0)).h(px(44.0)))
                .child(text("吉吉"))
                .child(nav())
        }))
        .child(when(wide, move || {
            view()
                .w(px(300.0))
                .p_4()
                .gap_4()
                .border_1()
                .border_color(move || theme().border)
                .child(text("消息列表").text_size(px(22.0)))
                .child(conversation_list())
        }))
        .child(
            view()
                .flex_1()
                .child(
                    // 隐私与紧急停止区在所有页面常驻，不随设置/诊断折叠。
                    view()
                        .p_2()
                        .gap_2()
                        .child(when(move || !wide(), move || nav().flex_row()))
                        .child(call.privacy_view())
                        .child(ui::action(
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
                        )),
                )
                .child(
                    scroll().test_id("conversation-scroll").flex_1().child(
                        view()
                            .p_4()
                            .gap_3()
                            .child(when(
                                move || page.get() == Page::Diagnostics,
                                move || ui::action("返回设置", || false, move || page.set(Page::Settings)),
                            ))
                            .child(messages_page)
                            .child(settings_page)
                            .child(diagnostics_page),
                    ),
                ),
        )
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
