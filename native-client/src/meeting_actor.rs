//! 会议集成层（会议网状设计包 F）。
//!
//! 把 `ui::meeting` 的 MeetingCommand/MeetingUpdate 接到真实链路：
//! MeetingConnection（record 会话 RPC）→ native-signaling `Meeting`（房态/边状态机）
//! → 每条边一个 native-transport `MeetingEdge`（独立 WebRTC）→ native-call `MeetingMedia`
//! （本机一次采集、逐边扇出、远端按槽渲染）。
//!
//! 线程边界与 identity_ui 的工作线程一致：actor 任务在后台 runtime 运行，
//! 状态更新经身份事件泵送回主线程应用；SDP 只在信令行上传输（与聊天同形态）。
use crate::identity_ui::Event;
use crate::ui::meeting::{
    self, Capability, Contact, DeviceState, EdgeStatus, Invitation, MeetingCommand, MeetingError,
    MeetingUpdate, MemberView, RoomSnapshot, RoomState, Source, UnavailableReason, VideoSlot,
    placeholder_video,
};
use async_channel::{Receiver, Sender};
use bytes::Bytes;
use nsh_core::{element::AnyElement, prelude::*};
use std::{
    collections::BTreeMap,
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use surreal_ck_native_call::{
    CaptureInput, CaptureStatus, Source as CallSource, VideoConfig,
    meeting::{DeviceGate, GateOwner, MeetingEvent, MeetingMedia, MemberSlot, RenderSlot},
};
use surreal_ck_native_identity::{
    IdentityClient, Session, SurrealConfig,
    meeting::{MeetingConnection, RoomStatus, Route},
};
use surreal_ck_native_signaling::{
    Error as SignalingError,
    meeting::{AuthenticatedMeetingAnswer, AuthenticatedMeetingOffer, Meeting},
};
use surreal_ck_native_video_view::{COMPONENT_NAME, FramePublisher, RgbaFrame, open_stream};
use surreal_ck_peer_transport::{
    Route as TransportRoute,
    meeting::{
        Attempt, EdgeKey as TransportEdgeKey, JoinId, MeetingEdge, ObservedRoute, RoomId,
        RouteKind, offer_hash,
    },
    webrtc::{
        api::setting_engine::SettingEngine,
        peer_connection::{
            peer_connection_state::RTCPeerConnectionState,
            sdp::session_description::RTCSessionDescription,
        },
    },
};

const TICK: Duration = Duration::from_secs(3);
const ATTEMPT_TTL: Duration = Duration::from_secs(35);
const RENEW_AFTER: Duration = Duration::from_secs(8);
const EDGE_RETRY: Duration = Duration::from_secs(15);
const INVITATIONS_AFTER: Duration = Duration::from_secs(9);

fn call_source(source: Source) -> CallSource {
    match source {
        Source::Mic => CallSource::Microphone,
        Source::Camera => CallSource::Camera,
        Source::Screen => CallSource::Screen,
    }
}
fn ui_source(source: CallSource) -> Source {
    match source {
        CallSource::Microphone => Source::Mic,
        CallSource::Camera => Source::Camera,
        CallSource::Screen => Source::Screen,
    }
}

/// 远端视频帧槽：每个成员×源一条 FramePublisher，sink 只写 mailbox，不解码。
#[derive(Clone, Default)]
pub struct VideoHub {
    streams: Arc<Mutex<BTreeMap<(String, String, Source), FramePublisher>>>,
}
impl VideoHub {
    fn publisher(&self, member: &str, join: &str, source: Source) -> Option<FramePublisher> {
        let key = (member.to_owned(), join.to_owned(), source);
        let mut map = self.streams.lock().ok()?;
        if let Some(stream) = map.get(&key) {
            return Some(stream.clone());
        }
        let stream = open_stream().ok()?;
        map.insert(key, stream.clone());
        Some(stream)
    }
    fn sink(
        &self,
    ) -> Arc<dyn Fn(&RenderSlot, u16, u16, Bytes) -> Result<(), String> + Send + Sync> {
        let hub = self.clone();
        Arc::new(move |slot: &RenderSlot, w: u16, h: u16, data: Bytes| {
            let Some(stream) = hub.publisher(
                &slot.member_id,
                slot.join_id.as_str(),
                ui_source(slot.source),
            ) else {
                return Err("视频输出不可用".into());
            };
            let frame = RgbaFrame::packed(w.into(), h.into(), data).map_err(|e| e.to_string())?;
            stream.present(frame).map(|_| ()).map_err(|e| e.to_string())
        })
    }
    fn stream_id(&self, member: &str, join: &str, source: Source) -> Option<String> {
        self.publisher(member, join, source)
            .map(|stream| stream.id().to_owned())
    }
    pub fn video(&self) -> VideoSlot {
        let hub = self.clone();
        Rc::new(
            move |member: &str, join: &str, source: Source| -> AnyElement {
                match hub.stream_id(member, join, source) {
                    Some(id) => native(COMPONENT_NAME)
                        .prop("streamId", serde_json::Value::String(id))
                        .w(px(320.0))
                        .h(px(180.0))
                        .into_element(),
                    None => placeholder_video(member, join, source),
                }
            },
        )
    }
    fn close_all(&self) {
        if let Ok(mut map) = self.streams.lock() {
            for (_, stream) in std::mem::take(&mut *map) {
                stream.close();
            }
        }
    }
}

/// UI 持有的句柄；`Shared` 跨线程交给身份工作循环。
#[derive(Clone)]
pub struct Bridge {
    state: meeting::MeetingState,
    commands: Sender<MeetingCommand>,
    shared: Arc<Shared>,
    hub: VideoHub,
}
pub struct Shared {
    commands: Receiver<MeetingCommand>,
    hub: VideoHub,
    running: std::sync::atomic::AtomicBool,
    generation: Mutex<u64>,
    stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}
impl Default for Bridge {
    fn default() -> Self {
        Self::new()
    }
}
impl Bridge {
    pub fn new() -> Self {
        let (commands, receiver) = async_channel::unbounded();
        let hub = VideoHub::default();
        Self {
            state: meeting::MeetingState::new(),
            commands,
            shared: Arc::new(Shared {
                commands: receiver,
                hub: hub.clone(),
                running: false.into(),
                generation: Mutex::new(0),
                stop: Mutex::new(None),
            }),
            hub,
        }
    }
    pub fn shared(&self) -> Arc<Shared> {
        self.shared.clone()
    }
    pub fn state(&self) -> meeting::MeetingState {
        self.state
    }
    /// 给 ui::meeting::meeting_page 的命令入口；actor 未运行时丢弃。
    pub fn sender(&self) -> impl Fn(MeetingCommand) + Clone + 'static {
        let commands = self.commands.clone();
        let shared = self.shared.clone();
        move |command| {
            if shared.running.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = commands.send_blocking(command);
            }
        }
    }
    pub fn video(&self) -> VideoSlot {
        self.hub.video()
    }
    /// 仅由主线程事件泵调用；代际不符的迟到更新被丢弃。
    pub fn apply(&self, generation: u64, update: MeetingUpdate) {
        let current = *self
            .shared
            .generation
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if generation == current {
            self.state.apply(update);
        }
    }
}

