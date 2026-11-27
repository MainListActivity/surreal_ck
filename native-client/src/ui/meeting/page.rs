use super::*;
use crate::first_screen::{MEETING_JOIN, MEETING_START, NO_LIVE_MEETINGS};
use crate::ui;
use nsh_base::{button, dialog};
use nsh_core::{element::AnyElement, prelude::*};
use std::rc::Rc;
use surreal_ck_native_identity::meeting::{valid_code, valid_v2_code};

/// 工厂在成员/入会实例/媒体源变化时重建；返回的原生元素由 NSH 管理生命周期。
pub type VideoSlot = Rc<dyn Fn(&str, &str, Source) -> AnyElement>;

pub fn placeholder_video(member: &str, _join: &str, source: Source) -> AnyElement {
    view()
        .min_h(px(110.0))
        .items_center()
        .justify_center()
        .child(text(format!("{member} · {}画面占位", source.label())))
        .into_element()
}

type Send = Rc<dyn Fn(MeetingCommand)>;

pub fn privacy_controls(
    state: MeetingState,
    send: impl Fn(MeetingCommand) + Clone + 'static,
) -> impl IntoElement {
    let expanded = signal(false);
    let occupied = move || {
        Source::ALL
            .into_iter()
            .filter(|source| state.get().device(*source) != DeviceState::Off)
            .collect::<Vec<_>>()
    };
    let stop_all = send.clone();
    let stop_one = send;
    view()
        .style_when(move || occupied().is_empty(), |style| style.hidden())
        .gap_2()
        .child(
            button()
                .on_press(move || expanded.set(!expanded.get_untracked()))
                .px_3()
                .py_2()
                .rounded(px(12.0))
                .bg(move || nsh_base::theme().destructive)
                .child(
                    text(move || {
                        occupied()
                            .into_iter()
                            .map(Source::label)
                            .collect::<Vec<_>>()
                            .join(" · ")
                    })
                    .text_color(rgb(0xFFFFFF).to_hsla()),
                ),
        )
        .child(when(
            move || expanded.get() && !occupied().is_empty(),
            move || {
                let stop_all = stop_all.clone();
                let stop_one = stop_one.clone();
                ui::card()
                    .child(each(
                        occupied,
                        |source| *source,
                        move |source, _| {
                            let stop_one = stop_one.clone();
                            let source = source.get_untracked();
                            let stop = match source {
                                Source::Mic => "关闭麦克风",
                                Source::Camera => "关闭摄像头",
                                Source::Screen => "停止共享",
                            };
                            view()
                                .gap_1()
                                .child(ui::note(move || {
                                    format!(
                                        "{} · {}",
                                        source.label(),
                                        state.get().device(source).label()
                                    )
                                }))
                                .child(ui::danger(
                                    stop,
                                    move || state.get().device(source) == DeviceState::Stopping,
                                    move || {
                                        let command = match source {
                                            Source::Screen => MeetingCommand::StopShare,
                                            _ => MeetingCommand::SetDevice { source, on: false },
                                        };
                                        state.prepare(&command);
                                        stop_one(command);
                                    },
                                ))
                        },
                    ))
                    .child(ui::danger(
                        "停止全部媒体",
                        || false,
                        move || {
                            for source in occupied() {
                                let command = match source {
                                    Source::Screen => MeetingCommand::StopShare,
                                    _ => MeetingCommand::SetDevice { source, on: false },
                                };
                                state.prepare(&command);
                                stop_all(command);
                            }
                        },
                    ))
            },
        ))
}

pub fn meeting_page(
    state: MeetingState,
    send: impl Fn(MeetingCommand) + Clone + 'static,
    video: VideoSlot,
) -> impl IntoElement {
    meeting_page_in_shell(state, send, video, signal(false), signal(None), || {})
}

