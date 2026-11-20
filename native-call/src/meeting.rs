//! 房间级采集与逐成员媒体隔离；不处理信令或设备授权。
use crate::desktop::{
    bounded, cancelled, capture_state_changed, index, receive_loop, validate_encoded,
    validate_input, video_dimensions, CaptureOperation, RemoteCommand, Worker, ALL_SOURCES,
    IO_TIMEOUT, KEYFRAME_TIMEOUT, START_TIMEOUT,
};
use crate::{CallEvent, CaptureInput, CaptureState, CaptureStatus, Error, Source, VideoSink};
use bytes::Bytes;
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use surreal_ck_native_media_platform::desktop::Capture;
pub use surreal_ck_native_media_platform::desktop::Encoded;
use surreal_ck_peer_transport::{
    media::{Event, Media},
    meeting::JoinId,
};
use tokio::sync::{mpsc, oneshot, watch, Notify};

pub const MAX_EDGES: usize = 3;
pub type MediaFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberSlot {
    pub member_id: String,
    pub join_id: JoinId,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderSlot {
    pub member_id: String,
    pub join_id: JoinId,
    pub source: Source,
}
impl MemberSlot {
    fn render(&self, source: Source) -> RenderSlot {
        RenderSlot {
            member_id: self.member_id.clone(),
            join_id: self.join_id.clone(),
            source,
        }
    }
}
/// 必须是非阻塞的有界 mailbox 写入；不能在回调内执行解码或 UI 循环。
pub type MeetingVideoSink =
    Arc<dyn Fn(&RenderSlot, u16, u16, Bytes) -> Result<(), String> + Send + Sync>;
#[derive(Clone, Debug)]
pub enum MeetingEvent {
    CaptureStarted(Source),
    CaptureStopped(Source),
    EdgeAttached(MemberSlot),
    EdgeDetached(MemberSlot),
    EdgeFailed {
        slot: MemberSlot,
        message: String,
    },
    VideoPresented(RenderSlot),
    RemoteEnded(RenderSlot),
    Failed {
        source: Option<Source>,
        message: String,
    },
}
fn emit(events: &mpsc::Sender<MeetingEvent>, event: MeetingEvent) {
    let _ = events.try_send(event);
}

/// 注入源也必须提供关闭确认；取消 next 不代表设备已经关闭。
pub trait EncodedCapture: Send {
    fn next(&mut self) -> MediaFuture<'_, Encoded>;
    fn stop(&mut self) -> MediaFuture<'_, ()>;
}
impl EncodedCapture for Capture {
    fn next(&mut self) -> MediaFuture<'_, Encoded> {
        Box::pin(async move {
            Capture::next(self)
                .await
                .map_err(|e| Error::Backend(e.to_string()))
        })
    }
    fn stop(&mut self) -> MediaFuture<'_, ()> {
        Box::pin(async move {
            Capture::stop(self)
                .await
                .map_err(|e| Error::Backend(e.to_string()))
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateOwner {
    Call,
    Meeting,
}
#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("设备正被占用")]
pub struct Busy;
#[derive(Clone, Default)]
pub struct DeviceGate(Arc<Mutex<Option<GateOwner>>>);
pub struct DeviceLease {
    gate: DeviceGate,
}
impl DeviceGate {
    pub fn try_acquire(&self, owner: GateOwner) -> Result<DeviceLease, Busy> {
        let mut held = self.0.lock().unwrap();
        if held.is_some() {
            return Err(Busy);
        }
        *held = Some(owner);
        Ok(DeviceLease { gate: self.clone() })
    }
}
impl Drop for DeviceLease {
    fn drop(&mut self) {
        *self.gate.0.lock().unwrap() = None;
    }
}

#[derive(Clone)]
struct Frame {
    data: Bytes,
    duration: Duration,
    keyframe: bool,
}
struct Backlog {
    frames: mpsc::Receiver<Frame>,
    waiting_keyframe: bool,
}
struct SendQueue {
    sender: mpsc::Sender<Frame>,
    backlog: Mutex<Backlog>,
    ready: Notify,
}
impl SendQueue {
    fn new(source: Source) -> Self {
        let (sender, frames) = mpsc::channel(if source == Source::Microphone { 10 } else { 3 });
        Self {
            sender,
            backlog: Mutex::new(Backlog {
                frames,
                waiting_keyframe: source != Source::Microphone,
            }),
            ready: Notify::new(),
        }
    }
    fn reset(&self, video: bool) {
        let mut backlog = self.backlog.lock().unwrap();
        while backlog.frames.try_recv().is_ok() {}
        backlog.waiting_keyframe = video;
    }
    fn push(&self, frame: Frame, video: bool) -> bool {
        let mut backlog = self.backlog.lock().unwrap();
        let overflow = self.sender.capacity() == 0;
        if overflow {
            while backlog.frames.try_recv().is_ok() {}
            backlog.waiting_keyframe = video;
        }
        if !backlog.waiting_keyframe || frame.keyframe {
            backlog.waiting_keyframe = false;
            let _ = self.sender.try_send(frame);
            self.ready.notify_one();
        }
        overflow && video
    }
    async fn next(&self) -> Frame {
        loop {
            let notified = self.ready.notified();
            if let Ok(frame) = self.backlog.lock().unwrap().frames.try_recv() {
                return frame;
            }
            notified.await;
        }
    }
}
struct EdgeSend {
    slot: MemberSlot,
    media: Arc<Media>,
    queues: [SendQueue; 3],
    alive: AtomicBool,
    enabled: [watch::Sender<bool>; 3],
}
impl EdgeSend {
    fn set_enabled(&self, source: Source, enabled: bool) {
        if !enabled {
            self.enabled[index(source)].send_replace(false);
        }
        self.media.set_enabled(source, enabled);
        self.queues[index(source)].reset(source != Source::Microphone);
        if enabled {
            self.enabled[index(source)].send_replace(true);
        }
    }
    fn disable(&self) {
        self.alive.store(false, Ordering::SeqCst);
        for source in ALL_SOURCES {
            self.set_enabled(source, false);
        }
    }
}
type Outputs = Arc<Mutex<Vec<Arc<EdgeSend>>>>;
fn disable_source(outputs: &Outputs, source: Source) {
    for edge in outputs.lock().unwrap().iter() {
        edge.set_enabled(source, false);
    }
}
struct Edge {
    send: Arc<EdgeSend>,
    senders: Vec<Worker>,
    receiver: Option<Worker>,
    bridge: Option<Worker>,
    remote: mpsc::Sender<RemoteCommand>,
    playback: watch::Receiver<CaptureState>,
}
impl Edge {
    async fn configure(&self, video: bool, enabled: bool) -> Result<(), Error> {
        let (ack, done) = oneshot::channel();
        bounded(
            async {
                self.remote
                    .send(RemoteCommand {
                        video,
                        enabled,
                        ack,
                    })
                    .await
                    .map_err(|_| Error::Stopped)?;
                done.await.map_err(|_| Error::Stopped)?
            },
            IO_TIMEOUT * 3,
        )
        .await
    }
    async fn stop(mut self) -> Result<(), Error> {
        self.send.disable();
        let mut result = Ok(());
        for worker in self
            .senders
            .drain(..)
            .chain(self.receiver.take())
            .chain(self.bridge.take())
        {
            if let Err(error) = worker.stop().await {
                result = Err(error);
            }
        }
        result
    }
}
impl Drop for Edge {
    fn drop(&mut self) {
        self.send.disable();
    }
}

struct ClosedEdge {
    slot: MemberSlot,
    playback: watch::Receiver<CaptureState>,
    error: Option<Error>,
}
pub struct MeetingMedia {
    outputs: Outputs,
    edges: Vec<Edge>,
    captures: [Option<Worker>; 3],
    states: watch::Sender<CaptureState>,
    keyframes: [watch::Sender<u64>; 3],
    sink: MeetingVideoSink,
    events: mpsc::Sender<MeetingEvent>,
    remote_audio: bool,
    remote_video: bool,
    stopped: bool,
    shutdown_error: Option<Error>,
    retired: Vec<ClosedEdge>,
}
impl MeetingMedia {
    pub fn new(sink: MeetingVideoSink) -> (Self, mpsc::Receiver<MeetingEvent>) {
        let (events, received) = mpsc::channel(64);
        (
            Self {
                outputs: Arc::new(Mutex::new(Vec::new())),
                edges: Vec::new(),
                captures: std::array::from_fn(|_| None),
                states: watch::channel(CaptureState::default()).0,
                keyframes: std::array::from_fn(|_| watch::channel(0).0),
                sink,
                events,
                remote_audio: false,
                remote_video: false,
                stopped: false,
                shutdown_error: None,
                retired: Vec::new(),
            },
            received,
        )
    }
    fn active(&self) -> Result<(), Error> {
        if self.stopped {
            Err(Error::Stopped)
        } else {
            Ok(())
        }
    }
    pub fn capture_state(&self) -> watch::Receiver<CaptureState> {
        self.states.subscribe()
    }
    pub fn playback_state(&self, slot: &MemberSlot) -> Option<watch::Receiver<CaptureState>> {
        self.edges
            .iter()
            .find(|e| &e.send.slot == slot)
            .map(|e| e.playback.clone())
            .or_else(|| {
                self.retired
                    .iter()
                    .find(|old| &old.slot == slot)
                    .map(|old| old.playback.clone())
            })
    }
    /// 仅在用户明确选择设备并完成系统授权后调用，不自动恢复旧设备。
    pub async fn start_capture(
        &mut self,
        source: Source,
        input: CaptureInput,
    ) -> Result<(), Error> {
        self.active()?;
        validate_input(source, &input)?;
        self.stop_capture(source).await?;
        let capture = Capture::start(input).map_err(|error| {
            capture_state_changed(
                &self.states,
                source,
                CaptureStatus::Stopped,
                Some(error.to_string()),
            );
            Error::Backend(error.to_string())
        })?;
        self.start_capture_with(source, Box::new(capture)).await
    }
    /// 用于注入或合成编码源；真实设备入口应调用 start_capture。
    pub async fn start_capture_with(
        &mut self,
        source: Source,
        mut capture: Box<dyn EncodedCapture>,
    ) -> Result<(), Error> {
        let mut operation =
            CaptureOperation::new(&self.states, source, "采集启动被取消，关闭未获确认");
        self.active()?;
        self.stop_capture(source).await?;
        let first = bounded(capture.next(), START_TIMEOUT)
            .await
            .and_then(|frame| {
                validate_encoded(source, &frame)?;
                if let Encoded::Video { data, .. } = &frame {
                    if video_dimensions(data)?.is_none() {
                        return Err(Error::Invalid);
                    }
                }
                Ok(frame)
            });
        let first = match first {
            Ok(frame) => frame,
            Err(error) => {
                let stopped = stop_process(&mut *capture, source, &self.states, &self.events).await;
                operation.complete();
                stopped?;
                return Err(error);
            }
        };
        capture_state_changed(&self.states, source, CaptureStatus::Running, None);
        for edge in self.outputs.lock().unwrap().iter() {
            if edge.alive.load(Ordering::SeqCst) {
                edge.set_enabled(source, true);
            }
        }
        emit(&self.events, MeetingEvent::CaptureStarted(source));
        let (cancel, cancel_rx) = watch::channel(false);
        let task = tokio::spawn(run_capture(
            capture,
            first,
            source,
            CaptureContext {
                outputs: self.outputs.clone(),
                requests: self.keyframes[index(source)].subscribe(),
                cancel: cancel_rx,
                states: self.states.clone(),
                events: self.events.clone(),
                operation: CaptureOperation::new(
                    &self.states,
                    source,
                    "采集任务被取消，关闭未获确认",
                ),
            },
        ));
        self.captures[index(source)] = Some(Worker { cancel, task });
        operation.complete();
        Ok(())
    }
    pub async fn stop_capture(&mut self, source: Source) -> Result<(), Error> {
        disable_source(&self.outputs, source);
        if let Some(worker) = self.captures[index(source)].take() {
            let mut operation =
                CaptureOperation::new(&self.states, source, "采集停止被取消，关闭未获确认");
            let result = worker.stop().await;
            operation.complete();
            if let Err(error) = result {
                capture_state_changed(
                    &self.states,
                    source,
                    CaptureStatus::Unconfirmed,
                    Some(error.to_string()),
                );
                return Err(error);
            }
        }
        if self.states.borrow().status(source) == CaptureStatus::Unconfirmed {
            return Err(Error::Backend("采集关闭未获确认".into()));
        }
        capture_state_changed(&self.states, source, CaptureStatus::Stopped, None);
        emit(&self.events, MeetingEvent::CaptureStopped(source));
        Ok(())
    }
    pub async fn attach_edge(
        &mut self,
        slot: MemberSlot,
        edge_media: Arc<Media>,
        events: mpsc::Receiver<Event>,
    ) -> Result<(), Error> {
        self.active()?;
        if slot.member_id.is_empty()
            || slot.member_id.len() > 128
            || slot.member_id.chars().any(char::is_control)
        {
            return Err(Error::Invalid);
        }
        if let Some(old) = self
            .edges
            .iter()
            .find(|e| e.send.slot.member_id == slot.member_id)
            .map(|e| e.send.slot.clone())
        {
            self.detach_edge(&old).await?;
        }
        if self.edges.len() >= MAX_EDGES {
            return Err(Error::Backend("会议远端成员已满".into()));
        }
        let send = Arc::new(EdgeSend {
            slot: slot.clone(),
            media: edge_media,
            queues: std::array::from_fn(|i| SendQueue::new(ALL_SOURCES[i])),
            alive: AtomicBool::new(true),
            enabled: std::array::from_fn(|_| watch::channel(false).0),
        });
        for source in ALL_SOURCES {
            send.set_enabled(
                source,
                self.states.borrow().status(source) == CaptureStatus::Running,
            );
        }
        let mut senders = Vec::new();
        for source in ALL_SOURCES {
            let (cancel, cancel_rx) = watch::channel(false);
            senders.push(Worker {
                cancel,
                task: tokio::spawn(send_loop(
                    send.clone(),
                    source,
                    cancel_rx,
                    self.events.clone(),
                )),
            });
        }
        let (remote, commands) = mpsc::channel(8);
        let (call_events, mut received) = mpsc::channel(32);
        let (cancel, cancel_rx) = watch::channel(false);
        let playback = watch::channel(CaptureState::default()).0;
        let member = slot.clone();
        let sink = self.sink.clone();
        let video_sink: VideoSink = Arc::new(move |source, width, height, data| {
            sink(&member.render(source), width, height, data)
        });
        let receiver = Worker {
            cancel,
            task: tokio::spawn(receive_loop(
                events,
                commands,
                cancel_rx,
                self.keyframes.clone(),
                video_sink,
                call_events,
                playback.clone(),
            )),
        };
        let member = slot.clone();
        let published = self.events.clone();
        let (cancel, mut cancelled_rx) = watch::channel(false);
        let bridge = Worker {
            cancel,
            task: tokio::spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        _ = cancelled(&mut cancelled_rx) => break,
                        event = received.recv() => match event {
                            Some(CallEvent::VideoPresented(source)) => emit(&published, MeetingEvent::VideoPresented(member.render(source))),
                            Some(CallEvent::RemoteEnded(source)) => emit(&published, MeetingEvent::RemoteEnded(member.render(source))),
                            Some(CallEvent::Failed { message, .. }) => emit(&published, MeetingEvent::EdgeFailed { slot: member.clone(), message }),
                            None => break,
                            _ => {},
                        }
                    }
                }
                Ok(())
            }),
        };
        let edge = Edge {
            send: send.clone(),
            senders,
            receiver: Some(receiver),
            bridge: Some(bridge),
            remote,
            playback: playback.subscribe(),
        };
        if let Err(error) = async {
            edge.configure(false, self.remote_audio).await?;
            edge.configure(true, self.remote_video).await
        }
        .await
        {
            let cleanup = edge.stop().await;
            if let Err(cleanup) = cleanup {
                self.shutdown_error = Some(cleanup);
            }
            return Err(error);
        }
        self.outputs.lock().unwrap().push(send);
        self.edges.push(edge);
        for source in [Source::Camera, Source::Screen] {
            self.keyframes[index(source)].send_modify(|n| *n = n.wrapping_add(1));
        }
        emit(&self.events, MeetingEvent::EdgeAttached(slot));
        Ok(())
    }
    pub async fn detach_edge(&mut self, slot: &MemberSlot) -> Result<(), Error> {
        let Some(at) = self.edges.iter().position(|e| &e.send.slot == slot) else {
            return self
                .retired
                .iter()
                .find(|old| &old.slot == slot)
                .map(|old| old.error.clone())
                .unwrap_or_else(|| self.shutdown_error.clone())
                .map_or(Ok(()), Err);
        };
        let edge = self.edges.remove(at);
        edge.send.disable();
        self.outputs.lock().unwrap().retain(|e| &e.slot != slot);
        // 只保留有界的最近关闭快照；已取出的 watch 仍可被宿主持有。
        self.retired.retain(|old| &old.slot != slot);
        if self.retired.len() == MAX_EDGES {
            self.retired.remove(0);
        }
        self.retired.push(ClosedEdge {
            slot: slot.clone(),
            playback: edge.playback.clone(),
            error: Some(Error::Backend("成员媒体关闭尚未确认".into())),
        });
        let previous_error = self
            .shutdown_error
            .replace(Error::Backend("成员媒体关闭尚未确认".into()));
        let result = edge.stop().await;
        if let Some(old) = self.retired.iter_mut().find(|old| &old.slot == slot) {
            old.error = result.as_ref().err().cloned();
        }
        self.shutdown_error = result.as_ref().err().cloned().or(previous_error);
        if result.is_ok() {
            emit(&self.events, MeetingEvent::EdgeDetached(slot.clone()));
        }
        result
    }
    pub async fn set_remote_audio_enabled(&mut self, enabled: bool) -> Result<(), Error> {
        self.configure_remote(false, enabled).await
    }
    pub async fn set_remote_video_enabled(&mut self, enabled: bool) -> Result<(), Error> {
        self.configure_remote(true, enabled).await
    }
    async fn configure_remote(&mut self, video: bool, enabled: bool) -> Result<(), Error> {
        self.active()?;
        if video {
            self.remote_video = enabled;
        } else {
            self.remote_audio = enabled;
        }
        let mut result = Ok(());
        for edge in &self.edges {
            if let Err(error) = edge.configure(video, enabled).await {
                result = Err(error);
            }
        }
        result
    }
    pub async fn shutdown(&mut self) -> Result<(), Error> {
        for edge in self.outputs.lock().unwrap().iter() {
            edge.disable();
        }
        self.stopped = true;
        let mut result = self.shutdown_error.clone().map_or(Ok(()), Err);
        for source in ALL_SOURCES {
            if let Err(error) = self.stop_capture(source).await {
                result = Err(error);
            }
        }
        while let Some(slot) = self.edges.last().map(|e| e.send.slot.clone()) {
            if let Err(error) = self.detach_edge(&slot).await {
                result = Err(error);
            }
        }
        self.shutdown_error = result.as_ref().err().cloned();
        result
    }
}
impl Drop for MeetingMedia {
    fn drop(&mut self) {
        for edge in self.outputs.lock().unwrap().iter() {
            edge.disable();
        }
    }
}