/// identity 工作循环入口：目录 Ready 后调用；调用方保证 session 是 participant 会话。
pub fn start(
    shared: &Arc<Shared>,
    epoch: u64,
    generation: u64,
    client: IdentityClient,
    session: Arc<Session>,
    config: SurrealConfig,
    slug: String,
    contacts: Vec<Contact>,
    out: Sender<(u64, Event)>,
) {
    *shared.generation.lock().unwrap_or_else(|p| p.into_inner()) = generation;
    while shared.commands.try_recv().is_ok() {}
    shared
        .running
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (stop, stop_rx) = tokio::sync::oneshot::channel();
    *shared.stop.lock().unwrap_or_else(|p| p.into_inner()) = Some(stop);
    let shared = shared.clone();
    tokio::spawn(async move {
        run(
            epoch,
            generation,
            client,
            session,
            config,
            slug,
            contacts,
            shared.commands.clone(),
            stop_rx,
            out,
            shared.hub.clone(),
        )
        .await;
        shared
            .running
            .store(false, std::sync::atomic::Ordering::SeqCst);
    });
}
/// identity 清空/登出/切工作区时调用；actor 自行做媒体与边清理，这里补发能力降级。
pub fn stop(
    shared: &Arc<Shared>,
    out: &Sender<(u64, Event)>,
    epoch: u64,
    reason: UnavailableReason,
) {
    shared
        .running
        .store(false, std::sync::atomic::Ordering::SeqCst);
    if let Some(stop) = shared.stop.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = stop.send(());
    }
    while shared.commands.try_recv().is_ok() {}
    shared.hub.close_all();
    let generation = *shared.generation.lock().unwrap_or_else(|p| p.into_inner());
    let _ = out.try_send((
        epoch,
        Event::Meeting(
            generation,
            MeetingUpdate::Capability(Capability::Unavailable { reason }),
        ),
    ));
}

struct EdgeWork {
    slot: MemberSlot,
    edge: MeetingEdge,
    offer_hash: Option<[u8; 32]>,
    deadline: Instant,
    status: EdgeStatus,
}