pub fn meeting_page_in_shell(
    state: MeetingState,
    send: impl Fn(MeetingCommand) + Clone + 'static,
    video: VideoSlot,
    minimized: Signal<bool>,
    prejoin: Signal<Option<MeetingCommand>>,
    return_to_messages: impl Fn() + Copy + 'static,
) -> impl IntoElement {
    #[cfg(all(
        feature = "experimental-enterprise-meeting",
        any(target_os = "linux", target_os = "macos", target_os = "windows")
    ))]
    let prejoin_media = super::prejoin::PrejoinMedia::new();
    #[cfg(all(
        feature = "experimental-enterprise-meeting",
        any(target_os = "linux", target_os = "macos", target_os = "windows")
    ))]
    effect(move || {
        if prejoin.get().is_none() || !state.get().can_enter() {
            prejoin_media.stop();
        }
    });
    let testing_devices = move || {
        #[cfg(all(
            feature = "experimental-enterprise-meeting",
            any(target_os = "linux", target_os = "macos", target_os = "windows")
        ))]
        {
            prejoin_media.active()
        }
        #[cfg(not(all(
            feature = "experimental-enterprise-meeting",
            any(target_os = "linux", target_os = "macos", target_os = "windows")
        )))]
        {
            false
        }
    };
    let send: Send = Rc::new(move |cmd| {
        state.prepare(&cmd);
        send(cmd);
    });
    let code = signal(String::new());
    let invite_open = signal(false);
    let selected = signal(Vec::<String>::new());
    let confirm = signal(false);
    let shared = signal(None::<(String, String)>);
    let retry = signal(None::<MeetingCommand>);
    let join_with_mic = signal(false);
    let mic_on_entry = signal(false);
    let share_open = signal(false);
    let share_screen_tab = signal(false);
    let share_selected = signal(false);
    let request: Send = {
        let send = send.clone();
        Rc::new(move |cmd| {
            if !matches!(cmd, MeetingCommand::DismissError) {
                retry.set(Some(cmd.clone()));
            }
            send(cmd);
        })
    };
    let preflight_send = request.clone();
    let stop_share = request.clone();
    let error_send = request.clone();
    let dismiss = request.clone();
    let active_send = request.clone();
    let device_send = request.clone();
    let dock_send = request.clone();
    effect(move || {
        let current = state.get();
        if current.active() && mic_on_entry.get() {
            mic_on_entry.set(false);
            request(MeetingCommand::SetDevice {
                source: Source::Mic,
                on: true,
            });
        } else if current.error.is_some() && mic_on_entry.get() {
            mic_on_entry.set(false);
        }
        if !current.active() && minimized.get() {
            minimized.set(false);
        }
    });
    view()
        .gap_3()
        .p_4()
        .child(ui::page_header("会议", || {
            "开始会议，或加入同事邀请你的会议。".into()
        }))
        .child(each(
            move || {
                Source::ALL
                    .into_iter()
                    .filter(|s| state.get().device(*s) == DeviceState::StopUnconfirmed)
                    .collect::<Vec<_>>()
            },
            |s| *s,
            |source, _| {
                ui::note(move || {
                    format!(
                        "隐私告警：{}停止未确认，请检查系统设备指示灯。",
                        source.get().label()
                    )
                })
            },
        ))
        .child(when(
            move || state.get().notice.is_some(),
            move || ui::note(move || state.get().notice.unwrap_or_default()),
        ))
        .child(when(
            move || state.get().error.is_some(),
            move || {
                let error_send = error_send.clone();
                let dismiss = dismiss.clone();
                ui::card()
                    .child(text(move || {
                        state.get().error.map(|e| e.message()).unwrap_or_default()
                    }))
                    .child(when(
                        move || {
                            matches!(state.get().error, Some(MeetingError::Retryable { .. }))
                                && retry.get().is_some()
                        },
                        move || {
                            let send = error_send.clone();
                            ui::action(
                                "重试",
                                || false,
                                move || {
                                    if let Some(cmd) = retry.get() {
                                        match cmd {
                                            MeetingCommand::Create
                                            | MeetingCommand::CreateFor { .. }
                                            | MeetingCommand::Join { .. } => {
                                                join_with_mic.set(false);
                                                prejoin.set(Some(cmd));
                                            }
                                            _ => send(cmd),
                                        }
                                    }
                                },
                            )
                        },
                    ))
                    .child(ui::secondary(
                        "关闭提示",
                        || false,
                        move || dismiss(MeetingCommand::DismissError),
                    ))
            },
        ))
        .child(when(
            move || !state.get().active(),
            move || {
                view()
                    .gap_3()
                    .child(ui::note(move || match state.get().capability {
                        Capability::Available => String::new(),
                        Capability::Unavailable { reason } => reason.message().into(),
                    }))
                    .child(
                        view()
                            .flex_row()
                            .flex_wrap()
                            .gap_3()
                            .child(
                                ui::entry_card(ui::icons::Icon::Video, true, MEETING_START, || {
                                    "邀请工作区成员加入。".into()
                                })
                                .child(ui::action(
                                    MEETING_START,
                                    move || !state.get().can_enter(),
                                    move || {
                                        join_with_mic.set(false);
                                        prejoin.set(Some(MeetingCommand::Create));
                                    },
                                )),
                            )
                            .child(
                                ui::entry_card(ui::icons::Icon::Link, false, MEETING_JOIN, || {
                                    "使用邀请中的会议号。".into()
                                })
                                .child(ui::field(code, "输入会议号"))
                                .child(ui::secondary(
                                    "加入",
                                    move || {
                                        let room_code = code.get().trim().to_ascii_uppercase();
                                        !state.get().can_enter()
                                            || !(valid_code(&room_code)
                                                || valid_v2_code(&room_code))
                                    },
                                    move || {
                                        join_with_mic.set(false);
                                        prejoin.set(Some(MeetingCommand::Join {
                                            room_code: code.get().trim().to_ascii_uppercase(),
                                        }));
                                    },
                                )),
                            ),
                    )
                    .child(ui::section_label("进行中"))
                    .child(ui::card().child(ui::note(|| NO_LIVE_MEETINGS.into())))
                    .child(ui::section_label("收到的邀请"))
                    .child(each(
                        move || state.get().invitations,
                        |i| i.room_code.clone(),
                        move |invitation, _| {
                            ui::card()
                                .child(text(move || {
                                    let i = invitation.get();
                                    format!(
                                        "{} 邀请你加入 · {} · {}",
                                        i.host_name, i.room_code, i.invited_at
                                    )
                                }))
                                .child(ui::action(
                                    "接受邀请并加入",
                                    move || !state.get().can_enter(),
                                    move || {
                                        join_with_mic.set(false);
                                        prejoin.set(Some(MeetingCommand::Join {
                                            room_code: invitation.get().room_code,
                                        }))
                                    },
                                ))
                        },
                    ))
                    .child(ui::section_label("最近结束"))
                    .child(ui::card().child(text(move || {
                        let rooms = state.get().recently_ended;
                        if rooms.is_empty() {
                            "暂无会议记录".into()
                        } else {
                            rooms.join("\n")
                        }
                    })))
            },
        ))
        .child(when(
            move || state.get().can_enter() && prejoin.get().is_some(),
            move || {
                let enter = preflight_send.clone();
                let cancel = move || {
                    prejoin.set(None);
                    join_with_mic.set(false);
                };
                let card = ui::card()
                    .child(ui::page_title("会前检查"))
                    .child(ui::note(|| "摄像头默认关闭。检测仅在本机运行。".into()));
                #[cfg(all(
                    feature = "experimental-enterprise-meeting",
                    any(target_os = "linux", target_os = "macos", target_os = "windows")
                ))]
                let card = card.child(prejoin_media.controls());
                dialog().on_cancel(cancel).child(
                    card.child(ui::secondary(
                        "切换入会时的麦克风状态",
                        || false,
                        move || join_with_mic.set(!join_with_mic.get_untracked()),
                    ))
                    .child(text(move || {
                        if join_with_mic.get() {
                            "入会时开启麦克风"
                        } else {
                            "静音入会"
                        }
                    }))
                    .child(permissions_settings())
                    .child(
                        view()
                            .flex_row()
                            .gap_2()
                            .child(ui::secondary("取消", || false, cancel))
                            .child(ui::action(
                                "确认入会",
                                move || !state.get().can_enter() || testing_devices(),
                                move || {
                                    if let Some(command) = prejoin.get_untracked() {
                                        prejoin.set(None);
                                        mic_on_entry.set(join_with_mic.get_untracked());
                                        join_with_mic.set(false);
                                        enter(command);
                                    }
                                },
                            )),
                    ),
                )
            },
        ))
        .child(when(
            move || state.get().active() && !minimized.get(),
            move || {
                let send = active_send.clone();
                let invite_send = send.clone();
                let leave = send.clone();
                let end = send.clone();
                let rail_send = send.clone();
                let video = video.clone();
                let rail_video = video.clone();
                view()
                    .gap_3()
                    .child(ui::secondary(
                        "返回消息",
                        || false,
                        move || {
                            minimized.set(true);
                            return_to_messages();
                        },
                    ))
                    .child(
                        text(move || {
                            state
                                .get()
                                .room
                                .map(|r| {
                                    format!("会议号：{}（可选中复制后发送给受邀成员）", r.room_code)
                                })
                                .unwrap_or_default()
                        })
                        .selectable(true),
                    )
                    .child(ui::secondary(
                        "邀请成员",
                        || false,
                        move || {
                            selected.set(vec![]);
                            invite_open.set(true);
                        },
                    ))
                    .child(when(
                        move || invite_open.get(),
                        move || {
                            let invite_send = invite_send.clone();
                            ui::card()
                                .child(text("选择工作区成员"))
                                .child(each(
                                    move || {
                                        let v = state.get();
                                        v.contacts
                                            .into_iter()
                                            .filter(|c| {
                                                !v.room.as_ref().is_some_and(|r| {
                                                    r.members
                                                        .iter()
                                                        .any(|m| m.member_id == c.member_id)
                                                })
                                            })
                                            .collect::<Vec<_>>()
                                    },
                                    |c| c.member_id.clone(),
                                    move |contact, _| {
                                        button()
                                            .on_press(move || {
                                                let id = contact.get().member_id;
                                                let mut ids = selected.get();
                                                if ids.contains(&id) {
                                                    ids.retain(|i| i != &id);
                                                } else {
                                                    ids.push(id);
                                                }
                                                selected.set(ids);
                                            })
                                            .child(text(move || {
                                                let c = contact.get();
                                                format!(
                                                    "{} {}",
                                                    if selected.get().contains(&c.member_id) {
                                                        "☑"
                                                    } else {
                                                        "☐"
                                                    },
                                                    c.name
                                                )
                                            }))
                                    },
                                ))
                                .child(ui::action(
                                    "发送邀请",
                                    move || selected.get().is_empty(),
                                    move || {
                                        if let Some(r) = state.get().room {
                                            invite_send(MeetingCommand::Invite {
                                                room_id: r.room_id,
                                                member_ids: selected.get(),
                                            });
                                        }
                                        invite_open.set(false);
                                    },
                                ))
                                .child(ui::secondary(
                                    "取消邀请",
                                    || false,
                                    move || invite_open.set(false),
                                ))
                        },
                    ))
                    .child(
                        view()
                            .flex_row()
                            .flex_wrap()
                            .gap_3()
                            .p_4()
                            .rounded(px(10.0))
                            .bg(rgb(0x161513))
                            .text_color(rgb(0xFAF9F6))
                            .child(
                                view()
                                    .flex_1()
                                    .min_w(px(240.0))
                                    .min_h(px(260.0))
                                    .child(text(move || {
                                        let v = state.get();
                                        if v.suppress_screen_playback() {
                                            "你正在共享。此处已暂停显示共享画面。"
                                        } else if v
                                            .room
                                            .is_some_and(|r| r.members.iter().any(|m| m.sharing))
                                        {
                                            "共享优先 · 选择共享人"
                                        } else {
                                            "会议舞台 · 暂无屏幕共享"
                                        }
                                    }))
                                    .child(each(
                                        move || {
                                            let v = state.get();
                                            if v.suppress_screen_playback() {
                                                return Vec::new();
                                            }
                                            v.room
                                                .map(|r| {
                                                    let shares: Vec<_> = r
                                                        .members
                                                        .into_iter()
                                                        .filter(|m| m.sharing && !m.is_local)
                                                        .collect();
                                                    let choice = shared.get();
                                                    shares
                                                        .iter()
                                                        .find(|m| {
                                                            choice.as_ref()
                                                                == Some(&(
                                                                    m.member_id.clone(),
                                                                    m.join_id.clone(),
                                                                ))
                                                        })
                                                        .or(shares.first())
                                                        .cloned()
                                                        .into_iter()
                                                        .collect::<Vec<_>>()
                                                })
                                                .unwrap_or_default()
                                        },
                                        |m| (m.member_id.clone(), m.join_id.clone()),
                                        move |m, _| {
                                            let m = m.get();
                                            view()
                                                .child(text(format!("{} 正在共享", m.display_name)))
                                                .child(video(
                                                    &m.member_id,
                                                    &m.join_id,
                                                    Source::Screen,
                                                ))
                                        },
                                    ))
                                    .child(each(
                                        move || {
                                            let v = state.get();
                                            if v.suppress_screen_playback() {
                                                return Vec::new();
                                            }
                                            v.room
                                                .map(|r| {
                                                    r.members
                                                        .into_iter()
                                                        .filter(|m| m.sharing && !m.is_local)
                                                        .collect::<Vec<_>>()
                                                })
                                                .unwrap_or_default()
                                        },
                                        |m| (m.member_id.clone(), m.join_id.clone()),
                                        move |m, _| {
                                            button()
                                                .on_press(move || {
                                                    let m = m.get();
                                                    shared.set(Some((m.member_id, m.join_id)));
                                                })
                                                .child(text(move || {
                                                    format!("观看 {} 的共享", m.get().display_name)
                                                }))
                                        },
                                    )),
                            )
                            .child(view().w(px(230.0)).gap_2().child(each(
                                move || {
                                    state
                                        .get()
                                        .room
                                        .map(|r| r.members.into_iter().take(4).collect::<Vec<_>>())
                                        .unwrap_or_default()
                                },
                                |m| (m.member_id.clone(), m.join_id.clone()),
                                move |member, _| {
                                    let send = rail_send.clone();
                                    let video = rail_video.clone();
                                    view()
                                        .p_2()
                                        .border_1()
                                        .border_color(rgb(0x555555))
                                        .rounded(px(8.0))
                                        .child(text(move || {
                                            let m = member.get();
                                            format!(
                                                "{}{}{}",
                                                m.display_name,
                                                if m.is_host { " · 主持人" } else { "" },
                                                if m.is_local { " · 本人" } else { "" }
                                            )
                                        }))
                                        .child(text(move || {
                                            let m = member.get();
                                            format!(
                                                "麦克风{} · 摄像头{}",
                                                m.mic.label(),
                                                m.camera.label()
                                            )
                                        }))
                                        .child(text(move || member.get().edge.label()))
                                        .child(when(
                                            move || member.get().camera == DeviceState::On,
                                            move || {
                                                let m = member.get();
                                                video(&m.member_id, &m.join_id, Source::Camera)
                                            },
                                        ))
                                        .child(when(
                                            move || {
                                                !member.get().is_local
                                                    && member.get().edge.can_retry()
                                            },
                                            move || {
                                                let send = send.clone();
                                                ui::secondary(
                                                    "重试连接",
                                                    || false,
                                                    move || {
                                                        let m = member.get();
                                                        send(MeetingCommand::RetryEdge {
                                                            member_id: m.member_id,
                                                            join_id: m.join_id,
                                                        });
                                                    },
                                                )
                                            },
                                        ))
                                },
                            ))),
                    )
                    .child(text(move || {
                        format!(
                            "参会人数：{} / 4",
                            state.get().room.map(|r| r.members.len()).unwrap_or(0)
                        )
                    }))
                    .child(ui::secondary(
                        "离开会议",
                        || false,
                        move || leave(MeetingCommand::Leave),
                    ))
                    .child(when(
                        move || state.get().is_host(),
                        move || {
                            ui::secondary("结束会议（全体）", || false, move || confirm.set(true))
                        },
                    ))
                    .child(when(
                        move || confirm.get() && state.get().is_host(),
                        move || {
                            let end = end.clone();
                            dialog().on_cancel(move || confirm.set(false)).child(
                                ui::card()
                                    .child(text("确认结束全体会议？所有成员将离开。"))
                                    .child(ui::action(
                                        "确认结束",
                                        || false,
                                        move || {
                                            confirm.set(false);
                                            end(MeetingCommand::End);
                                        },
                                    ))
                                    .child(ui::secondary(
                                        "取消结束",
                                        || false,
                                        move || confirm.set(false),
                                    )),
                            )
                        },
                    ))
            },
        ))
        .child(when(
            move || state.get().local_sharing() && !minimized.get(),
            move || {
                let send = stop_share.clone();
                view()
                    .flex_row()
                    .justify_between()
                    .items_center()
                    .px_3()
                    .py_2()
                    .rounded(px(8.0))
                    .bg(rgb(0xF5C542))
                    .text_color(rgb(0x161513))
                    .child(text("你正在共享屏幕"))
                    .child(ui::secondary(
                        "停止共享",
                        move || state.get().device(Source::Screen) == DeviceState::Stopping,
                        move || {
                            send(MeetingCommand::StopShare);
                        },
                    ))
            },
        ))
        .child(when(
            move || share_open.get() && state.get().active() && !minimized.get(),
            move || {
                let send = device_send.clone();
                dialog().on_cancel(move || share_open.set(false)).child(
                    ui::card()
                        .child(ui::page_title("选择共享内容"))
                        .child(
                            view()
                                .flex_row()
                                .gap_2()
                                .child(ui::segment(
                                    "窗口",
                                    move || !share_screen_tab.get(),
                                    move || {
                                        share_screen_tab.set(false);
                                        share_selected.set(false);
                                    },
                                ))
                                .child(ui::segment(
                                    "整个屏幕",
                                    move || share_screen_tab.get(),
                                    move || {
                                        share_screen_tab.set(true);
                                    },
                                )),
                        )
                        .child(when(
                            move || !share_screen_tab.get(),
                            || ui::note(|| "当前设备仅支持共享屏幕。".into()),
                        ))
                        .child(when(
                            move || share_screen_tab.get(),
                            move || {
                                view()
                                    .gap_2()
                                    .child(ui::note(|| {
                                        "你的通知和打开的内容可能对参会者可见。".into()
                                    }))
                                    .child(
                                        button()
                                            .on_press(move || {
                                                share_selected.set(!share_selected.get_untracked())
                                            })
                                            .child(text(move || {
                                                if share_selected.get() {
                                                    format!("已选择 · {}", screen_name())
                                                } else {
                                                    screen_name().into()
                                                }
                                            })),
                                    )
                            },
                        ))
                        .child(
                            view()
                                .flex_row()
                                .gap_2()
                                .child(ui::secondary(
                                    "取消共享",
                                    || false,
                                    move || share_open.set(false),
                                ))
                                .child(ui::action(
                                    "开始共享",
                                    move || !share_selected.get() || !state.get().active(),
                                    move || {
                                        share_open.set(false);
                                        send(MeetingCommand::StartShare);
                                    },
                                )),
                        ),
                )
            },
        ))
        .child(
            view()
                .flex_row()
                .flex_wrap()
                .gap_2()
                .style_when(
                    move || {
                        (!state.get().active()
                            && !Source::ALL
                                .iter()
                                .any(|source| state.get().device(*source) != DeviceState::Off))
                            || minimized.get()
                    },
                    |style| style.hidden(),
                )
                .child(each(
                    move || Source::ALL.to_vec(),
                    |s| *s,
                    move |source, _| {
                        let send = dock_send.clone();
                        button()
                            .disabled(move || {
                                let v = state.get();
                                let s = source.get();
                                v.capability != Capability::Available
                                    || v.stopping
                                    || v.device(s).pending()
                                    || (s == Source::Screen && !v.active())
                            })
                            .on_press(move || {
                                let source = source.get();
                                let v = state.get();
                                let on = v.device(source) == DeviceState::Off
                                    && !(source == Source::Screen && v.local_sharing());
                                if source == Source::Screen && on {
                                    share_screen_tab.set(false);
                                    share_selected.set(false);
                                    share_open.set(true);
                                    return;
                                }
                                send(match source {
                                    Source::Screen => MeetingCommand::StopShare,
                                    _ => MeetingCommand::SetDevice { source, on },
                                });
                            })
                            .p_3()
                            .border_1()
                            .rounded(px(8.0))
                            .child(text(move || {
                                let s = source.get();
                                let d = state.get().device(s);
                                if s == Source::Screen
                                    && state.get().local_sharing()
                                    && !matches!(
                                        d,
                                        DeviceState::Stopping | DeviceState::StopUnconfirmed
                                    )
                                {
                                    "正在共享 · 停止共享".into()
                                } else {
                                    format!("{} · {}", s.label(), d.label())
                                }
                            }))
                    },
                )),
        )
}