async fn send_loop(
    edge: Arc<EdgeSend>,
    source: Source,
    mut cancel: watch::Receiver<bool>,
    events: mpsc::Sender<MeetingEvent>,
) -> Result<(), Error> {
    let mut enabled = edge.enabled[index(source)].subscribe();
    loop {
        let frame = tokio::select! { biased; _ = cancelled(&mut cancel) => return Ok(()), _ = enabled.changed() => continue, frame = edge.queues[index(source)].next() => frame };
        if !edge.alive.load(Ordering::SeqCst) {
            return Ok(());
        }
        if !*enabled.borrow_and_update() {
            continue;
        }
        let result = tokio::select! { biased; _ = cancelled(&mut cancel) => return Ok(()), _ = enabled.changed() => continue, result = bounded(edge.media.send(source, frame.data, frame.duration), IO_TIMEOUT) => result };
        if let Err(error) = result {
            if edge.alive.swap(false, Ordering::SeqCst) {
                edge.disable();
                emit(
                    &events,
                    MeetingEvent::EdgeFailed {
                        slot: edge.slot.clone(),
                        message: error.to_string(),
                    },
                );
            }
            return Ok(());
        }
    }
}
async fn stop_process(
    capture: &mut dyn EncodedCapture,
    source: Source,
    states: &watch::Sender<CaptureState>,
    events: &mpsc::Sender<MeetingEvent>,
) -> Result<(), Error> {
    let result = bounded(capture.stop(), IO_TIMEOUT).await;
    capture_state_changed(
        states,
        source,
        if result.is_ok() {
            CaptureStatus::Stopped
        } else {
            CaptureStatus::Unconfirmed
        },
        result.as_ref().err().map(ToString::to_string),
    );
    match &result {
        Ok(()) => emit(events, MeetingEvent::CaptureStopped(source)),
        Err(error) => emit(
            events,
            MeetingEvent::Failed {
                source: Some(source),
                message: error.to_string(),
            },
        ),
    }
    result
}
struct CaptureContext {
    outputs: Outputs,
    requests: watch::Receiver<u64>,
    cancel: watch::Receiver<bool>,
    states: watch::Sender<CaptureState>,
    events: mpsc::Sender<MeetingEvent>,
    operation: CaptureOperation,
}
async fn run_capture(
    mut capture: Box<dyn EncodedCapture>,
    first: Encoded,
    source: Source,
    mut ctx: CaptureContext,
) -> Result<(), Error> {
    let mut next = Some(first);
    let mut deadline = None;
    let result: Result<(), Error> = async {
        loop {
            let frame = if let Some(frame) = next.take() { frame } else {
                let pending = bounded(capture.next(), START_TIMEOUT);
                tokio::pin!(pending);
                loop {
                    let until = deadline.unwrap_or_else(|| tokio::time::Instant::now() + START_TIMEOUT);
                    tokio::select! {
                        biased;
                        _ = cancelled(&mut ctx.cancel) => return Ok(()),
                        changed = ctx.requests.changed(), if source != Source::Microphone => {
                            changed.map_err(|_| Error::Stopped)?;
                            ctx.requests.borrow_and_update();
                            deadline.get_or_insert(tokio::time::Instant::now() + KEYFRAME_TIMEOUT);
                        }
                        _ = tokio::time::sleep_until(until), if deadline.is_some() => return Err(Error::Backend("关键帧请求超时，请重新选择设备并启动".into())),
                        frame = &mut pending => break frame?,
                    }
                }
            };
            if *ctx.cancel.borrow() { return Ok(()); }
            validate_encoded(source, &frame)?;
            let (data, duration) = match frame { Encoded::Video { data, duration } | Encoded::Audio { data, duration } => (data, duration) };
            let keyframe = source == Source::Microphone || data[0] & 1 == 0;
            if let Some(until) = deadline {
                if tokio::time::Instant::now() > until { return Err(Error::Timeout); }
                if keyframe { deadline = None; }
            }
            let frame = Frame { data, duration, keyframe };
            for edge in ctx.outputs.lock().unwrap().iter() {
                if edge.alive.load(Ordering::SeqCst) {
                    edge.queues[index(source)].push(frame.clone(), source != Source::Microphone);
                }
            }
        }
    }.await;
    disable_source(&ctx.outputs, source);
    if let Err(error) = &result {
        let status = ctx.states.borrow().status(source);
        capture_state_changed(&ctx.states, source, status, Some(error.to_string()));
        emit(
            &ctx.events,
            MeetingEvent::Failed {
                source: Some(source),
                message: error.to_string(),
            },
        );
    }
    let stopped = stop_process(&mut *capture, source, &ctx.states, &ctx.events).await;
    ctx.operation.complete();
    stopped
}

