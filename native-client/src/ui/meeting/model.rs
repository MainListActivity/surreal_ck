use nsh_core::prelude::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, PartialEq, Debug)]
pub enum UnavailableReason {
    VersionDisabled,
    SignedOut,
    NoWorkspace,
    SchemaNotMigrated,
    UnsupportedPlatform,
}

impl UnavailableReason {
    pub fn message(&self) -> &'static str {
        match self {
            Self::VersionDisabled => "此版本未启用会议功能，请使用已启用会议的企业包。",
            Self::SignedOut => "请先登录企业账号，再发起或加入会议。",
            Self::NoWorkspace => "请先选择工作区，再发起或加入会议。",
            Self::SchemaNotMigrated => "当前工作区尚未迁移会议 schema，请联系管理员。",
            Self::UnsupportedPlatform => "当前平台不支持原生会议。",
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
pub enum Capability {
    Available,
    Unavailable { reason: UnavailableReason },
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Source {
    Mic,
    Camera,
    Screen,
}

impl Source {
    pub const ALL: [Self; 3] = [Self::Mic, Self::Camera, Self::Screen];
    pub fn label(self) -> &'static str {
        match self {
            Self::Mic => "麦克风",
            Self::Camera => "摄像头",
            Self::Screen => "屏幕共享",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub enum DeviceState {
    #[default]
    Off,
    Starting,
    On,
    Stopping,
    StopUnconfirmed,
}

impl DeviceState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "已关闭",
            Self::Starting => "启动中",
            Self::On => "已开启",
            Self::Stopping => "停止中",
            Self::StopUnconfirmed => "停止未确认，请检查系统设备指示灯",
        }
    }
    pub fn pending(self) -> bool {
        matches!(self, Self::Starting | Self::Stopping)
    }
}

#[derive(Clone, PartialEq, Debug)]
pub enum EdgeStatus {
    Connecting,
    Direct,
    Relay,
    Failed { retryable: bool },
    Unknown,
}

impl EdgeStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Connecting => "连接中",
            Self::Direct => "直连",
            Self::Relay => "中继",
            Self::Failed { .. } => "连接失败",
            Self::Unknown => "路径未知",
        }
    }
    pub fn can_retry(&self) -> bool {
        matches!(self, Self::Failed { retryable: true })
    }
}

#[derive(Clone, PartialEq, Debug)]
pub enum RoomState {
    Active,
    Ended,
    Expired,
}

#[derive(Clone, PartialEq, Debug)]
pub struct MemberView {
    pub member_id: String,
    pub display_name: String,
    pub join_id: String,
    pub is_host: bool,
    pub is_local: bool,
    pub mic: DeviceState,
    pub camera: DeviceState,
    pub sharing: bool,
    pub edge: EdgeStatus,
}

