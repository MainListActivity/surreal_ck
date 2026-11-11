//! 真实媒体控制面板。按钮发出请求与设备确认分离，失败不擦除采集隐私指示。
use crate::{
    bridge::Command,
    call_bridge::{self, Control, Notice, Source},
    ui,
};
use async_channel::Sender;
use nsh_base::theme;
use nsh_core::prelude::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Request {
    #[default]
    None,
    Start,
    Stop,
}

/// 只由明确的 Capture 通知修改 active；错误和断线只能增加不确定性。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CaptureState {
    active: bool,
    request: Request,
    close_unconfirmed: bool,
}
impl CaptureState {
    fn attention(self) -> bool {
        self.active || self.request != Request::None || self.close_unconfirmed
    }
    fn can_start(self) -> bool {
        !self.attention()
    }
    fn requested(&mut self, start: bool) {
        self.request = if start { Request::Start } else { Request::Stop };
    }
    fn confirmed(&mut self, active: bool) {
        self.active = active;
        if !active {
            self.request = Request::None;
            self.close_unconfirmed = false;
        } else if self.request != Request::Stop {
            // 先前发出的停止请求不能被晚到的启动确认覆盖。
            self.request = Request::None;
        }
    }
    fn failed(&mut self) {
        if self.attention() {
            self.close_unconfirmed = true;
        }
        self.request = Request::None;
    }
    fn session_stopped(&mut self, _confirmed: bool) {
        // 总会话回执不能替代逐个设备的关闭通知。
        self.failed();
    }
    #[cfg(feature = "experimental-enterprise-media")]
    fn authoritative(&mut self, status: call_bridge::CapturePhase) {
        use call_bridge::CapturePhase;
        match status {
            CapturePhase::Stopped => self.confirmed(false),
            CapturePhase::Running => {
                self.confirmed(true);
                self.close_unconfirmed = false;
            }
            CapturePhase::Starting => self.requested(true),
            CapturePhase::Stopping => self.requested(false),
            CapturePhase::Unconfirmed => {
                self.close_unconfirmed = true;
                self.request = Request::None;
            }
        }
    }

    #[cfg(feature = "experimental-enterprise-media")]
    fn authoritative_operation(
        &mut self,
        status: call_bridge::CapturePhase,
        pending: PendingOperation,
        completed: u64,
        final_read: bool,
    ) -> bool {
        let clear = pending.completed_by(completed, final_read);
        let request = self.request;
        self.authoritative(status);
        if !clear {
            self.request = request;
        }
        clear
    }

    fn label(self) -> &'static str {
        if self.close_unconfirmed {
            "关闭未获确认：设备可能仍在采集，请重试停止或检查系统隐私设置"
        } else if self.request == Request::Stop {
            "正在请求停止，设备关闭尚未确认"
        } else if self.active {
            "采集已启动，向当前对端发送已启用"
        } else if self.request == Request::Start {
            "正在启用设备，等待真实采集确认"
        } else {
            "未启用"
        }
    }
}

fn index(source: Source) -> usize {
    match source {
        Source::Microphone => 0,
        Source::Camera => 1,
        Source::Screen => 2,
    }
}
fn name(source: Source) -> &'static str {
    match source {
        Source::Microphone => "麦克风",
        Source::Camera => "摄像头",
        Source::Screen => "屏幕共享",
    }
}

#[cfg(feature = "experimental-enterprise-media")]
type EnterpriseCursor = (u64, u64, [(u64, u64); 3]);
#[cfg(feature = "experimental-enterprise-media")]
type PlaybackCursor = (u64, [(u64, u64); 3]);

#[cfg(feature = "experimental-enterprise-media")]
fn replay_source(
    previous: Option<(u64, u64)>,
    revision: u64,
    completed: u64,
    final_read: bool,
) -> bool {
    // final_read表示关闭后重新读取真实源状态，而非从关闭成功合成Stopped。
    final_read
        || previous.is_none_or(|(old_revision, old_completed)| {
            revision > old_revision || completed != old_completed
        })
}

#[cfg(feature = "experimental-enterprise-media")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum PendingOperation {
    #[default]
    None,
    Unsubmitted {
        ticket: u64,
    },
    Submitted {
        ticket: u64,
        operation: u64,
    },
}
#[cfg(feature = "experimental-enterprise-media")]
impl PendingOperation {
    fn matches_ticket(self, value: u64) -> bool {
        matches!(self, Self::Unsubmitted { ticket } | Self::Submitted { ticket, .. } if ticket == value)
    }
    fn submitted(self, ticket: u64, operation: u64) -> Self {
        if self == (Self::Unsubmitted { ticket }) {
            Self::Submitted { ticket, operation }
        } else {
            self
        }
    }
    fn completed_by(self, operation: u64, final_read: bool) -> bool {
        final_read
            || match self {
                Self::None => true,
                Self::Unsubmitted { .. } => false,
                Self::Submitted {
                    operation: expected,
                    ..
                } => expected == operation,
            }
    }
}
#[cfg(feature = "experimental-enterprise-media")]
fn operation_slot(control: &Control) -> Option<usize> {
    match control.action() {
        Control::Start { source, .. } | Control::Stop(source) => Some(index(*source)),
        Control::RemoteAudio(_) => Some(3),
        Control::RemoteVideo(_) => Some(4),
        _ => None,
    }
}