pub trait MeetingMediaControl: Send {
    fn start_capture(&mut self, source: Source, input: CaptureInput) -> MediaFuture<'_, ()>;
    fn stop_capture(&mut self, source: Source) -> MediaFuture<'_, ()>;
    fn attach_edge(
        &mut self,
        slot: MemberSlot,
        media: Arc<Media>,
        events: mpsc::Receiver<Event>,
    ) -> MediaFuture<'_, ()>;
    fn detach_edge<'a>(&'a mut self, slot: &'a MemberSlot) -> MediaFuture<'a, ()>;
    fn set_remote_audio_enabled(&mut self, enabled: bool) -> MediaFuture<'_, ()>;
    fn set_remote_video_enabled(&mut self, enabled: bool) -> MediaFuture<'_, ()>;
    fn capture_state(&self) -> watch::Receiver<CaptureState>;
    fn playback_state(&self, slot: &MemberSlot) -> Option<watch::Receiver<CaptureState>>;
    fn shutdown(&mut self) -> MediaFuture<'_, ()>;
}
impl MeetingMediaControl for MeetingMedia {
    fn start_capture(&mut self, source: Source, input: CaptureInput) -> MediaFuture<'_, ()> {
        Box::pin(MeetingMedia::start_capture(self, source, input))
    }
    fn stop_capture(&mut self, source: Source) -> MediaFuture<'_, ()> {
        Box::pin(MeetingMedia::stop_capture(self, source))
    }
    fn attach_edge(
        &mut self,
        slot: MemberSlot,
        media: Arc<Media>,
        events: mpsc::Receiver<Event>,
    ) -> MediaFuture<'_, ()> {
        Box::pin(MeetingMedia::attach_edge(self, slot, media, events))
    }
    fn detach_edge<'a>(&'a mut self, slot: &'a MemberSlot) -> MediaFuture<'a, ()> {
        Box::pin(MeetingMedia::detach_edge(self, slot))
    }
    fn set_remote_audio_enabled(&mut self, enabled: bool) -> MediaFuture<'_, ()> {
        Box::pin(MeetingMedia::set_remote_audio_enabled(self, enabled))
    }
    fn set_remote_video_enabled(&mut self, enabled: bool) -> MediaFuture<'_, ()> {
        Box::pin(MeetingMedia::set_remote_video_enabled(self, enabled))
    }
    fn capture_state(&self) -> watch::Receiver<CaptureState> {
        MeetingMedia::capture_state(self)
    }
    fn playback_state(&self, slot: &MemberSlot) -> Option<watch::Receiver<CaptureState>> {
        MeetingMedia::playback_state(self, slot)
    }
    fn shutdown(&mut self) -> MediaFuture<'_, ()> {
        Box::pin(MeetingMedia::shutdown(self))
    }
}

