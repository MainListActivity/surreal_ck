use super::*;
use crate::ui;
use nsh_base::{button, dialog};
use nsh_core::{element::AnyElement, prelude::*};
use std::rc::Rc;

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

pub fn meeting_page(
    state: MeetingState,
    send: impl Fn(MeetingCommand) + Clone + 'static,
    video: VideoSlot,
) -> impl IntoElement {
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
    let request: Send = {
        let send = send.clone();
        Rc::new(move |cmd| {
            if !matches!(cmd, MeetingCommand::DismissError) {
                retry.set(Some(cmd.clone()));
            }
            send(cmd);
        })
    };
    let pre_send = request.clone();
    let join_send = request.clone();
    let invitation_send = request.clone();
    let error_send = request.clone();
    let dismiss = request.clone();
    let active_send = request.clone();
    let device_send = request.clone();
    view()
        .gap_3()
        .p_4()
        .child(ui::page_header("会议", || {
            "邀请工作区成员，最多 4 人；允许关闭设备入会。".into()
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
                                        send(cmd);
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
                let create = pre_send.clone();
                let join = join_send.clone();
                let invitation_send = invitation_send.clone();
                view()
                    .gap_3()
                    .child(ui::note(move || match state.get().capability {
                        Capability::Available => "设备默认关闭；首次开启将由系统申请权限。".into(),
                        Capability::Unavailable { reason } => reason.message().into(),
                    }))
                    .child(ui::action(
                        "开始会议",
                        move || !state.get().can_enter(),
                        move || create(MeetingCommand::Create),
                    ))
                    .child(
                        view()
                            .flex_row()
                            .gap_2()
                            .child(ui::field(code, "输入会议号"))
                            .child(ui::secondary(
                                "加入",
                                move || !state.get().can_enter() || code.get().trim().is_empty(),
                                move || {
                                    join(MeetingCommand::Join {
                                        room_code: code.get().trim().into(),
                                    })
                                },
                            )),
                    )
                    .child(ui::section_label("收到的邀请"))
                    .child(each(
                        move || state.get().invitations,
                        |i| i.room_code.clone(),
                        move |invitation, _| {
                            let send = invitation_send.clone();
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
                                        send(MeetingCommand::Join {
                                            room_code: invitation.get().room_code,
                                        })
                                    },
                                ))
                        },
                    ))
            },
        ))
        .child(when(
            move || state.get().active(),
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
                                        let r = state.get().room;
                                        if r.is_some_and(|r| r.members.iter().any(|m| m.sharing)) {
                                            "共享优先 · 选择共享人"
                                        } else {
                                            "会议舞台 · 暂无屏幕共享"
                                        }
                                    }))
                                    .child(each(
                                        move || {
                                            state
                                                .get()
                                                .room
                                                .map(|r| {
                                                    let shares: Vec<_> = r
                                                        .members
                                                        .into_iter()
                                                        .filter(|m| m.sharing)
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
                                            state
                                                .get()
                                                .room
                                                .map(|r| {
                                                    r.members
                                                        .into_iter()
                                                        .filter(|m| m.sharing)
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
        .child(view().flex_row().flex_wrap().gap_2().child(each(
            move || Source::ALL.to_vec(),
            |s| *s,
            move |source, _| {
                let send = device_send.clone();
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
                        send(match source {
                            Source::Screen if on => MeetingCommand::StartShare,
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
                            && !matches!(d, DeviceState::Stopping | DeviceState::StopUnconfirmed)
                        {
                            "正在共享 · 停止共享".into()
                        } else {
                            format!("{} · {}", s.label(), d.label())
                        }
                    }))
            },
        )))
        .child(ui::note(|| {
            "屏幕共享由系统选择器授权，默认仅共享所选窗口，请确认预览内容；整个屏幕可能包含通知。"
                .into()
        }))
}