#[derive(Clone, Copy)]
pub struct CallUi {
    expanded: Signal<bool>,
    selections: [Signal<String>; 3],
    requested_targets: [Signal<String>; 3],
    captures: [Signal<CaptureState>; 3],
    remote_audio: Signal<bool>,
    remote_video: Signal<bool>,
    audio_pending: Signal<Option<bool>>,
    video_pending: Signal<Option<bool>>,
    audio_unconfirmed: Signal<bool>,
    video_unconfirmed: Signal<bool>,
    camera_stream: Signal<Option<String>>,
    screen_stream: Signal<Option<String>>,
    camera_received: Signal<bool>,
    screen_received: Signal<bool>,
    status: Signal<String>,
    #[cfg(feature = "experimental-enterprise-media")]
    enterprise_snapshot: Signal<Option<EnterpriseCursor>>,
    #[cfg(feature = "experimental-enterprise-media")]
    enterprise_playback: Signal<Option<PlaybackCursor>>,
    #[cfg(feature = "experimental-enterprise-media")]
    enterprise_pending: Signal<[PendingOperation; 5]>,
    #[cfg(feature = "experimental-enterprise-media")]
    enterprise_ticket: Signal<u64>,
}
impl CallUi {
    /// 必须在 NSH 组件作用域内调用。设备字段、权限和接收开关不从环境自动填充。
    pub fn new() -> Self {
        Self {
            expanded: signal(false),
            selections: std::array::from_fn(|_| signal(String::new())),
            requested_targets: std::array::from_fn(|_| signal(String::new())),
            captures: std::array::from_fn(|_| signal(CaptureState::default())),
            remote_audio: signal(false),
            remote_video: signal(false),
            audio_pending: signal(None),
            video_pending: signal(None),
            audio_unconfirmed: signal(false),
            video_unconfirmed: signal(false),
            camera_stream: signal(None),
            screen_stream: signal(None),
            camera_received: signal(false),
            screen_received: signal(false),
            status: signal("设备未启用；远端音频和视频默认关闭。".into()),
            #[cfg(feature = "experimental-enterprise-media")]
            enterprise_snapshot: signal(None),
            #[cfg(feature = "experimental-enterprise-media")]
            enterprise_playback: signal(None),
            #[cfg(feature = "experimental-enterprise-media")]
            enterprise_pending: signal([PendingOperation::None; 5]),
            #[cfg(feature = "experimental-enterprise-media")]
            enterprise_ticket: signal(0),
        }
    }

    fn enterprise_pending_active(self) -> bool {
        #[cfg(feature = "experimental-enterprise-media")]
        {
            self.enterprise_pending
                .get()
                .iter()
                .any(|pending| *pending != PendingOperation::None)
        }
        #[cfg(not(feature = "experimental-enterprise-media"))]
        {
            false
        }
    }

    pub fn needs_stop(self) -> bool {
        self.captures.iter().any(|s| s.get().attention())
            || self.remote_audio.get()
            || self.remote_video.get()
            || self.audio_pending.get().is_some()
            || self.video_pending.get().is_some()
            || self.audio_unconfirmed.get()
            || self.video_unconfirmed.get()
            || self.enterprise_pending_active()
    }