#[cfg(any(test, feature = "test-support"))]
pub mod fake;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn frame(keyframe: bool) -> Frame {
        Frame {
            data: Bytes::from_static(b"frame"),
            duration: Duration::from_millis(20),
            keyframe,
        }
    }
    #[tokio::test]
    async fn video_overflow_flushes_only_slow_edge_and_waits_for_keyframe() {
        let slow = SendQueue::new(Source::Camera);
        let fast = SendQueue::new(Source::Camera);
        assert!(!slow.push(frame(false), true));
        assert!(slow.backlog.lock().unwrap().frames.is_empty());
        slow.push(frame(true), true);
        for _ in 0..2 {
            slow.push(frame(false), true);
        }
        assert!(slow.push(frame(false), true));
        assert!(slow.backlog.lock().unwrap().frames.is_empty());
        for _ in 0..20 {
            assert!(!fast.push(frame(true), true));
            fast.next().await;
            slow.push(frame(false), true);
        }
        assert!(slow.backlog.lock().unwrap().frames.is_empty());
        slow.push(frame(true), true);
        assert!(slow.next().await.keyframe);
        let audio = SendQueue::new(Source::Microphone);
        for _ in 0..100 {
            audio.push(frame(false), false);
        }
        assert!(audio.backlog.lock().unwrap().frames.len() <= 10);
    }
    #[tokio::test]
    async fn cancelled_detach_cannot_turn_next_empty_detach_into_confirmation() {
        use surreal_ck_peer_transport::{Peer, Route};
        let peer = Peer::new(Route::Direct, vec![]).await.unwrap();
        let (media, _events) = Media::attach(&peer).await.unwrap();
        let slot = MemberSlot {
            member_id: "成员".into(),
            join_id: JoinId::new("join").unwrap(),
        };
        let send = Arc::new(EdgeSend {
            slot: slot.clone(),
            media: Arc::new(media),
            queues: std::array::from_fn(|i| SendQueue::new(ALL_SOURCES[i])),
            alive: AtomicBool::new(true),
            enabled: std::array::from_fn(|_| watch::channel(false).0),
        });
        let (mut meeting, _events) = MeetingMedia::new(Arc::new(|_, _, _, _| Ok(())));
        let (remote, _commands) = mpsc::channel(1);
        let (cancel, mut cancel_rx) = watch::channel(false);
        let (entered, entered_rx) = oneshot::channel();
        let receiver = Worker {
            cancel,
            task: tokio::spawn(async move {
                cancelled(&mut cancel_rx).await;
                let _ = entered.send(());
                std::future::pending().await
            }),
        };
        meeting.outputs.lock().unwrap().push(send.clone());
        meeting.edges.push(Edge {
            send,
            senders: vec![],
            receiver: Some(receiver),
            bridge: None,
            remote,
            playback: watch::channel(CaptureState::default()).1,
        });
        {
            let detach = meeting.detach_edge(&slot);
            tokio::pin!(detach);
            tokio::select! {
                _ = entered_rx => {},
                result = &mut detach => panic!("清理尚未确认：{result:?}"),
            }
        }
        assert!(meeting.detach_edge(&slot).await.is_err());
        assert!(meeting.shutdown().await.is_err());
        peer.close().await.unwrap();
    }
    struct PendingCapture {
        reads: Arc<AtomicUsize>,
        stops: Arc<AtomicUsize>,
        first: Option<Encoded>,
    }
    impl EncodedCapture for PendingCapture {
        fn next(&mut self) -> MediaFuture<'_, Encoded> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let first = self.first.take();
            Box::pin(async move {
                match first {
                    Some(frame) => Ok(frame),
                    None => std::future::pending().await,
                }
            })
        }
        fn stop(&mut self) -> MediaFuture<'_, ()> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }
    #[tokio::test]
    async fn keyframe_requests_merge_without_cancelling_frame_read_or_extending_deadline() {
        let (mut meeting, mut events) = MeetingMedia::new(Arc::new(|_, _, _, _| Ok(())));
        let reads = Arc::new(AtomicUsize::new(0));
        let stops = Arc::new(AtomicUsize::new(0));
        let (mut ivf, _) =
            surreal_ck_peer_transport::webrtc::media::io::ivf_reader::IVFReader::new(
                include_bytes!("../../native-transport/tests/fixtures/test.vp8.ivf").as_slice(),
            )
            .unwrap();
        let first = Encoded::Video {
            data: ivf.parse_next_frame().unwrap().0.freeze(),
            duration: Duration::from_millis(100),
        };
        meeting
            .start_capture_with(
                Source::Camera,
                Box::new(PendingCapture {
                    reads: reads.clone(),
                    stops: stops.clone(),
                    first: Some(first),
                }),
            )
            .await
            .unwrap();
        tokio::time::timeout(START_TIMEOUT, async {
            while reads.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
            for _ in 0..100 {
                meeting.keyframes[index(Source::Camera)].send_modify(|n| *n += 1);
            }
            // 后续请求不能把首次请求的截止时间一直推迟。
            let requests = meeting.keyframes[index(Source::Camera)].clone();
            let bump = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    requests.send_modify(|n| *n += 1);
                }
            });
            loop {
                if matches!(events.recv().await, Some(MeetingEvent::Failed { .. })) {
                    break;
                }
            }
            bump.abort();
            assert_eq!(reads.load(Ordering::SeqCst), 2);
        })
        .await
        .unwrap();
        meeting.stop_capture(Source::Camera).await.unwrap();
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert!(meeting
            .capture_state()
            .borrow()
            .error(Source::Camera)
            .is_some());
    }
}
