use super::*;
use nsh_core::prelude::*;
use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;
use std::{cell::RefCell, rc::Rc};

fn room() -> RoomSnapshot {
    let mut mock = mock::MockMeeting::default();
    mock.handle(MeetingCommand::Create);
    mock.room.unwrap()
}

#[test]
fn snapshot_versions_only_advance() {
    let mut view = MeetingView::default();
    let mut r = room();
    r.version = 3;
    view.apply(MeetingUpdate::Snapshot(r.clone()));
    r.version = 2;
    r.members.clear();
    view.apply(MeetingUpdate::Snapshot(r.clone()));
    assert_eq!(view.room.as_ref().unwrap().members.len(), 1);
    r.version = 3;
    view.apply(MeetingUpdate::Snapshot(r));
    assert_eq!(view.room.unwrap().version, 3);
}

#[test]
fn participant_end_adds_the_room_to_recently_ended() {
    let mut view = MeetingView::default();
    let room = room();
    let code = room.room_code.clone();
    view.apply(MeetingUpdate::Snapshot(room));
    view.apply(MeetingUpdate::Ended { by_host: false });
    assert_eq!(view.recently_ended, vec![code]);
    assert!(view.room.is_none());
    assert_eq!(view.notice.as_deref(), Some("会议已结束"));
}

#[component]
fn StopPreview() -> impl IntoElement {
    let state = MeetingState::new();
    state.apply(MeetingUpdate::Capability(Capability::Available));
    state.apply(MeetingUpdate::Snapshot(room()));
    state.apply(MeetingUpdate::Device {
        source: Source::Mic,
        state: DeviceState::On,
    });
    meeting_page(
        state,
        move |cmd| {
            if cmd == MeetingCommand::Leave {
                assert_eq!(state.get().device(Source::Mic), DeviceState::Stopping);
                assert!(!state.get().active());
                state.apply(MeetingUpdate::Left);
                state.apply(MeetingUpdate::Device {
                    source: Source::Mic,
                    state: DeviceState::StopUnconfirmed,
                });
            }
        },
        Rc::new(placeholder_video),
    )
}

#[test]
fn local_leave_disables_display_before_dispatch_and_retains_privacy_ui() -> Result<(), String> {
    let mut app =
        Headless::start(EngineConfig::new(Root::of::<StopPreview>())).map_err(|e| e.to_string())?;
    app.set_viewport(Size::new(px(1400.0), px(1200.0)))?;
    app.press("离开会议")?;
    app.wait_for("已离开会议")?;
    app.wait_for("隐私告警：麦克风停止未确认，请检查系统设备指示灯。")?;
    app.press("麦克风 · 停止未确认，请检查系统设备指示灯")?;
    app.wait_for("隐私告警：麦克风停止未确认，请检查系统设备指示灯。")?;
    assert!(app.press("立即开会").is_err());
    Ok(())
}

#[test]
fn errors_and_capacity_do_not_leak_rooms() {
    let mut mock = mock::MockMeeting::default();
    let missing = mock.handle(MeetingCommand::Join {
        room_code: "未知".into(),
    });
    mock.handle(MeetingCommand::Create);
    assert_eq!(
        missing,
        mock.handle(MeetingCommand::Join {
            room_code: "未邀请".into()
        })
    );
    assert_eq!(
        MeetingError::NotFoundOrNotInvited.message(),
        "无法加入会议，请检查会议号或联系邀请人。"
    );
    for i in 0..3 {
        mock.add_member(Contact {
            member_id: i.to_string(),
            name: i.to_string(),
        });
    }
    assert_eq!(
        mock.add_member(Contact {
            member_id: "第五人".into(),
            name: "第五人".into()
        }),
        vec![MeetingUpdate::Error(MeetingError::Full)]
    );
}