    /// 企业采集只由可重放的真实watch驱动；普通Notice不得再写采集状态。
    /// false表示旧快照或旧会话风险尚未解决，调用者不得把它当作已切换会话。
    #[cfg(feature = "experimental-enterprise-media")]
    pub fn apply_enterprise_snapshot(self, snapshot: &call_bridge::EnterpriseCaptureState) -> bool {
        let previous = self.enterprise_snapshot.get_untracked();
        if let Some((session, revision, _)) = previous {
            if snapshot.session_id < session
                || (snapshot.session_id == session && snapshot.revision <= revision)
            {
                return false;
            }
            if snapshot.session_id != session && self.needs_stop() {
                self.status
                    .set("旧媒体会话仍有未确认的设备或播放状态，不能用新会话清除隐私警告。".into());
                return false;
            }
        }
        for (at, source) in snapshot.sources.iter().enumerate() {
            let prior = previous
                .filter(|(session, _, _)| *session == snapshot.session_id)
                .map(|(_, _, revisions)| revisions[at]);
            if !replay_source(
                prior,
                source.revision,
                source.completed_operation,
                snapshot.shutdown.is_some(),
            ) {
                continue;
            }
            let slot = index(source.source);
            let pending = self.enterprise_pending.get_untracked()[slot];
            let clear_pending =
                pending.completed_by(source.completed_operation, snapshot.shutdown.is_some());
            self.captures[slot].update(|state| {
                state.authoritative_operation(
                    source.status,
                    pending,
                    source.completed_operation,
                    snapshot.shutdown.is_some(),
                );
            });
            if clear_pending {
                self.enterprise_pending
                    .update(|pending| pending[slot] = PendingOperation::None);
            }
        }
        if let Some(playback) = &snapshot.playback {
            use call_bridge::CapturePhase;
            let prior = self
                .enterprise_playback
                .get_untracked()
                .filter(|(session, _)| *session == snapshot.session_id)
                .map(|(_, revisions)| revisions);
            let changed = |at: usize| {
                replay_source(
                    prior.map(|revisions| revisions[at]),
                    playback[at].revision,
                    playback[at].completed_operation,
                    snapshot.shutdown.is_some(),
                )
            };
            if changed(0) {
                let previous_pending = self.audio_pending.get_untracked();
                let clear_pending = self.enterprise_pending.get_untracked()[3]
                    .completed_by(playback[0].completed_operation, snapshot.shutdown.is_some());
                match playback[0].status {
                    CapturePhase::Stopped => {
                        self.remote_audio.set(false);
                        self.audio_pending.set(None);
                        self.audio_unconfirmed.set(false);
                    }
                    CapturePhase::Running => {
                        self.remote_audio.set(true);
                        self.audio_unconfirmed.set(false);
                        if self.audio_pending.get_untracked() == Some(true) {
                            self.audio_pending.set(None);
                        }
                    }
                    _ => {
                        self.audio_unconfirmed.set(true);
                        self.audio_pending.set(None);
                    }
                }
                if clear_pending {
                    self.enterprise_pending
                        .update(|pending| pending[3] = PendingOperation::None);
                } else {
                    self.audio_pending.set(previous_pending);
                }
            }
            if changed(1) || changed(2) {
                let previous_pending = self.video_pending.get_untracked();
                let pending = self.enterprise_pending.get_untracked()[4];
                let clear_pending = pending
                    .completed_by(playback[1].completed_operation, snapshot.shutdown.is_some())
                    && pending
                        .completed_by(playback[2].completed_operation, snapshot.shutdown.is_some());
                if playback[1..]
                    .iter()
                    .all(|source| source.status == CapturePhase::Stopped)
                {
                    self.remote_video.set(false);
                    self.video_pending.set(None);
                    self.video_unconfirmed.set(false);
                    self.camera_stream.set(None);
                    self.screen_stream.set(None);
                    self.camera_received.set(false);
                    self.screen_received.set(false);
                } else if playback[1..].iter().any(|source| {
                    !matches!(source.status, CapturePhase::Stopped | CapturePhase::Running)
                }) {
                    self.video_unconfirmed.set(true);
                    self.video_pending.set(None);
                } else {
                    self.remote_video.set(true);
                    self.video_unconfirmed.set(false);
                    if self.video_pending.get_untracked() == Some(true) {
                        self.video_pending.set(None);
                    }
                }
                if clear_pending {
                    self.enterprise_pending
                        .update(|pending| pending[4] = PendingOperation::None);
                } else {
                    self.video_pending.set(previous_pending);
                }
            }
            // 只使用权威控制回执附带的流ID。某一源已关闭时立刻移除该画面。
            let camera = if playback[1].status == CapturePhase::Running {
                snapshot.video_streams[0].clone()
            } else {
                None
            };
            let screen = if playback[2].status == CapturePhase::Running {
                snapshot.video_streams[1].clone()
            } else {
                None
            };
            if self.camera_stream.get_untracked() != camera {
                self.camera_received.set(false);
            }
            if self.screen_stream.get_untracked() != screen {
                self.screen_received.set(false);
            }
            self.camera_stream.set(camera);
            self.screen_stream.set(screen);
            self.enterprise_playback.set(Some((
                snapshot.session_id,
                playback
                    .each_ref()
                    .map(|source| (source.revision, source.completed_operation)),
            )));
        }
        self.enterprise_snapshot.set(Some((
            snapshot.session_id,
            snapshot.revision,
            snapshot
                .sources
                .each_ref()
                .map(|source| (source.revision, source.completed_operation)),
        )));
        if let Some(Err(error)) = &snapshot.shutdown {
            self.status
                .set(format!("媒体关闭未获确认：{error}。逐设备真实状态保留。"));
        } else if let Some(error) = &snapshot.backend_error {
            self.status
                .set(format!("媒体宿主报告错误：{error}。逐设备真实状态保留。"));
        }
        // 无独立播放快照的平台保留播放不确定性；从不由总shutdown结果清空。
        true
    }

    /// 仅把适配队列中的同一ticket绑定到实际入队operation_id。
    #[cfg(feature = "experimental-enterprise-media")]
    pub fn enterprise_control_submitted(self, control: &Control, operation: u64) {
        if let (Some(slot), Some(ticket)) = (operation_slot(control), control.ticket()) {
            self.enterprise_pending.update(|pending| {
                pending[slot] = pending[slot].submitted(ticket, operation);
            });
        }
    }

    /// 仅用于handle明确返回“未入队”；旧ticket不能撤销新请求。
    #[cfg(feature = "experimental-enterprise-media")]
    pub fn enterprise_control_rejected(self, control: &Control, message: &str) {
        if let Some(slot) = operation_slot(control) {
            let Some(ticket) = control.ticket() else {
                return;
            };
            if !self.enterprise_pending.get_untracked()[slot].matches_ticket(ticket) {
                return;
            }
            self.enterprise_pending
                .update(|pending| pending[slot] = PendingOperation::None);
            if slot < 3 {
                self.captures[slot].update(|state| state.request = Request::None);
            } else if slot == 3 {
                self.audio_pending.set(None);
            } else {
                self.video_pending.set(None);
            }
        }
        self.status.set(format!(
            "媒体请求未入队：{message}。已保留真实设备与播放状态。"
        ));
    }

