use nsh_base::input;
use nsh_core::prelude::*;
use surreal_ck_native_identity::roster::Focus;
use tokio::sync::watch;
use zeroize::Zeroizing;

use crate::{
    roster_actor::{self, Action, HostScope, View as RosterView},
    ui,
};

pub(crate) fn panel(scope: watch::Receiver<Option<HostScope>>) -> impl IntoElement {
    let (actions, mut updates) = roster_actor::start(scope);
    let state = signal(RosterView::default());
    let invitation = signal(String::new());
    let code = signal(String::new());
    let check = signal(String::new());
    let confirm_end = signal(false);
    let cohost_room = signal(String::new());
    let stop = actions.clone();
    cleanup(move || {
        stop.close();
    });
    spawn(async move {
        loop {
            state.set(updates.borrow_and_update().clone());
            if updates.changed().await.is_err() {
                break;
            }
        }
    });
    let join = actions.clone();
    let host = actions.clone();
    let leave = actions.clone();
    let raise = actions.clone();
    let microphone = actions.clone();
    view()
        .gap_3()
        .child(ui::section_label("名册核验大会"))
        .child(when(
            move || !state.get().busy,
            move || {
                let join = join.clone();
                let host = host.clone();
                let enter_cohost = host.clone();
                ui::card()
                    .child(private_input(invitation, "粘贴名册邀请链接"))
                    .child(private_input(code, "访问码"))
                    .child(private_input(check, "附加核验字段（若邀请要求）"))
                    .child(ui::action(
                        "核验并加入",
                        move || invitation.get().is_empty() || code.get().is_empty(),
                        move || {
                            let action = Action::Join(
                                Zeroizing::new(invitation.get()),
                                Zeroizing::new(code.get()),
                                Zeroizing::new(check.get()),
                            );
                            if join.try_send(action).is_ok() {
                                invitation.set(String::new());
                                code.set(String::new());
                                check.set(String::new());
                            }
                        },
                    ))
                    .child(when(
                        move || state.get().member_available,
                        move || {
                            let enter = enter_cohost.clone();
                            view()
                                .child(
                                    input()
                                        .value(move || cohost_room.get())
                                        .placeholder("协办大会编号")
                                        .on_change(move |value: &str| {
                                            cohost_room.set(value.to_owned())
                                        }),
                                )
                                .child(ui::secondary(
                                    "进入协办席位",
                                    move || cohost_room.get().trim().is_empty(),
                                    move || {
                                        let _ = enter.try_send(Action::Cohost(
                                            cohost_room.get().trim().to_owned(),
                                        ));
                                    },
                                ))
                        },
                    ))
                    .child(when(
                        move || state.get().host_available,
                        move || {
                            let host = host.clone();
                            ui::secondary(
                                "主持名册大会",
                                || false,
                                move || {
                                    let _ = host.try_send(Action::Host);
                                },
                            )
                        },
                    ))
            },
        ))
        .child(when(
            move || !state.get().message.is_empty(),
            move || ui::note(move || state.get().message),
        ))
        .child(when(
            move || state.get().busy,
            move || {
                let leave = leave.clone();
                ui::secondary(
                    "离开名册会议",
                    || false,
                    move || {
                        confirm_end.set(false);
                        let _ = leave.try_send(Action::Leave);
                    },
                )
            },
        ))
        .child(when(
            move || state.get().connected,
            move || {
                view()
                    .gap_2()
                    .child(text(move || state.get().title))
                    .child(when(
                        move || state.get().video.is_some(),
                        move || {
                            native(surreal_ck_native_video_view::COMPONENT_NAME)
                                .prop("streamId", move || {
                                    serde_json::Value::String(state.get().video.unwrap_or_default())
                                })
                                .w(px(320.0))
                                .h(px(180.0))
                        },
                    ))
            },
        ))
        .child(when(
            move || {
                let s = state.get();
                s.connected && s.host.is_none() && !s.cohost
            },
            move || {
                let raise = raise.clone();
                let start_mic = microphone.clone();
                let stop_mic = microphone.clone();
                view()
                    .gap_2()
                    .child(ui::secondary(
                        "举手申请发言",
                        move || state.get().may_speak,
                        move || {
                            let _ = raise.try_send(Action::Raise);
                        },
                    ))
                    .child(when(
                        move || state.get().may_speak && !state.get().microphone,
                        move || {
                            let start_mic = start_mic.clone();
                            ui::action(
                                "已获准发言 · 开启麦克风",
                                || false,
                                move || {
                                    let _ = start_mic.try_send(Action::Microphone(true));
                                },
                            )
                        },
                    ))
                    .child(when(
                        move || state.get().microphone,
                        move || {
                            let stop_mic = stop_mic.clone();
                            ui::secondary(
                                "关闭麦克风",
                                || false,
                                move || {
                                    let _ = stop_mic.try_send(Action::Microphone(false));
                                },
                            )
                        },
                    ))
            },
        ))
        .child(when(
            move || cfg!(target_os = "linux") && state.get().cohost,
            {
                let actions = actions.clone();
                move || share_controls(actions.clone(), move || state.get().sharing)
            },
        ))
        .child(host_panel(state, actions, confirm_end))
}