fn permissions_settings() -> impl IntoElement {
    let settings = match std::env::consts::OS {
        "macos" => Some([
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        ]),
        "windows" => Some([
            "ms-settings:privacy-webcam",
            "ms-settings:privacy-microphone",
        ]),
        _ => None,
    };
    let mut controls = view().flex_row().flex_wrap().gap_2();
    if let Some([camera, microphone]) = settings {
        for (label, url) in [
            ("打开摄像头权限设置", camera),
            ("打开麦克风权限设置", microphone),
        ] {
            controls = controls.child(ui::secondary(
                label,
                || false,
                move || {
                    spawn(async move {
                        let _ = open_url(url).await;
                    });
                },
            ));
        }
    }
    controls
}

pub(super) fn screen_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "主屏幕"
    } else {
        "桌面区域（1280 × 720）"
    }
}

pub fn mini_bar(
    state: MeetingState,
    send: impl Fn(MeetingCommand) + Clone + 'static,
    minimized: Signal<bool>,
    restore: impl Fn() + Copy + 'static,
) -> impl IntoElement {
    let leave = send.clone();
    when(
        move || minimized.get() && state.get().active(),
        move || {
            let send = send.clone();
            let stop_share = send.clone();
            let leave = leave.clone();
            ui::card()
                .self_end()
                .m_3()
                .flex_row()
                .flex_wrap()
                .items_center()
                .style_when(
                    move || state.get().local_sharing(),
                    |style| style.bg(rgb(0xF5C542)).text_color(rgb(0x161513)),
                )
                .child(text(move || {
                    if state.get().local_sharing() {
                        "会议进行中 · 正在共享"
                    } else {
                        "会议进行中"
                    }
                }))
                .child(when(
                    move || state.get().local_sharing(),
                    move || {
                        let stop_share = stop_share.clone();
                        ui::secondary(
                            "停止共享",
                            move || state.get().device(Source::Screen) == DeviceState::Stopping,
                            move || {
                                state.prepare(&MeetingCommand::StopShare);
                                stop_share(MeetingCommand::StopShare);
                            },
                        )
                    },
                ))
                .child(ui::secondary(
                    "静音",
                    move || state.get().device(Source::Mic) != DeviceState::On,
                    move || {
                        let command = MeetingCommand::SetDevice {
                            source: Source::Mic,
                            on: false,
                        };
                        state.prepare(&command);
                        send(command);
                    },
                ))
                .child(ui::secondary(
                    "返回会议",
                    || false,
                    move || {
                        minimized.set(false);
                        restore();
                    },
                ))
                .child(ui::danger(
                    "离开会议",
                    || false,
                    move || {
                        state.prepare(&MeetingCommand::Leave);
                        leave(MeetingCommand::Leave);
                    },
                ))
        },
    )
}