    pub fn event(self, notice: Notice) {
        #[cfg(feature = "experimental-enterprise-media")]
        if self.enterprise_snapshot.get_untracked().is_some() {
            match &notice {
                Notice::Capture { .. }
                | Notice::Stopped { .. }
                | Notice::RemoteAudio(_)
                | Notice::RemoteVideo { .. }
                | Notice::VideoPresented(_)
                | Notice::RemoteEnded(_) => return,
                #[cfg(all(target_os = "android", feature = "android-native-media"))]
                Notice::CapturePending(_)
                | Notice::CaptureStopping(_)
                | Notice::CaptureUnconfirmed(_) => return,
                Notice::Failed { message, .. } | Notice::PlaybackFailed { message, .. } => {
                    self.status
                        .set(format!("媒体操作失败：{message}。采集状态以权威快照为准。"));
                    return;
                }
            }
        }
        match notice {
            #[cfg(all(target_os = "android", feature = "android-native-media"))]
            Notice::CapturePending(source) => self.captures[index(source)].update(|state| {
                if state.request != Request::Stop {
                    state.requested(true);
                }
            }),
            #[cfg(all(target_os = "android", feature = "android-native-media"))]
            Notice::CaptureStopping(source) => {
                self.captures[index(source)].update(|state| state.requested(false))
            }
            #[cfg(all(target_os = "android", feature = "android-native-media"))]
            Notice::CaptureUnconfirmed(source) => self.captures[index(source)].update(|state| {
                state.close_unconfirmed = true;
                state.request = Request::None;
            }),
            Notice::Capture { source, active } => {
                self.captures[index(source)].update(|state| state.confirmed(active));
                self.status.set(format!(
                    "{}{}。",
                    name(source),
                    if active {
                        "已确认开始采集"
                    } else {
                        "已确认停止采集"
                    }
                ));
            }
            Notice::RemoteVideo {
                enabled,
                camera_stream,
                screen_stream,
            } => {
                self.remote_video.set(enabled);
                if self.video_pending.get_untracked() == Some(enabled) {
                    self.video_pending.set(None);
                }
                self.video_unconfirmed.set(false);
                self.camera_stream
                    .set(if enabled { camera_stream } else { None });
                self.screen_stream
                    .set(if enabled { screen_stream } else { None });
                self.camera_received.set(false);
                self.screen_received.set(false);
                self.status.set(
                    if enabled {
                        "已允许远端视频，等待真实解码帧。"
                    } else {
                        "远端视频已关闭，原生画面已清除。"
                    }
                    .into(),
                );
            }
            Notice::RemoteAudio(enabled) => {
                self.remote_audio.set(enabled);
                if self.audio_pending.get_untracked() == Some(enabled) {
                    self.audio_pending.set(None);
                }
                self.audio_unconfirmed.set(false);
                self.status.set(
                    if enabled {
                        "已允许播放远端音频；本机麦克风不会因此启用。"
                    } else {
                        "远端音频播放已关闭。"
                    }
                    .into(),
                );
            }
            Notice::VideoPresented(source) => match source {
                Source::Camera => self.camera_received.set(true),
                Source::Screen => self.screen_received.set(true),
                Source::Microphone => {}
            },
            Notice::RemoteEnded(source) => {
                match source {
                    Source::Camera => {
                        self.camera_stream.set(None);
                        self.camera_received.set(false);
                    }
                    Source::Screen => {
                        self.screen_stream.set(None);
                        self.screen_received.set(false);
                    }
                    Source::Microphone => {}
                }
                self.status.set(format!("对方的{}轨已结束。", name(source)));
            }
            Notice::PlaybackFailed { source, message } => {
                // 对端坏帧/本地播放失败不等于同名本机采集器失去关闭确认。
                if self.audio_pending.get_untracked().is_some() {
                    self.audio_unconfirmed.set(true);
                }
                if self.video_pending.get_untracked().is_some() {
                    self.video_unconfirmed.set(true);
                }
                self.audio_pending.set(None);
                self.video_pending.set(None);
                let track = source.map(name).unwrap_or("媒体");
                self.status.set(format!(
                    "远端{track}播放操作失败：{message}。本机采集状态未改变。"
                ));
            }
            Notice::Failed { source, message } => {
                if self.audio_pending.get_untracked().is_some() {
                    self.audio_unconfirmed.set(true);
                }
                if self.video_pending.get_untracked().is_some() {
                    self.video_unconfirmed.set(true);
                }
                if let Some(source) = source {
                    self.captures[index(source)].update(CaptureState::failed);
                } else {
                    for state in self.captures {
                        state.update(CaptureState::failed);
                    }
                }
                self.audio_pending.set(None);
                self.video_pending.set(None);
                self.status.set(format!(
                    "媒体操作失败：{message}。采集关闭以设备确认通知为准。"
                ));
            }
            Notice::Stopped { confirmed, message } => {
                // 总会话结束不是单个设备的关闭回执；若遗漏 Capture(false)，保留醒目警示。
                for state in self.captures {
                    state.update(|state| state.session_stopped(confirmed));
                }
                if self.audio_pending.get_untracked().is_some() {
                    self.audio_unconfirmed.set(true);
                }
                if self.video_pending.get_untracked().is_some() {
                    self.video_unconfirmed.set(true);
                }
                self.audio_pending.set(None);
                self.video_pending.set(None);
                self.camera_stream.set(None);
                self.screen_stream.set(None);
                self.camera_received.set(false);
                self.screen_received.set(false);
                self.audio_unconfirmed.set(
                    !confirmed
                        && (self.remote_audio.get_untracked()
                            || self.audio_unconfirmed.get_untracked()),
                );
                self.video_unconfirmed.set(
                    !confirmed
                        && (self.remote_video.get_untracked()
                            || self.video_unconfirmed.get_untracked()),
                );
                if confirmed {
                    self.remote_audio.set(false);
                    self.remote_video.set(false);
                }
                self.status.set(message.unwrap_or_else(|| {
                    if confirmed {
                        "媒体会话已结束；本机设备状态以上方逐项确认指示为准。".into()
                    } else {
                        "媒体关闭未获确认，请检查设备状态并重试停止。".into()
                    }
                }));
            }
        }
    }

    /// 连接断开不等于设备已关闭。必须继续接收 bridge 的媒体关闭通知。
    pub fn disconnected(self) {
        for (slot, state) in self.captures.into_iter().enumerate() {
            let _ = slot;
            state.update(|state| {
                let request = state.request;
                state.failed();
                #[cfg(feature = "experimental-enterprise-media")]
                if self.enterprise_pending.get_untracked()[slot] != PendingOperation::None {
                    state.request = request;
                }
                #[cfg(not(feature = "experimental-enterprise-media"))]
                let _ = request;
            });
        }
        if self.remote_audio.get_untracked() || self.audio_pending.get_untracked().is_some() {
            self.audio_unconfirmed.set(true);
        }
        if self.remote_video.get_untracked() || self.video_pending.get_untracked().is_some() {
            self.video_unconfirmed.set(true);
        }
        #[cfg(feature = "experimental-enterprise-media")]
        {
            if self.enterprise_pending.get_untracked()[3] == PendingOperation::None {
                self.audio_pending.set(None);
            }
            if self.enterprise_pending.get_untracked()[4] == PendingOperation::None {
                self.video_pending.set(None);
            }
        }
        #[cfg(not(feature = "experimental-enterprise-media"))]
        {
            self.audio_pending.set(None);
            self.video_pending.set(None);
        }
        self.camera_stream.set(None);
        self.screen_stream.set(None);
        self.status
            .set("连接已断开，等待媒体关闭确认；不会把断线当成设备已关闭。".into());
    }