fn transport_attempt(
    room: &str,
    local_join: &str,
    peer_join: &str,
    attempt_no: u32,
    route: RouteKind,
) -> Result<Attempt, String> {
    Ok(Attempt {
        edge: TransportEdgeKey::new(
            RoomId::new(room).map_err(|e| e.to_string())?,
            JoinId::new(local_join).map_err(|e| e.to_string())?,
            JoinId::new(peer_join).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?,
        attempt_no,
        nonce: [0; 16],
        route,
        expires_at: Instant::now() + ATTEMPT_TTL,
    })
}
fn route_kind(route: Route) -> RouteKind {
    match route {
        Route::Direct => RouteKind::Direct,
        Route::Relay => RouteKind::Relay,
    }
}

fn map_error(error: impl std::fmt::Display) -> MeetingError {
    let message = error.to_string();
    if message.contains("已满") {
        MeetingError::Full
    } else if message.contains("不存在") || message.contains("未获邀请") {
        MeetingError::NotFoundOrNotInvited
    } else if message.contains("过期") || message.contains("失效") {
        MeetingError::Expired
    } else {
        MeetingError::Retryable { msg: message }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run(
    epoch: u64,
    generation: u64,
    client: IdentityClient,
    session: Arc<Session>,
    config: SurrealConfig,
    slug: String,
    contacts: Vec<Contact>,
    commands: Receiver<MeetingCommand>,
    mut stop: tokio::sync::oneshot::Receiver<()>,
    out: Sender<(u64, Event)>,
    hub: VideoHub,
) {
    macro_rules! emit {
        ($update:expr) => {
            if out
                .send((epoch, Event::Meeting(generation, $update)))
                .await
                .is_err()
            {
                return;
            }
        };
    }
    // 连续相同的错误按调用点去重：同一点位的同文错误 10 秒内只报一次，
    // 避免 tick 循环刷屏；不同点位（或文案变化）的错误各自可见。
    let mut last_errors: BTreeMap<u32, (String, Instant)> = BTreeMap::new();
    macro_rules! fail {
        ($error:expr) => {{
            let rendered = ($error).to_string();
            // 取证用：包括被去重吞掉的在内，错误全量打到 stderr（实例日志）。
            eprintln!("[meeting] error@{}: {rendered}", line!());
            let emit_now = match last_errors.get(&line!()) {
                Some((text, at)) => *text != rendered || at.elapsed() > Duration::from_secs(10),
                None => true,
            };
            if emit_now {
                last_errors.insert(line!(), (rendered, Instant::now()));
                emit!(MeetingUpdate::Error(map_error($error)))
            }
        }};
    }
    let rpc = match MeetingConnection::connect(&client, session, &config, &slug).await {
        Ok(rpc) => rpc,
        Err(error) => {
            emit!(MeetingUpdate::Capability(Capability::Unavailable {
                reason: UnavailableReason::SchemaNotMigrated,
            }));
            fail!(error);
            return;
        }
    };
    let mut meeting = match Meeting::new(rpc) {
        Ok(meeting) => meeting,
        Err(error) => {
            emit!(MeetingUpdate::Capability(Capability::Unavailable {
                reason: UnavailableReason::SchemaNotMigrated,
            }));
            fail!(error);
            return;
        }
    };
    let (mut media, mut media_events) = MeetingMedia::new(hub.sink());
    let gate = DeviceGate::default();
    let mut lease = None;
    let mut last_invitations = Instant::now();
    let mut edges: BTreeMap<String, EdgeWork> = BTreeMap::new();
    // 建边失败后的重试冷却，避免每个 tick 重复创建 PC/套接字。
    let mut retry_after: BTreeMap<String, Instant> = BTreeMap::new();
    let mut tick = tokio::time::interval(TICK);
    let mut last_renew = Instant::now();
    emit!(MeetingUpdate::Capability(Capability::Available));
    emit!(MeetingUpdate::Contacts(contacts.clone()));
    match meeting.invitations().await {
        Ok(invitations) => {
            emit!(MeetingUpdate::Invitations(
                invitations
                    .iter()
                    .map(|invitation| map_invitation(invitation, &contacts))
                    .collect(),
            ));
        }
        Err(error) => fail!(error),
    }

    loop {
        tokio::select! {
            _ = &mut stop => break,
            command = commands.recv() => {
                let Ok(command) = command else { break };
                match command {
                    MeetingCommand::Create => match meeting.create().await {
                        Ok(()) => {
                            eprintln!("[meeting] create ok");
                            emit_snapshot(&meeting, &edges, &contacts, &out, epoch, generation, &media).await
                        }
                        Err(error) => fail!(error),
                    },
                    MeetingCommand::Invite { member_ids, .. } => {
                        match meeting.invite(&member_ids).await {
                            Ok(result) => eprintln!("[meeting] invite ok: {:?}", result.invited),
                            Err(error) => fail!(error),
                        }
                    }
                    MeetingCommand::Join { room_code } => match meeting.join(&room_code).await {
                        Ok(()) => {
                            eprintln!("[meeting] join ok");
                            emit_snapshot(&meeting, &edges, &contacts, &out, epoch, generation, &media).await
                        }
                        Err(error) => fail!(error),
                    },
                    MeetingCommand::SetDevice { source, on } => {
                        set_device(&mut media, &gate, &mut lease, source, on, &out, epoch, generation).await;
                    }
                    MeetingCommand::StartShare => {
                        set_device(&mut media, &gate, &mut lease, Source::Screen, true, &out, epoch, generation).await;
                    }
                    MeetingCommand::StopShare => {
                        set_device(&mut media, &gate, &mut lease, Source::Screen, false, &out, epoch, generation).await;
                    }
                    MeetingCommand::RetryEdge { join_id, .. } => {
                        if let Some(work) = edges.remove(&join_id) {
                            let _ = media.detach_edge(&work.slot).await;
                            let _ = work.edge.close().await;
                        }
                        retry_after.remove(&join_id);
                        let _ = meeting.fail_edge(&join_id);
                        offer_peer(&mut meeting, &mut media, &mut edges, &mut retry_after, &join_id, &out, epoch, generation).await;
                    }
                    MeetingCommand::Leave => {
                        teardown(&mut media, &mut edges).await;
                        match meeting.leave().await {
                            Ok(()) => eprintln!("[meeting] leave ok"),
                            Err(error) => fail!(error),
                        }
                        emit!(MeetingUpdate::Left);
                    }
                    MeetingCommand::End => {
                        teardown(&mut media, &mut edges).await;
                        match meeting.end().await {
                            Ok(()) => eprintln!("[meeting] end ok"),
                            Err(error) => fail!(error),
                        }
                        emit!(MeetingUpdate::Ended { by_host: true });
                    }
                    MeetingCommand::DismissError => {}
                }
            }
            event = media_events.recv() => {
                let Some(event) = event else { break };
                match event {
                    MeetingEvent::EdgeFailed { slot, message } => {
                        if let Some(work) = edges.get_mut(slot.join_id.as_str()) {
                            work.status = EdgeStatus::Failed { retryable: true };
                        }
                        let _ = meeting.fail_edge(slot.join_id.as_str());
                        fail!(message);
                    }
                    MeetingEvent::RemoteEnded(slot) => {
                        if let Some(work) = edges.remove(slot.join_id.as_str()) {
                            let _ = media.detach_edge(&work.slot).await;
                            let _ = work.edge.close().await;
                        }
                    }
                    MeetingEvent::Failed { source, message } => {
                        if let Some(source) = source {
                            emit!(MeetingUpdate::Device { source: ui_source(source), state: DeviceState::Off });
                        }
                        fail!(message);
                    }
                    MeetingEvent::CaptureStarted(source) => {
                        emit!(MeetingUpdate::Device { source: ui_source(source), state: DeviceState::On });
                    }
                    MeetingEvent::CaptureStopped(source) => {
                        emit!(MeetingUpdate::Device { source: ui_source(source), state: DeviceState::Off });
                    }
                    _ => {}
                }
            }
            _ = tick.tick() => {
                // 邀请收件箱与是否在会无关：每 9 秒轮询一次，新邀请才会出现在 UI。
                if last_invitations.elapsed() >= INVITATIONS_AFTER {
                    last_invitations = Instant::now();
                    match meeting.invitations().await {
                        Ok(invitations) => {
                            emit!(MeetingUpdate::Invitations(
                                invitations
                                    .iter()
                                    .map(|invitation| map_invitation(invitation, &contacts))
                                    .collect(),
                            ));
                        }
                        Err(error) => fail!(error),
                    }
                }
                if meeting.local_join().is_none() {
                    continue;
                }
                if last_renew.elapsed() >= RENEW_AFTER {
                    last_renew = Instant::now();
                    match meeting.renew().await {
                        Ok(removed) => drop_edges(&mut media, &mut edges, removed, meeting.local_join().unwrap_or_default()).await,
                        Err(error) => {
                            // 房间消失/绑定失效都不可自愈：按会议已结束收尾。
                            if matches!(error, SignalingError::Expired | SignalingError::NotFound | SignalingError::Binding) {
                                teardown(&mut media, &mut edges).await;
                                emit!(MeetingUpdate::Ended { by_host: false });
                                continue;
                            }
                            fail!(error);
                        }
                    }
                }
                match meeting.snapshot().await {
                    Ok(removed) => drop_edges(&mut media, &mut edges, removed, meeting.local_join().unwrap_or_default()).await,
                    Err(error) => {
                        if matches!(error, SignalingError::Expired | SignalingError::NotFound | SignalingError::Binding) {
                            teardown(&mut media, &mut edges).await;
                            emit!(MeetingUpdate::Ended { by_host: false });
                            continue;
                        }
                        fail!(error);
                    }
                }
                if matches!(meeting.current_snapshot().map(|s| s.room.status), Some(RoomStatus::Ended)) {
                    teardown(&mut media, &mut edges).await;
                    emit!(MeetingUpdate::Ended { by_host: false });
                    continue;
                }
                match meeting.poll_offers().await {
                    Ok(offers) => {
                        for offer in offers {
                            answer_offer(&mut meeting, &mut media, &mut edges, offer, &out, epoch, generation).await;
                        }
                    }
                    Err(error) => fail!(error),
                }
                match meeting.poll_answers().await {
                    Ok(answers) => {
                        for answer in answers {
                            accept_answer(&mut edges, answer, &out, epoch, generation).await;
                        }
                    }
                    Err(error) => fail!(error),
                }
                for (peer_join, work) in edges.iter_mut() {
                    if work.status == EdgeStatus::Connecting {
                        let stats = work.edge.stats().await;
                        let pc_state = work.edge.connection_state();
                        let next = match stats.route {
                            ObservedRoute::Direct => EdgeStatus::Direct,
                            ObservedRoute::Relay => EdgeStatus::Relay,
                            // 无 TURN 配置时选中候选对即直连；route 统计依赖媒体包，
                            // 未开设备时可能长期 Unknown，不能因此卡在“连接中”。
                            ObservedRoute::Unknown
                                if pc_state == RTCPeerConnectionState::Connected =>
                            {
                                EdgeStatus::Direct
                            }
                            ObservedRoute::Unknown
                                if work.deadline < Instant::now()
                                    || matches!(pc_state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) =>
                            {
                                EdgeStatus::Failed { retryable: true }
                            }
                            ObservedRoute::Unknown => EdgeStatus::Connecting,
                        };
                        if next != work.status {
                            eprintln!(
                                "[meeting] edge {peer_join}: {:?} -> {next:?} (route={:?}, pc={pc_state:?})",
                                work.status, stats.route
                            );
                            work.status = next;
                        }
                    }
                }
                ensure_edges(&mut meeting, &mut media, &mut edges, &mut retry_after, &out, epoch, generation).await;
                emit_snapshot(&meeting, &edges, &contacts, &out, epoch, generation, &media).await;
            }
        }
    }
    // 通道关闭或 stop：尽力清理本机资源；会话已结束时不发 RPC。
    let _ = media.shutdown().await;
    for (_, work) in edges {
        let _ = work.edge.close().await;
    }
    hub.close_all();
}

#[allow(clippy::too_many_arguments)]
async fn set_device(
    media: &mut MeetingMedia,
    gate: &DeviceGate,
    lease: &mut Option<surreal_ck_native_call::meeting::DeviceLease>,
    source: Source,
    on: bool,
    out: &Sender<(u64, Event)>,
    epoch: u64,
    generation: u64,
) {
    macro_rules! emit {
        ($update:expr) => {{
            let _ = out.send((epoch, Event::Meeting(generation, $update))).await;
        }};
    }
    if on {
        if lease.is_none() {
            match gate.try_acquire(GateOwner::Meeting) {
                Ok(acquired) => *lease = Some(acquired),
                Err(_) => {
                    emit!(MeetingUpdate::Device {
                        source,
                        state: DeviceState::Off
                    });
                    emit!(MeetingUpdate::Error(MeetingError::Retryable {
                        msg: "设备正被 1:1 通话占用".into()
                    }));
                    return;
                }
            }
        }
        match default_input(call_source(source)) {
            Some(input) => match media.start_capture(call_source(source), input).await {
                Ok(()) => emit!(MeetingUpdate::Device {
                    source,
                    state: DeviceState::On
                }),
                Err(error) => {
                    emit!(MeetingUpdate::Device {
                        source,
                        state: DeviceState::Off
                    });
                    emit!(MeetingUpdate::Error(map_error(error)));
                }
            },
            None => {
                emit!(MeetingUpdate::Device {
                    source,
                    state: DeviceState::Off
                });
                emit!(MeetingUpdate::Error(MeetingError::Unavailable(
                    UnavailableReason::UnsupportedPlatform
                )));
            }
        }
    } else {
        match media.stop_capture(call_source(source)).await {
            Ok(()) => emit!(MeetingUpdate::Device {
                source,
                state: DeviceState::Off
            }),
            Err(error) => {
                emit!(MeetingUpdate::Device {
                    source,
                    state: DeviceState::StopUnconfirmed
                });
                emit!(MeetingUpdate::Error(map_error(error)));
            }
        }
    }
}

fn map_invitation(
    invitation: &surreal_ck_native_identity::meeting::Invitation,
    contacts: &[Contact],
) -> Invitation {
    Invitation {
        room_code: invitation.code.clone(),
        host_name: contacts
            .iter()
            .find(|contact| contact.member_id == invitation.host)
            .map(|contact| contact.name.clone())
            .unwrap_or_else(|| invitation.host.clone()),
        invited_at: format!(
            "{} 秒后过期",
            invitation
                .expires_unix
                .saturating_sub(invitation.server_unix)
        ),
    }
}

#[allow(clippy::too_many_arguments)]
async fn emit_snapshot(
    meeting: &Meeting<MeetingConnection>,
    edges: &BTreeMap<String, EdgeWork>,
    contacts: &[Contact],
    out: &Sender<(u64, Event)>,
    epoch: u64,
    generation: u64,
    media: &MeetingMedia,
) {
    let Some(snapshot) = meeting.current_snapshot() else {
        return;
    };
    let local = meeting.local_join();
    let local_capture = media.capture_state();
    let capture = local_capture.borrow().clone();
    let view = RoomSnapshot {
        room_id: snapshot.room.id.clone(),
        room_code: snapshot.room.code.clone(),
        version: snapshot.room.version,
        state: match snapshot.room.status {
            RoomStatus::Open => RoomState::Active,
            RoomStatus::Ended => RoomState::Ended,
        },
        host: snapshot.room.host.clone(),
        local_join_id: local.map(str::to_owned),
        members: snapshot
            .members
            .iter()
            .map(|member| {
                let is_local = local == Some(member.join_id.as_str());
                let (mic, camera, sharing) = if is_local {
                    (
                        device_from_capture(capture.status(CallSource::Microphone)),
                        device_from_capture(capture.status(CallSource::Camera)),
                        matches!(capture.status(CallSource::Screen), CaptureStatus::Running),
                    )
                } else {
                    (DeviceState::Off, DeviceState::Off, false)
                };
                MemberView {
                    member_id: member.member.clone(),
                    display_name: contacts
                        .iter()
                        .find(|contact| contact.member_id == member.member)
                        .map(|contact| contact.name.clone())
                        .unwrap_or_else(|| member.member.clone()),
                    join_id: member.join_id.clone(),
                    is_host: member.member == snapshot.room.host,
                    is_local,
                    mic,
                    camera,
                    sharing,
                    edge: edges
                        .get(&member.join_id)
                        .map(|work| work.status.clone())
                        .unwrap_or(if is_local {
                            EdgeStatus::Unknown
                        } else {
                            EdgeStatus::Connecting
                        }),
                }
            })
            .collect(),
    };
    let _ = out
        .send((
            epoch,
            Event::Meeting(generation, MeetingUpdate::Snapshot(view)),
        ))
        .await;
}
fn device_from_capture(status: CaptureStatus) -> DeviceState {
    match status {
        CaptureStatus::Running => DeviceState::On,
        CaptureStatus::Unconfirmed => DeviceState::StopUnconfirmed,
        _ => DeviceState::Off,
    }
}

/// 对 snapshot 里缺失边的成员发起直连 offer（仅 join_id 较小侧）。
async fn ensure_edges(
    meeting: &mut Meeting<MeetingConnection>,
    media: &mut MeetingMedia,
    edges: &mut BTreeMap<String, EdgeWork>,
    retry_after: &mut BTreeMap<String, Instant>,
    out: &Sender<(u64, Event)>,
    epoch: u64,
    generation: u64,
) {
    let (Some(snapshot), Some(local)) = (
        meeting.current_snapshot().cloned(),
        meeting.local_join().map(str::to_owned),
    ) else {
        return;
    };
    for join in snapshot.members.iter().map(|m| m.join_id.clone()) {
        if join == local
            || edges.contains_key(&join)
            || retry_after.get(&join).is_some_and(|t| *t > Instant::now())
        {
            continue;
        }
        if local.as_str() < join.as_str() {
            offer_peer(
                meeting,
                media,
                edges,
                retry_after,
                &join,
                out,
                epoch,
                generation,
            )
            .await;
        }
    }
}
async fn offer_peer(
    meeting: &mut Meeting<MeetingConnection>,
    media: &mut MeetingMedia,
    edges: &mut BTreeMap<String, EdgeWork>,
    retry_after: &mut BTreeMap<String, Instant>,
    peer_join: &str,
    out: &Sender<(u64, Event)>,
    epoch: u64,
    generation: u64,
) {
    let prepared = async {
        let (snapshot, local) = (
            meeting.current_snapshot().cloned().ok_or("未在会议中")?,
            meeting
                .local_join()
                .map(str::to_owned)
                .ok_or("未在会议中")?,
        );
        let member = snapshot
            .members
            .iter()
            .find(|m| m.join_id == peer_join)
            .ok_or("成员已离开")?
            .member
            .clone();
        let attempt =
            transport_attempt(&snapshot.room.id, &local, peer_join, 1, RouteKind::Direct)?;
        Ok::<_, String>((attempt, local, member))
    }
    .await;
    let (attempt, local, member) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            retry_after.insert(peer_join.to_owned(), Instant::now() + EDGE_RETRY);
            let _ = out
                .send((
                    epoch,
                    Event::Meeting(generation, MeetingUpdate::Error(map_error(error))),
                ))
                .await;
            return;
        }
    };
    let local_id = JoinId::new(&local).map_err(|e| e.to_string());
    let mut edge = match local_id {
        Ok(local_id) => match MeetingEdge::new(
            attempt,
            local_id,
            TransportRoute::Direct,
            vec![],
            SettingEngine::default(),
        )
        .await
        {
            Ok(edge) => edge,
            Err(error) => {
                retry_after.insert(peer_join.to_owned(), Instant::now() + EDGE_RETRY);
                let _ = out
                    .send((
                        epoch,
                        Event::Meeting(generation, MeetingUpdate::Error(map_error(error))),
                    ))
                    .await;
                return;
            }
        },
        Err(error) => {
            retry_after.insert(peer_join.to_owned(), Instant::now() + EDGE_RETRY);
            let _ = out
                .send((
                    epoch,
                    Event::Meeting(generation, MeetingUpdate::Error(map_error(error))),
                ))
                .await;
            return;
        }
    };
    // 建边后的每一步都可能失败：失败时必须 close 已建的 edge，
    // 否则 PC/UDP 套接字会随每个重试 tick 泄漏。
    let result = async {
        let offer = edge.offer().await.map_err(|e| e.to_string())?;
        let hash = offer_hash(&offer);
        let offer_json = serde_json::to_string(&offer).map_err(|e| e.to_string())?;
        meeting
            .start_edge(peer_join, Route::Direct, &offer_json)
            .await
            .map_err(|e| e.to_string())?;
        let slot = MemberSlot {
            member_id: member,
            join_id: JoinId::new(peer_join).map_err(|e| e.to_string())?,
        };
        let events = edge.take_events().ok_or("边事件通道缺失")?;
        media
            .attach_edge(slot.clone(), edge.media(), events)
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>((slot, hash))
    }
    .await;
    match result {
        Ok((slot, hash)) => {
            retry_after.remove(peer_join);
            if let Some(old) = edges.insert(
                peer_join.to_owned(),
                EdgeWork {
                    slot,
                    edge,
                    offer_hash: Some(hash),
                    deadline: Instant::now() + ATTEMPT_TTL,
                    status: EdgeStatus::Connecting,
                },
            ) {
                let _ = media.detach_edge(&old.slot).await;
                let _ = old.edge.close().await;
            }
        }
        Err(error) => {
            let _ = edge.close().await;
            retry_after.insert(peer_join.to_owned(), Instant::now() + EDGE_RETRY);
            let _ = out
                .send((
                    epoch,
                    Event::Meeting(generation, MeetingUpdate::Error(map_error(error))),
                ))
                .await;
        }
    }
}
async fn answer_offer(
    meeting: &mut Meeting<MeetingConnection>,
    media: &mut MeetingMedia,
    edges: &mut BTreeMap<String, EdgeWork>,
    offer: AuthenticatedMeetingOffer,
    out: &Sender<(u64, Event)>,
    epoch: u64,
    generation: u64,
) {
    let prepared = async {
        let (snapshot, local) = (
            meeting.current_snapshot().cloned().ok_or("未在会议中")?,
            meeting
                .local_join()
                .map(str::to_owned)
                .ok_or("未在会议中")?,
        );
        let peer_join = offer.peer_join().to_owned();
        let attempt = transport_attempt(
            &snapshot.room.id,
            &local,
            &peer_join,
            offer.attempt(),
            route_kind(offer.route()),
        )?;
        Ok::<_, String>((attempt, local, peer_join))
    }
    .await;
    let (attempt, local, peer_join) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = out
                .send((
                    epoch,
                    Event::Meeting(generation, MeetingUpdate::Error(map_error(error))),
                ))
                .await;
            return;
        }
    };
    let local_id = JoinId::new(&local).map_err(|e| e.to_string());
    let mut edge = match local_id {
        Ok(local_id) => match MeetingEdge::new(
            attempt,
            local_id,
            TransportRoute::Direct,
            vec![],
            SettingEngine::default(),
        )
        .await
        {
            Ok(edge) => edge,
            Err(error) => {
                let _ = out
                    .send((
                        epoch,
                        Event::Meeting(generation, MeetingUpdate::Error(map_error(error))),
                    ))
                    .await;
                return;
            }
        },
        Err(error) => {
            let _ = out
                .send((
                    epoch,
                    Event::Meeting(generation, MeetingUpdate::Error(map_error(error))),
                ))
                .await;
            return;
        }
    };
    // 与 offer_peer 同理：失败必须 close，避免套接字泄漏。
    let result = async {
        let desc: RTCSessionDescription =
            serde_json::from_str(offer.sdp_json()).map_err(|e| e.to_string())?;
        let answer = edge.answer(desc).await.map_err(|e| e.to_string())?;
        let answer_json = serde_json::to_string(&answer).map_err(|e| e.to_string())?;
        meeting
            .answer(&offer, &answer_json)
            .await
            .map_err(|e| e.to_string())?;
        let slot = MemberSlot {
            member_id: offer.peer_member().to_owned(),
            join_id: JoinId::new(&peer_join).map_err(|e| e.to_string())?,
        };
        let events = edge.take_events().ok_or("边事件通道缺失")?;
        media
            .attach_edge(slot.clone(), edge.media(), events)
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(slot)
    }
    .await;
    match result {
        Ok(slot) => {
            if let Some(old) = edges.insert(
                peer_join,
                EdgeWork {
                    slot,
                    edge,
                    offer_hash: None,
                    deadline: Instant::now() + ATTEMPT_TTL,
                    status: EdgeStatus::Connecting,
                },
            ) {
                let _ = media.detach_edge(&old.slot).await;
                let _ = old.edge.close().await;
            }
        }
        Err(error) => {
            let _ = edge.close().await;
            let _ = out
                .send((
                    epoch,
                    Event::Meeting(generation, MeetingUpdate::Error(map_error(error))),
                ))
                .await;
        }
    }
}
async fn accept_answer(
    edges: &mut BTreeMap<String, EdgeWork>,
    answer: AuthenticatedMeetingAnswer,
    out: &Sender<(u64, Event)>,
    epoch: u64,
    generation: u64,
) {
    let peer = answer.peer_join().to_owned();
    let Some(work) = edges.get_mut(&peer) else {
        return;
    };
    let Some(hash) = work.offer_hash else {
        return;
    };
    let result = async {
        let desc: RTCSessionDescription =
            serde_json::from_str(answer.sdp_json()).map_err(|e| e.to_string())?;
        work.edge
            .accept_answer(desc, hash)
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    match result {
        Ok(()) => work.offer_hash = None,
        Err(error) => {
            work.status = EdgeStatus::Failed { retryable: true };
            let _ = out
                .send((
                    epoch,
                    Event::Meeting(generation, MeetingUpdate::Error(map_error(error))),
                ))
                .await;
        }
    }
}
async fn drop_edges(
    media: &mut MeetingMedia,
    edges: &mut BTreeMap<String, EdgeWork>,
    removed: Vec<surreal_ck_native_signaling::meeting::EdgeKey>,
    local_join: &str,
) {
    for key in removed {
        let peer = if key.low_join == local_join {
            key.high_join
        } else {
            key.low_join
        };
        if let Some(work) = edges.remove(&peer) {
            let _ = media.detach_edge(&work.slot).await;
            let _ = work.edge.close().await;
        }
    }
}
async fn teardown(media: &mut MeetingMedia, edges: &mut BTreeMap<String, EdgeWork>) {
    let _ = media.shutdown().await;
    for (_, work) in std::mem::take(edges) {
        let _ = work.edge.close().await;
    }
}

/// 平台默认采集源：UI 当前无设备选择器，集成层取系统默认设备；
/// 无采集栈的平台返回 None（调用方上报 UnsupportedPlatform）。
fn default_input(source: CallSource) -> Option<CaptureInput> {
    let video = VideoConfig {
        width: 1280,
        height: 720,
        fps: if source == CallSource::Screen { 15 } else { 30 },
    };
    #[cfg(target_os = "macos")]
    {
        Some(match source {
            CallSource::Microphone => CaptureInput::MacMicrophone { device_index: 0 },
            CallSource::Camera => CaptureInput::MacVideo {
                device_index: 0,
                video,
            },
            // 屏幕不是普通摄像头索引：AVFoundation 用伪设备名「Capture screen <n>」；
            // 无摄像头机型（如 CI VM）上设备序号不可预测，按名引用并交 TCC 授权。
            CallSource::Screen => CaptureInput::MacScreen {
                screen_index: 0,
                video,
            },
        })
    }
    #[cfg(target_os = "linux")]
    {
        Some(match source {
            CallSource::Microphone => CaptureInput::Microphone {
                source: "default".into(),
            },
            CallSource::Camera => CaptureInput::Camera {
                device: "/dev/video0".into(),
                video,
            },
            CallSource::Screen => CaptureInput::X11Screen {
                display: std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into()),
                video,
            },
        })
    }
    #[cfg(target_os = "windows")]
    {
        Some(match source {
            CallSource::Microphone => CaptureInput::WindowsMicrophone {
                device: String::new(),
            },
            CallSource::Camera => CaptureInput::WindowsCamera {
                device: String::new(),
                video,
            },
            CallSource::Screen => CaptureInput::WindowsScreen { x: 0, y: 0, video },
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (source, video);
        None
    }
}