#[test]
fn devices_stop_without_claiming_off_and_host_retry_gates() {
    let mut view = MeetingView::default();
    assert!(
        Source::ALL
            .iter()
            .all(|s| view.device(*s) == DeviceState::Off)
    );
    view.apply(MeetingUpdate::Snapshot(room()));
    assert!(view.is_host());
    view.apply(MeetingUpdate::Device {
        source: Source::Mic,
        state: DeviceState::On,
    });
    view.apply(MeetingUpdate::Left);
    assert_eq!(view.device(Source::Mic), DeviceState::Stopping);
    view.apply(MeetingUpdate::Device {
        source: Source::Mic,
        state: DeviceState::StopUnconfirmed,
    });
    assert_ne!(view.device(Source::Mic).label(), "已关闭");
    view.apply(MeetingUpdate::Device {
        source: Source::Mic,
        state: DeviceState::On,
    });
    assert_eq!(view.device(Source::Mic), DeviceState::StopUnconfirmed);
    let mut stale = room();
    stale.version = 99;
    view.apply(MeetingUpdate::Snapshot(stale));
    assert!(view.room.is_none());
    assert!(!view.is_host());
    for edge in [
        EdgeStatus::Connecting,
        EdgeStatus::Direct,
        EdgeStatus::Relay,
        EdgeStatus::Unknown,
        EdgeStatus::Failed { retryable: false },
    ] {
        assert!(!edge.can_retry());
    }
    assert!(EdgeStatus::Failed { retryable: true }.can_retry());
}

#[component]
fn GuestPreview() -> impl IntoElement {
    let state = MeetingState::new();
    state.apply(MeetingUpdate::Capability(Capability::Available));
    let mut mock = mock::MockMeeting::default();
    mock.handle(MeetingCommand::Create);
    mock.add_member(Contact {
        member_id: "林晓".into(),
        name: "林晓".into(),
    });
    mock.add_member(Contact {
        member_id: "陈默".into(),
        name: "陈默".into(),
    });
    let mut r = mock.room.unwrap();
    r.host = "林晓".into();
    for m in &mut r.members {
        m.is_host = m.member_id == r.host;
    }
    r.members[1].edge = EdgeStatus::Relay;
    r.members[2].edge = EdgeStatus::Failed { retryable: true };
    r.members[1].sharing = true;
    r.members[2].sharing = true;
    state.apply(MeetingUpdate::Snapshot(r));
    meeting_page(state, |_| {}, Rc::new(placeholder_video))
}

#[test]
fn guest_edges_and_multiple_share_selection_ui() -> Result<(), String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<GuestPreview>()))
        .map_err(|e| e.to_string())?;
    app.set_viewport(Size::new(px(1400.0), px(1200.0)))?;
    app.wait_for("参会人数：3 / 4")?;
    app.wait_for("中继")?;
    app.wait_for("连接失败")?;
    app.wait_for("重试连接")?;
    assert!(!app.shows("结束会议（全体）"));
    app.wait_for("林晓 正在共享")?;
    app.press("观看 陈默 的共享")?;
    app.wait_for("陈默 正在共享")?;
    assert!(!app.shows("林晓 正在共享"));
    Ok(())
}

#[component]
fn Preview() -> impl IntoElement {
    let state = MeetingState::new();
    state.apply(MeetingUpdate::Capability(Capability::Available));
    state.apply(MeetingUpdate::Contacts(vec![
        Contact {
            member_id: "林晓".into(),
            name: "林晓".into(),
        },
        Contact {
            member_id: "陈默".into(),
            name: "陈默".into(),
        },
    ]));
    let mock = Rc::new(RefCell::new(mock::MockMeeting::default()));
    view().child(meeting_page(
        state,
        move |cmd| {
            if matches!(&cmd, MeetingCommand::Join { room_code } if room_code == "RETRY001") {
                state.apply(MeetingUpdate::Error(MeetingError::Retryable {
                    msg: "请检查网络".into(),
                }));
                return;
            }
            for update in mock.borrow_mut().handle(cmd) {
                state.apply(update);
            }
        },
        Rc::new(placeholder_video),
    ))
}

#[component]
fn UnavailablePreview() -> impl IntoElement {
    let state = MeetingState::new();
    state.apply(MeetingUpdate::Capability(Capability::Unavailable {
        reason: UnavailableReason::VersionDisabled,
    }));
    meeting_page(state, |_| {}, Rc::new(placeholder_video))
}