    fn send(self, sender: &Sender<Command>, control: Control) -> bool {
        #[cfg(feature = "experimental-enterprise-media")]
        if self.enterprise_snapshot.get_untracked().is_some() {
            let Some(ticket) = self.enterprise_ticket.get_untracked().checked_add(1) else {
                self.status
                    .set("媒体UI请求编号耗尽，请停止并重启客户端。".into());
                return false;
            };
            self.enterprise_ticket.set(ticket);
            let slot = operation_slot(&control);
            if sender
                .try_send(Command::Media(Control::Tagged {
                    ticket,
                    control: Box::new(control),
                }))
                .is_ok()
            {
                if let Some(slot) = slot {
                    self.enterprise_pending
                        .update(|pending| pending[slot] = PendingOperation::Unsubmitted { ticket });
                }
                return true;
            }
            self.status
                .set("媒体请求未送出：控制队列繁忙或已关闭。设备状态没有改变，请重试。".into());
            return false;
        }
        if sender.try_send(Command::Media(control)).is_ok() {
            true
        } else {
            self.status
                .set("媒体请求未送出：控制队列繁忙或已关闭。设备状态没有改变，请重试。".into());
            false
        }
    }

    fn start(self, sender: &Sender<Command>, source: Source) {
        let slot = index(source);
        let selection = self.selections[slot].get_untracked().trim().to_owned();
        if selection.is_empty() || !self.captures[slot].get_untracked().can_start() {
            return;
        }
        if self.send(
            sender,
            Control::Start {
                source,
                selection: selection.clone(),
            },
        ) {
            self.requested_targets[slot].set(selection);
            self.captures[slot].update(|state| state.requested(true));
        }
    }

    fn stop(self, sender: &Sender<Command>, source: Source) {
        if self.send(sender, Control::Stop(source)) {
            self.captures[index(source)].update(|state| state.requested(false));
        }
    }

    /// 若外部另做折叠，必须把此视图放在折叠区外，避免隐藏采集风险。
    pub fn privacy_view(self) -> impl IntoElement {
        view()
            .gap_1()
            .child(self.privacy_line(Source::Microphone))
            .child(self.privacy_line(Source::Camera))
            .child(self.privacy_line(Source::Screen))
            .child(when(
                move || self.audio_unconfirmed.get() || self.video_unconfirmed.get(),
                || {
                    text("远端媒体关闭未获确认，请关闭接收或断开并检查本机播放状态。")
                        .text_color(move || theme().destructive)
                },
            ))
    }

    fn privacy_line(self, source: Source) -> impl IntoElement {
        let slot = index(source);
        text(move || {
            let state = self.captures[slot].get();
            let target = self.requested_targets[slot].get();
            if state.attention() && !target.is_empty() {
                format!("{} · {} · 目标：{}", name(source), state.label(), target)
            } else {
                format!("{} · {}", name(source), state.label())
            }
        })
        .text_color(move || {
            if self.captures[slot].get().attention() {
                theme().destructive
            } else {
                theme().muted_foreground
            }
        })
    }