#[derive(Clone, PartialEq, Debug)]
pub struct RoomSnapshot {
    pub room_id: String,
    pub room_code: String,
    pub version: u64,
    pub state: RoomState,
    pub host: String,
    pub local_join_id: Option<String>,
    pub members: Vec<MemberView>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Invitation {
    pub room_code: String,
    pub host_name: String,
    pub invited_at: String,
}
#[derive(Clone, PartialEq, Debug)]
pub struct Contact {
    pub member_id: String,
    pub name: String,
}

#[derive(Clone, PartialEq, Debug)]
pub enum MeetingError {
    Unavailable(UnavailableReason),
    NotFoundOrNotInvited,
    Full,
    Expired,
    SelfInvite,
    Retryable { msg: String },
}
impl MeetingError {
    pub fn message(&self) -> String {
        match self {
            Self::Unavailable(reason) => reason.message().to_owned(),
            Self::NotFoundOrNotInvited => "无法加入会议，请检查会议号或联系邀请人。".to_owned(),
            Self::Full => "会议已满员，最多支持 4 人。".to_owned(),
            Self::Expired => "会期已失效，请重新创建会议。".to_owned(),
            Self::SelfInvite => "无法邀请自己参加会议。".to_owned(),
            Self::Retryable { msg } => format!("操作失败：{msg}"),
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
pub enum MeetingCommand {
    Create,
    CreateFor {
        member_id: String,
    },
    Invite {
        room_id: String,
        member_ids: Vec<String>,
    },
    Join {
        room_code: String,
    },
    SetDevice {
        source: Source,
        on: bool,
    },
    /// 用户已明确选择当前平台提供的桌面采集源。
    StartShare,
    StopShare,
    RetryEdge {
        member_id: String,
        join_id: String,
    },
    Leave,
    End,
    DismissError,
}

#[derive(Clone, PartialEq, Debug)]
pub enum MeetingUpdate {
    Capability(Capability),
    Invitations(Vec<Invitation>),
    Contacts(Vec<Contact>),
    LocalMember(String),
    Snapshot(RoomSnapshot),
    ManagedIceUnavailable(bool),
    Device { source: Source, state: DeviceState },
    Error(MeetingError),
    Left,
    Ended { by_host: bool },
}

#[derive(Clone, PartialEq, Debug)]
pub struct MeetingView {
    pub capability: Capability,
    pub invitations: Vec<Invitation>,
    pub contacts: Vec<Contact>,
    pub local_member: Option<String>,
    pub room: Option<RoomSnapshot>,
    pub recently_ended: Vec<String>,
    pub managed_ice_unavailable: bool,
    pub devices: BTreeMap<Source, DeviceState>,
    pub error: Option<MeetingError>,
    pub notice: Option<String>,
    pub stopping: bool,
    versions: BTreeMap<String, u64>,
    retired_joins: BTreeSet<(String, String)>,
}

impl Default for MeetingView {
    fn default() -> Self {
        Self {
            capability: Capability::Unavailable {
                reason: UnavailableReason::SignedOut,
            },
            invitations: vec![],
            contacts: vec![],
            local_member: None,
            room: None,
            recently_ended: vec![],
            managed_ice_unavailable: false,
            devices: Source::ALL
                .into_iter()
                .map(|s| (s, DeviceState::Off))
                .collect(),
            error: None,
            notice: None,
            stopping: false,
            versions: BTreeMap::new(),
            retired_joins: BTreeSet::new(),
        }
    }
}

impl MeetingView {
    pub fn device(&self, source: Source) -> DeviceState {
        self.devices[&source]
    }
    pub fn active(&self) -> bool {
        !self.stopping
            && self
                .room
                .as_ref()
                .is_some_and(|r| r.state == RoomState::Active && r.local_join_id.is_some())
    }
    pub fn can_enter(&self) -> bool {
        self.capability == Capability::Available
            && self.room.is_none()
            && !self.stopping
            && !self
                .devices
                .values()
                .any(|d| matches!(d, DeviceState::Stopping | DeviceState::StopUnconfirmed))
    }
    pub fn is_host(&self) -> bool {
        self.active()
            && self.room.as_ref().is_some_and(|r| {
                r.members.iter().any(|m| {
                    m.is_local
                        && m.member_id == r.host
                        && Some(&m.join_id) == r.local_join_id.as_ref()
                })
            })
    }
    pub fn local_sharing(&self) -> bool {
        self.device(Source::Screen) == DeviceState::On
            || self
                .room
                .as_ref()
                .is_some_and(|r| r.members.iter().any(|m| m.is_local && m.sharing))
    }
    pub fn suppress_screen_playback(&self) -> bool {
        self.device(Source::Screen) != DeviceState::Off || self.local_sharing()
    }
    fn remember_ended(&mut self, code: String) {
        self.recently_ended.retain(|previous| previous != &code);
        self.recently_ended.insert(0, code);
        self.recently_ended.truncate(5);
    }
    fn stop(&mut self) {
        self.stopping = true;
        if let Some(r) = &self.room
            && let Some(join) = &r.local_join_id
        {
            self.retired_joins.insert((r.room_id.clone(), join.clone()));
        }
        for device in self.devices.values_mut() {
            if !matches!(device, DeviceState::Off | DeviceState::StopUnconfirmed) {
                *device = DeviceState::Stopping;
            }
        }
    }
    pub fn apply(&mut self, update: MeetingUpdate) {
        match update {
            MeetingUpdate::Capability(c) => {
                if c != Capability::Available {
                    self.local_member = None;
                    self.recently_ended.clear();
                    self.stop();
                    self.room = None;
                    self.managed_ice_unavailable = false;
                } else if self.room.is_none() {
                    self.stopping = false;
                }
                self.capability = c;
            }
            MeetingUpdate::Invitations(i) => self.invitations = i,
            MeetingUpdate::Contacts(c) => self.contacts = c,
            MeetingUpdate::LocalMember(id) => self.local_member = Some(id),
            MeetingUpdate::ManagedIceUnavailable(unavailable) => {
                self.managed_ice_unavailable = unavailable;
            }
            MeetingUpdate::Snapshot(r) => {
                if r.state == RoomState::Active
                    && r.local_join_id.as_ref().is_some_and(|join| {
                        self.retired_joins
                            .contains(&(r.room_id.clone(), join.clone()))
                    })
                {
                    return;
                }
                // 只丢严格更旧的快照：同版本 room.version 内边状态/设备状态会变化，
                // 用 >= 会把这些更新全部吞掉（复验时 UI 卡「连接中」的根因）。
                if self
                    .versions
                    .get(&r.room_id)
                    .is_some_and(|v| *v > r.version)
                {
                    return;
                }
                self.versions.insert(r.room_id.clone(), r.version);
                if r.state != RoomState::Active || r.local_join_id.is_none() {
                    if r.state == RoomState::Ended {
                        self.remember_ended(r.room_code.clone());
                    }
                    self.stop();
                    self.notice = Some(
                        if r.state == RoomState::Expired {
                            "会议已过期"
                        } else {
                            "会议已结束"
                        }
                        .into(),
                    );
                    self.room = None;
                    self.stopping = false;
                } else if !self.stopping {
                    self.room = Some(r);
                    self.notice = None;
                    self.error = None;
                }
            }
            MeetingUpdate::Device { source, state } => {
                if (self.stopping
                    || matches!(
                        self.device(source),
                        DeviceState::Stopping | DeviceState::StopUnconfirmed
                    ))
                    && matches!(state, DeviceState::Starting | DeviceState::On)
                {
                    return;
                }
                self.devices.insert(source, state);
            }
            MeetingUpdate::Error(e) => {
                if let MeetingError::Unavailable(reason) = &e {
                    self.capability = Capability::Unavailable {
                        reason: reason.clone(),
                    };
                }
                if matches!(e, MeetingError::Expired | MeetingError::Unavailable(_)) {
                    self.stop();
                    self.room = None;
                    self.stopping = false;
                }
                self.error = Some(e);
            }
            MeetingUpdate::Left | MeetingUpdate::Ended { .. } => {
                if matches!(update, MeetingUpdate::Ended { .. })
                    && let Some(room) = &self.room
                {
                    self.remember_ended(room.room_code.clone());
                }
                self.stop();
                self.room = None;
                self.managed_ice_unavailable = false;
                self.stopping = false;
                self.notice = Some(
                    match update {
                        MeetingUpdate::Ended { by_host: true } => "主持人已结束会议",
                        MeetingUpdate::Ended { by_host: false } => "会议已结束",
                        _ => "已离开会议",
                    }
                    .into(),
                );
            }
        }
    }
}

#[derive(Clone, Copy)]
pub struct MeetingState(pub Signal<MeetingView>);
impl Default for MeetingState {
    fn default() -> Self {
        Self::new()
    }
}
impl MeetingState {
    pub fn new() -> Self {
        Self(signal(MeetingView::default()))
    }
    pub fn get(self) -> MeetingView {
        self.0.get()
    }
    pub fn apply(self, update: MeetingUpdate) {
        let mut v = self.get();
        v.apply(update);
        self.0.set(v);
    }
    /// 必须先更新本机显示，再将命令交给 actor；actor 仍须优先禁用真实发送。
    pub fn prepare(self, command: &MeetingCommand) {
        let mut v = self.get();
        match command {
            MeetingCommand::Create
            | MeetingCommand::CreateFor { .. }
            | MeetingCommand::Join { .. } => {
                v.error = None;
            }
            MeetingCommand::Leave | MeetingCommand::End => v.stop(),
            MeetingCommand::SetDevice { source, on } => {
                if v.device(*source) == DeviceState::StopUnconfirmed {
                    return;
                }
                v.devices.insert(
                    *source,
                    if *on {
                        DeviceState::Starting
                    } else {
                        DeviceState::Stopping
                    },
                );
            }
            MeetingCommand::StopShare => {
                if v.device(Source::Screen) == DeviceState::StopUnconfirmed {
                    return;
                }
                v.devices.insert(Source::Screen, DeviceState::Stopping);
            }
            MeetingCommand::DismissError => v.error = None,
            _ => {}
        }
        self.0.set(v);
    }
}