#[cfg(target_os = "linux")]
fn share_controls(
    actions: async_channel::Sender<Action>,
    sharing: impl Fn() -> bool + Copy + 'static,
) -> impl IntoElement {
    view()
        .child(ui::secondary("共享整个屏幕", sharing, {
            let start = actions.clone();
            move || {
                let _ = start.try_send(Action::Share(true));
            }
        }))
        .child(ui::secondary(
            "停止屏幕共享",
            move || !sharing(),
            move || {
                let _ = actions.try_send(Action::Share(false));
            },
        ))
}

#[cfg(target_os = "android")]
fn share_controls(
    _actions: async_channel::Sender<Action>,
    _sharing: impl Fn() -> bool + Copy + 'static,
) -> impl IntoElement {
    view()
}

fn private_input(value: Signal<String>, placeholder: &'static str) -> impl IntoElement {
    input()
        .masked(true)
        .value(move || value.get())
        .on_change(move |text: &str| value.set(text.to_owned()))
        .placeholder(placeholder)
}

fn host_panel(
    state: Signal<RosterView>,
    actions: async_channel::Sender<Action>,
    confirm_end: Signal<bool>,
) -> impl IntoElement {
    let open = actions.clone();
    let cohost_subject = signal(String::new());
    view()
        .gap_2()
        .child(each(
            move || state.get().host.map(|h| h.meetings).unwrap_or_default(),
            |meeting| meeting.0.clone(),
            move |meeting, _| {
                let open = open.clone();
                view()
                    .gap_2()
                    .child(text(move || meeting.get().2))
                    .child(ui::action(
                        "进入主持席位",
                        move || !state.get().title.is_empty(),
                        move || {
                            let (id, room, title) = meeting.get();
                            let _ = open.try_send(Action::Open(id, room, title));
                        },
                    ))
            },
        ))
        .child(when(
            move || state.get().connected && state.get().host.is_some(),
            move || {
                let lock = actions.clone();
                let auto = actions.clone();
                let speaker = actions.clone();
                let screen = actions.clone();
                let mute = actions.clone();
                let share = actions.clone();
                let designate = actions.clone();
                let end = actions.clone();
                let attendee_action = actions.clone();
                ui::card()
                    .child(ui::note(move || {
                        if state.get().host.is_some_and(|h| h.locked) {
                            "会场已锁定"
                        } else {
                            "会场开放"
                        }
                        .into()
                    }))
                    .child(ui::secondary(
                        "锁定／解除锁定会议",
                        || false,
                        move || {
                            if let Some(host) = state.get().host {
                                let _ = lock.try_send(Action::Lock(!host.locked));
                            }
                        },
                    ))
                    .child(ui::secondary(
                        "焦点：自动",
                        move || state.get().focus == Focus::Auto,
                        move || {
                            let _ = auto.try_send(Action::Focus(Focus::Auto));
                        },
                    ))
                    .child(ui::secondary(
                        "焦点：主讲画面",
                        move || state.get().focus == Focus::Speaker,
                        move || {
                            let _ = speaker.try_send(Action::Focus(Focus::Speaker));
                        },
                    ))
                    .child(ui::secondary(
                        "焦点：共享画面",
                        move || state.get().focus == Focus::Screen,
                        move || {
                            let _ = screen.try_send(Action::Focus(Focus::Screen));
                        },
                    ))
                    .child(ui::secondary(
                        "一键全员静音",
                        || false,
                        move || {
                            let _ = mute.try_send(Action::MuteAll);
                        },
                    ))
                    .child(when(
                        || cfg!(target_os = "linux"),
                        move || {
                            share_controls(share.clone(), move || {
                                state.get().host.is_some_and(|h| h.sharing)
                            })
                        },
                    ))
                    .child(ui::note(move || {
                        state
                            .get()
                            .host
                            .map(|h| format!("协办大会编号：{}", h.room))
                            .unwrap_or_default()
                    }))
                    .child(
                        input()
                            .value(move || cohost_subject.get())
                            .placeholder("工作区成员的 OIDC 主体 ID")
                            .on_change(move |value: &str| cohost_subject.set(value.to_owned())),
                    )
                    .child(ui::secondary(
                        "指定协办人（仅共享屏幕）",
                        move || cohost_subject.get().trim().is_empty(),
                        move || {
                            let _ = designate.try_send(Action::Designate(
                                cohost_subject.get().trim().to_owned(),
                            ));
                        },
                    ))
                    .child(ui::section_label("举手队列与参会人"))
                    .child(each(
                        move || state.get().host.map(|h| h.participants).unwrap_or_default(),
                        |p| p.id.clone(),
                        move |attendee, _| {
                            let grant = attendee_action.clone();
                            let revoke = attendee_action.clone();
                            let muting = attendee_action.clone();
                            let verify_revoke = signal(false);
                            ui::card()
                                .child(text(move || {
                                    let p = attendee.get();
                                    match p.raised_at {
                                        Some(ms) => format!(
                                            "{} · 举手时间（UTC Unix 秒）：{}",
                                            p.name,
                                            ms / 1000
                                        ),
                                        None if p.speaking => format!("{} · 可发言", p.name),
                                        _ => p.name,
                                    }
                                }))
                                .child(ui::secondary(
                                    "允许发言",
                                    move || attendee.get().speaking,
                                    move || {
                                        let _ =
                                            grant.try_send(Action::Speak(attendee.get().id, true));
                                    },
                                ))
                                .child(ui::secondary(
                                    "收回发言权",
                                    move || !attendee.get().speaking,
                                    move || {
                                        let _ = muting
                                            .try_send(Action::Speak(attendee.get().id, false));
                                    },
                                ))
                                .child(ui::secondary(
                                    "移出并吊销资格",
                                    move || verify_revoke.get(),
                                    move || verify_revoke.set(true),
                                ))
                                .child(when(
                                    move || verify_revoke.get(),
                                    move || {
                                        let revoke = revoke.clone();
                                        view()
                                            .child(ui::action(
                                                "确认吊销",
                                                || false,
                                                move || {
                                                    verify_revoke.set(false);
                                                    let _ = revoke.try_send(Action::Revoke(
                                                        attendee.get().id,
                                                    ));
                                                },
                                            ))
                                            .child(ui::secondary(
                                                "取消",
                                                || false,
                                                move || verify_revoke.set(false),
                                            ))
                                    },
                                ))
                        },
                    ))
                    .child(ui::secondary(
                        "结束全体会议",
                        move || confirm_end.get(),
                        move || confirm_end.set(true),
                    ))
                    .child(when(
                        move || confirm_end.get(),
                        move || {
                            let end = end.clone();
                            view()
                                .child(ui::action(
                                    "确认结束全体会议",
                                    || false,
                                    move || {
                                        confirm_end.set(false);
                                        let _ = end.try_send(Action::End);
                                    },
                                ))
                                .child(ui::secondary(
                                    "取消",
                                    || false,
                                    move || confirm_end.set(false),
                                ))
                        },
                    ))
            },
        ))
}