fn start_preview() -> Result<Headless, String> {
    let mut app =
        Headless::start(EngineConfig::new(Root::of::<Preview>())).map_err(|e| e.to_string())?;
    app.set_viewport(Size::new(px(1400.0), px(1200.0)))?;
    Ok(app)
}

#[test]
fn unavailable_ui_explains_why() -> Result<(), String> {
    let mut app = Headless::start(EngineConfig::new(Root::of::<UnavailablePreview>()))
        .map_err(|e| e.to_string())?;
    app.wait_for(UnavailableReason::VersionDisabled.message())?;
    assert!(app.press("立即开会").is_err());
    assert!(app.press("加入").is_err());
    Ok(())
}

#[test]
fn create_invite_share_end_and_leave_ui() -> Result<(), String> {
    let mut app = start_preview()?;
    assert!(app.press("加入").is_err());
    app.press("立即开会")?;
    app.wait_for("会前检查")?;
    assert!(!app.shows("我 · 主持人 · 本人"));
    app.press_key("escape")?;
    assert!(!app.shows("会前检查"));
    app.press("立即开会")?;
    app.press("确认入会")?;
    app.wait_for("我 · 主持人 · 本人")?;
    app.press("邀请成员")?;
    app.press("☐ 林晓")?;
    app.press("☐ 陈默")?;
    app.press("发送邀请")?;
    app.wait_for("参会人数：3 / 4")?;
    app.wait_for("直连")?;
    app.press("屏幕共享 · 已关闭")?;
    assert!(app.press("开始共享").is_err());
    app.press("整个屏幕")?;
    app.wait_for("你的通知和打开的内容可能对参会者可见。")?;
    app.press(super::page::screen_name())?;
    app.press("开始共享")?;
    app.wait_for("你正在共享屏幕")?;
    assert!(!app.shows("我 · 屏幕共享画面占位"));
    app.press("停止共享")?;
    app.wait_for("会议舞台 · 暂无屏幕共享")?;
    app.press("结束会议（全体）")?;
    app.wait_for("确认结束全体会议？所有成员将离开。")?;
    app.press("取消结束")?;
    app.wait_for("参会人数：3 / 4")?;
    app.press("结束会议（全体）")?;
    app.press("确认结束")?;
    app.wait_for("主持人已结束会议")?;
    app.press("立即开会")?;
    app.press("确认入会")?;
    app.press("离开会议")?;
    app.wait_for("已离开会议")?;
    app.wait_for("立即开会")?;
    Ok(())
}

#[test]
fn join_by_code_and_reject_unknown_ui() -> Result<(), String> {
    let mut app = start_preview()?;
    app.type_text("text:输入会议号", "未知")?;
    assert!(app.press("加入").is_err());
    app.clear("text:未知")?;
    app.type_text("text:输入会议号", "MISSING1")?;
    app.press("加入")?;
    app.press("确认入会")?;
    app.wait_for(&MeetingError::NotFoundOrNotInvited.message())?;
    app.press("关闭提示")?;
    app.press("立即开会")?;
    app.press("确认入会")?;
    app.press("离开会议")?;
    app.clear("text:MISSING1")?;
    app.type_text("text:输入会议号", "MEET0001")?;
    app.press("加入")?;
    app.press("确认入会")?;
    app.wait_for("参会人数：1 / 4")?;
    app.wait_for("结束会议（全体）")?;
    Ok(())
}

#[test]
fn joining_again_after_retryable_error_requires_confirmation() -> Result<(), String> {
    let mut app = start_preview()?;
    app.type_text("text:输入会议号", "RETRY001")?;
    app.press("加入")?;
    app.press("确认入会")?;
    app.wait_for("操作失败：请检查网络")?;
    app.press("重试")?;
    app.wait_for("会前检查")?;
    app.press("取消")?;
    assert!(!app.shows("会前检查"));
    Ok(())
}