    /// 自带默认折叠的设置区。外层隐私指示和停止按钮始终可见，不要再隐藏整个返回视图。
    pub fn view(self, sender: Sender<Command>, connected: Signal<bool>) -> impl IntoElement {
        let mic_stop = sender.clone();
        let camera_stop = sender.clone();
        let screen_stop = sender.clone();
        let audio_on = sender.clone();
        let audio_off = sender.clone();
        let video_on = sender.clone();
        let video_off = sender.clone();
        let camera_start = sender.clone();
        let mic_start = sender.clone();
        let android_controls = sender.clone();
        let screen_start = sender;
        view().gap_2().p_3().border_1()
            .border_color(move || theme().border).rounded(move || theme().radius)
            .child(text("原生媒体").text_size(px(16.0)))
            .child(when(call_bridge::experimental_video_host, || {
                text("实验原生视频宿主：尚未通过本平台设备与画面验收，请勿作为正式发布功能。")
                    .text_color(move || theme().destructive)
            }))
            .child(self.privacy_view())
            .child(text(move || self.status.get()).text_color(move || theme().muted_foreground))
            .child(self.android_controls(android_controls, connected))
            .child(when(|| !call_bridge::capture_supported() && !call_bridge::android_media_supported(), || {
                text(if cfg!(target_os = "android") {
                    "Android 媒体宿主尚未接通，不能启用摄像头、麦克风、屏幕共享或远端播放。"
                } else {
                    "此平台尚未接通媒体采集和播放。"
                }).text_color(move || theme().muted_foreground)
            }))
            .child(when(call_bridge::capture_supported, move || {
                let mic_stop = mic_stop.clone();
                let camera_stop = camera_stop.clone();
                let screen_stop = screen_stop.clone();
                let video_on = video_on.clone();
                let video_off = video_off.clone();
                view().gap_2()
                    .child(view().flex_row().gap_2()
                        .child(ui::action("停止麦克风", move || !self.captures[0].get().attention() || self.captures[0].get().request == Request::Stop, move || self.stop(&mic_stop, Source::Microphone)))
                        .child(ui::action("停止摄像头", move || !self.captures[1].get().attention() || self.captures[1].get().request == Request::Stop, move || self.stop(&camera_stop, Source::Camera)))
                        .child(ui::action("停止屏幕共享", move || !self.captures[2].get().attention() || self.captures[2].get().request == Request::Stop, move || self.stop(&screen_stop, Source::Screen))))
                    .child(ui::action("展开/收起媒体设备与接收设置", || false, move || self.expanded.set(!self.expanded.get_untracked())))
                    .child(view().gap_3().style_when(move || !self.expanded.get(), |style| style.hidden())
                        .child(text("所有采集默认关闭。填写已确认的设备或区域后，点击开始才会访问设备并向当前对端发送；收起设置不会停止采集。"))
                        .child(self.capture_controls(Source::Microphone, mic_start.clone(), connected))
                        .child(self.capture_controls(Source::Camera, camera_start.clone(), connected))
                        .child(self.capture_controls(Source::Screen, screen_start.clone(), connected))
                        .child(text("远端接收单独授权，不会开启本机设备。"))
                        .child(text(move || format!("远端音频：{}", reception_label(self.remote_audio.get(), self.audio_pending.get(), self.audio_unconfirmed.get()))))
                        .child(view().flex_row().gap_2()
                            .child(ui::action("允许远端音频", move || !connected.get() || self.remote_audio.get() || self.audio_pending.get().is_some() || self.audio_unconfirmed.get(), {
                                let sender = audio_on.clone();
                                move || { if self.send(&sender, Control::RemoteAudio(true)) { self.audio_pending.set(Some(true)); } }
                            }))
                            .child(ui::action("关闭远端音频", move || self.audio_pending.get() == Some(false) || (!self.remote_audio.get() && self.audio_pending.get().is_none() && !self.audio_unconfirmed.get()), {
                                let sender = audio_off.clone();
                                move || { if self.send(&sender, Control::RemoteAudio(false)) { self.audio_pending.set(Some(false)); } }
                            })))
                        .child(text(move || format!("远端视频：{}", reception_label(self.remote_video.get(), self.video_pending.get(), self.video_unconfirmed.get()))))
                        .child(when(|| !call_bridge::video_supported(), || text("此平台尚未实现原生视频纹理，不能接收显示远端视频；不会用占位图冒充视频。")))
                        .child(when(call_bridge::video_supported, move || {
                            view().flex_row().gap_2()
                                .child(ui::action("允许远端视频", move || !connected.get() || self.remote_video.get() || self.video_pending.get().is_some() || self.video_unconfirmed.get(), {
                                    let sender = video_on.clone();
                                    move || { if self.send(&sender, Control::RemoteVideo(true)) { self.video_pending.set(Some(true)); } }
                                }))
                                .child(ui::action("关闭远端视频", move || self.video_pending.get() == Some(false) || (!self.remote_video.get() && self.video_pending.get().is_none() && !self.video_unconfirmed.get()), {
                                    let sender = video_off.clone();
                                    move || { if self.send(&sender, Control::RemoteVideo(false)) { self.video_pending.set(Some(false)); } }
                                }))
                        })))
            }))
            // 接收画面不在设置折叠区，摄像头和屏幕使用各自的真实原生流节点。
            .child(self.remote_view(Source::Camera))
            .child(self.remote_view(Source::Screen))
    }

    fn android_controls(
        self,
        sender: Sender<Command>,
        connected: Signal<bool>,
    ) -> impl IntoElement {
        #[cfg(all(target_os = "android", feature = "android-native-media"))]
        {
            let open = sender.clone();
            when(call_bridge::android_media_supported, move || {
                let open = open.clone();
                let stop = sender.clone();
                view().gap_2()
                    .child(text("原生通话页逐项申请系统权限并控制采集、接收和Surface画面；打开页面不会自动启用设备。"))
                    .child(ui::action("打开原生通话控制", move || !connected.get(), move || { self.send(&open, Control::OpenNativeMedia); }))
                    .child(ui::action("停止全部Android媒体", move || !connected.get() && !self.captures.iter().any(|s| s.get().attention()), move || { self.send(&stop, Control::StopAllNativeMedia); }))
                    .child(text("停止全部媒体后需重新建立连接才能再打开通话，现有聊天连接保留。"))
            }).into_element()
        }
        #[cfg(not(all(target_os = "android", feature = "android-native-media")))]
        {
            let _ = (self, sender, connected);
            view().into_element()
        }
    }

    fn capture_controls(
        self,
        source: Source,
        sender: Sender<Command>,
        connected: Signal<bool>,
    ) -> impl IntoElement {
        let slot = index(source);
        let (hint, placeholder, button) = selection_labels(source);
        view()
            .gap_1()
            .child(text(hint).text_color(move || theme().muted_foreground))
            .child(ui::field(self.selections[slot], placeholder))
            .child(when(
                move || source == Source::Screen,
                move || {
                    text(move || screen_scope(&self.selections[slot].get()))
                        .text_color(move || theme().destructive)
                },
            ))
            .child(ui::action(
                button,
                move || {
                    !connected.get()
                        || !self.captures[slot].get().can_start()
                        || self.selections[slot].get().trim().is_empty()
                },
                move || self.start(&sender, source),
            ))
    }

    fn remote_view(self, source: Source) -> impl IntoElement {
        let (stream, received, title) = match source {
            Source::Camera => (self.camera_stream, self.camera_received, "对方摄像头"),
            Source::Screen => (self.screen_stream, self.screen_received, "对方屏幕共享"),
            Source::Microphone => unreachable!("音频不创建视频视图"),
        };
        when(
            move || {
                call_bridge::video_supported() && self.remote_video.get() && stream.get().is_some()
            },
            move || {
                view()
                    .gap_1()
                    .child(text(title))
                    .child(
                        text(move || {
                            #[cfg(feature = "experimental-enterprise-media")]
                            if self.enterprise_snapshot.get().is_some() {
                                return "原生视频画面；是否收到帧以实际画面为准";
                            }
                            if received.get() {
                                "已收到真实解码帧"
                            } else {
                                "等待对端视频帧"
                            }
                        })
                        .text_color(move || theme().muted_foreground),
                    )
                    .child(
                        native(surreal_ck_native_video_view::COMPONENT_NAME)
                            .prop("streamId", move || {
                                serde_json::Value::String(stream.get().unwrap_or_default())
                            })
                            .w(px(320.0))
                            .h(px(180.0))
                            .on_native_event(move |event: &NativeEvent| {
                                if event.name.as_ref() == "error" {
                                    self.status.set(format!("原生视频视图错误：{}", event.data));
                                }
                            }),
                    )
            },
        )
    }
}

fn reception_label(enabled: bool, pending: Option<bool>, unconfirmed: bool) -> &'static str {
    if unconfirmed {
        return "状态未确认，请先重试关闭";
    }
    match pending {
        Some(true) => "允许请求待确认",
        Some(false) => "关闭请求待确认",
        None if enabled => "已允许",
        None => "关闭",
    }
}

fn selection_labels(source: Source) -> (&'static str, &'static str, &'static str) {
    match source {
        Source::Microphone => (
            if cfg!(target_os = "linux") {
                "麦克风：填写已确认的 PulseAudio / PipeWire-Pulse source 名称。"
            } else if cfg!(target_os = "windows") {
                "麦克风：填写已确认的 DirectShow 音频设备名。"
            } else {
                "麦克风：填写已确认的 AVFoundation 音频设备索引，并确认系统麦克风授权。"
            },
            "明确选择麦克风设备，不自动使用默认设备",
            "开始麦克风采集并发送",
        ),
        Source::Camera => (
            if cfg!(target_os = "linux") {
                "摄像头：填写已确认的 /dev/videoN 节点，发送 640×360、15fps 的真实视频。"
            } else if cfg!(target_os = "windows") {
                "摄像头：填写已确认的 DirectShow 视频设备名，发送 640×360、15fps。"
            } else {
                "摄像头：填写已确认的 AVFoundation 摄像头索引，确认系统相机授权，发送 640×360、15fps。"
            },
            "明确选择摄像头设备",
            "开始摄像头采集并发送",
        ),
        Source::Screen => (
            if cfg!(target_os = "linux") {
                "仅 X11 区域共享：填写 display.screen+x,y，例如 :0.0+0,0。Wayland 门户未实现，不能绕过。"
            } else if cfg!(target_os = "windows") {
                "桌面区域共享：填写明确的左上角 x,y 坐标，不是窗口选择器。"
            } else {
                "填写已确认的 AVFoundation 屏幕索引；此操作发送所选屏幕内容，先确认屏幕录制授权。"
            },
            "明确选择共享区域或屏幕，不自动填入",
            "开始所选屏幕采集并发送",
        ),
    }
}

fn screen_scope(selection: &str) -> String {
    let selected = selection.trim();
    if selected.is_empty() {
        return "尚未选择共享范围，不会采集屏幕。".into();
    }
    if cfg!(target_os = "linux") {
        format!(
            "将发送 X11 {selected} 起点的 640×360 像素区域，15fps；不是整个屏幕，也不是窗口选择器。请先核对区域内没有敏感内容。"
        )
    } else if cfg!(target_os = "windows") {
        format!(
            "将发送桌面 ({selected}) 起点的 640×360 像素区域，15fps；不是整个屏幕，也不是窗口选择器。请先核对区域内没有敏感内容。"
        )
    } else {
        format!(
            "将发送已确认屏幕索引 {selected} 的完整画面，缩放为 640×360、15fps。请先核对屏幕内没有敏感内容。"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "experimental-enterprise-media")]
    #[test]
    fn old_stop_ack_cannot_clear_new_unsubmitted_or_submitted_start() {
        use call_bridge::CapturePhase;
        let mut state = CaptureState::default();
        state.requested(true);
        let unsubmitted = PendingOperation::Unsubmitted { ticket: 12 };
        assert!(!state.authoritative_operation(CapturePhase::Stopped, unsubmitted, 101, false));
        assert_eq!(state.request, Request::Start);
        assert!(state.attention());
        let submitted = unsubmitted.submitted(12, 102);
        assert!(!state.authoritative_operation(CapturePhase::Running, submitted, 101, false));
        assert!(state.active);
        assert_eq!(state.request, Request::Start);
        assert!(state.authoritative_operation(CapturePhase::Running, submitted, 102, false));
        assert_eq!(state.request, Request::None);
        assert!(state.active);
    }

    #[cfg(feature = "experimental-enterprise-media")]
    #[test]
    fn stale_submission_and_rejection_cannot_replace_a_newer_ticket() {
        let pending = PendingOperation::Unsubmitted { ticket: 13 };
        assert_eq!(pending.submitted(12, 102), pending);
        assert!(!pending.matches_ticket(12));
        let submitted = pending.submitted(13, 103);
        assert!(!submitted.matches_ticket(12));
        assert!(!submitted.completed_by(102, false));
        assert!(!submitted.completed_by(104, false)); // 其他调用者的较大编号也不等于本次回执。
        assert!(submitted.completed_by(103, false));
    }

    #[cfg(feature = "experimental-enterprise-media")]
    #[test]
    fn final_real_read_can_resolve_a_never_submitted_request_without_inventing_stop() {
        let pending = PendingOperation::Unsubmitted { ticket: 14 };
        let mut state = CaptureState::default();
        state.requested(true);
        assert!(state.authoritative_operation(
            call_bridge::CapturePhase::Stopped,
            pending,
            0,
            true
        ));
        assert_eq!(state, CaptureState::default());
        state.confirmed(true);
        assert!(state.authoritative_operation(
            call_bridge::CapturePhase::Unconfirmed,
            pending,
            0,
            true
        ));
        assert!(state.active && state.close_unconfirmed);
    }

    #[cfg(feature = "experimental-enterprise-media")]
    #[test]
    fn playback_rejection_replays_only_its_completed_operation() {
        assert!(!replay_source(Some((0, 0)), 0, 0, false));
        assert!(replay_source(Some((0, 0)), 0, 1, false));
        assert!(!replay_source(Some((0, 1)), 0, 1, false));
    }

    #[cfg(feature = "experimental-enterprise-media")]
    #[test]
    fn cancelled_queued_start_replays_unchanged_real_source_on_final_read() {
        let mut state = CaptureState::default();
        state.requested(true);
        state.failed(); // 身份失效，但命令尚未执行，平台真实revision仍为零。
        assert!(state.attention());
        assert!(!replay_source(Some((0, 0)), 0, 0, false));
        assert!(replay_source(Some((0, 0)), 0, 0, true));
        state.authoritative(call_bridge::CapturePhase::Stopped);
        assert_eq!(state, CaptureState::default());
        state.confirmed(true);
        state.authoritative(call_bridge::CapturePhase::Unconfirmed);
        assert!(state.active && state.close_unconfirmed); // final-read也不得推断关闭。
    }

    #[cfg(feature = "experimental-enterprise-media")]
    #[test]
    fn authoritative_source_stop_clears_only_after_real_stopped_phase() {
        use call_bridge::CapturePhase;
        let mut state = CaptureState::default();
        state.confirmed(true);
        state.requested(false);
        state.authoritative(CapturePhase::Unconfirmed);
        assert!(state.active && state.close_unconfirmed);
        state.authoritative(CapturePhase::Stopping);
        assert!(state.active && state.close_unconfirmed);
        state.authoritative(CapturePhase::Stopped);
        assert_eq!(state, CaptureState::default());
    }

    #[cfg(feature = "experimental-enterprise-media")]
    #[test]
    fn authoritative_running_preserves_a_newer_stop_request() {
        let mut state = CaptureState::default();
        state.requested(false);
        state.authoritative(call_bridge::CapturePhase::Running);
        assert!(state.active);
        assert_eq!(state.request, Request::Stop);
    }

    #[test]
    fn default_capture_state_has_no_permission_or_device_activity() {
        let state = CaptureState::default();
        assert!(!state.active);
        assert!(!state.attention());
        assert!(state.can_start());
    }
    #[test]
    fn failed_stop_keeps_active_privacy_indicator_until_real_stop() {
        let mut state = CaptureState::default();
        state.confirmed(true);
        state.requested(false);
        state.failed();
        assert!(state.active && state.close_unconfirmed && state.attention());
        assert!(!state.can_start());
        assert!(state.label().contains("关闭未获确认"));
        state.confirmed(false);
        assert_eq!(state, CaptureState::default());
    }
    #[test]
    fn failed_start_does_not_claim_device_is_closed() {
        let mut state = CaptureState::default();
        state.requested(true);
        state.failed();
        assert!(!state.active);
        assert!(state.attention());
        assert!(!state.can_start());
        assert!(state.close_unconfirmed);
    }
    #[test]
    fn unrelated_failure_does_not_invent_capture_activity() {
        let mut state = CaptureState::default();
        state.failed();
        assert_eq!(state, CaptureState::default());
    }
    #[test]
    fn queued_stop_never_claims_success() {
        let mut state = CaptureState::default();
        state.confirmed(true);
        state.requested(false);
        assert!(state.active && state.attention());
        assert!(state.label().contains("尚未确认"));
    }
    #[test]
    fn unconfirmed_session_stop_does_not_clear_capture() {
        for confirmed in [false, true] {
            let mut state = CaptureState::default();
            state.confirmed(true);
            state.session_stopped(confirmed);
            assert!(state.active && state.close_unconfirmed);
        }
    }
    #[test]
    fn reception_requests_wait_for_acknowledgement() {
        assert_eq!(reception_label(false, None, false), "关闭");
        assert_eq!(reception_label(false, Some(true), false), "允许请求待确认");
        assert_eq!(reception_label(true, Some(false), false), "关闭请求待确认");
    }
    #[test]
    fn late_start_confirmation_preserves_newer_stop_request() {
        let mut state = CaptureState::default();
        state.requested(true);
        state.requested(false);
        state.confirmed(true);
        assert_eq!(state.request, Request::Stop);
        assert!(state.active);
        state.confirmed(false);
        assert_eq!(state, CaptureState::default());
    }
    #[test]
    fn unknown_remote_state_is_not_labeled_closed() {
        assert_eq!(
            reception_label(false, None, true),
            "状态未确认，请先重试关闭"
        );
    }
    #[test]
    fn blank_screen_selection_never_implies_default_display() {
        assert_eq!(screen_scope("  "), "尚未选择共享范围，不会采集屏幕。");
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn x11_scope_discloses_the_exact_requested_area() {
        let text = screen_scope(":0.0+12,34");
        assert!(text.contains(":0.0+12,34"));
        assert!(text.contains("640×360"));
        assert!(text.contains("不是整个屏幕"));
    }
}
