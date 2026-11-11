use bytes::Bytes;
use std::{
    future::Future,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use surreal_ck_native_media_platform::desktop::{AudioPlayer, Capture, Encoded, VideoDecoder};
pub use surreal_ck_native_media_platform::desktop::{CaptureInput, VideoConfig};
pub use surreal_ck_peer_transport::media::Source;
use surreal_ck_peer_transport::{
    chat::Chat,
    media::{Event, Media, MAX_VIDEO_FRAME},
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{timeout, Instant},
};

const IO_TIMEOUT: Duration = Duration::from_secs(3);
const START_TIMEOUT: Duration = Duration::from_secs(5);
const KEYFRAME_TIMEOUT: Duration = Duration::from_secs(2);
const VIDEO_QUEUE: usize = 3;
const AUDIO_QUEUE: usize = 10;
const ALL_SOURCES: [Source; 3] = [Source::Microphone, Source::Camera, Source::Screen];

/// 必须是非阻塞的有界 mailbox 写入，不能在回调中运行 UI 事件循环或 I/O。
/// 每个视频源应映射到自己的原生纹理；错误会停止相应解码器并报告。
pub type VideoSink = Arc<dyn Fn(Source, u16, u16, Bytes) -> Result<(), String> + Send + Sync>;

#[derive(Debug, Clone)]
pub enum CallEvent {
    CaptureStarted(Source),
    CaptureStopped(Source),
    RemoteVideoEnabled(bool),
    RemoteAudioEnabled(bool),
    VideoPresented(Source),
    RemoteEnded(Source),
    Failed {
        source: Option<Source>,
        message: String,
    },
    Stopped,
}
/// 不依赖普通事件队列的权威采集隐私快照；关闭未确认不能当作 Stopped。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CaptureStatus {
    #[default]
    Stopped,
    Running,
    Unconfirmed,
}
#[derive(Debug, Clone, Default)]
pub struct CaptureState {
    statuses: [CaptureStatus; 3],
    errors: [Option<String>; 3],
    revisions: [u64; 3],
}
impl CaptureState {
    pub fn status(&self, source: Source) -> CaptureStatus {
        self.statuses[index(source)]
    }
    pub fn error(&self, source: Source) -> Option<&str> {
        self.errors[index(source)].as_deref()
    }
    pub fn revision(&self, source: Source) -> u64 {
        self.revisions[index(source)]
    }
}
fn capture_state_changed(
    states: &watch::Sender<CaptureState>,
    source: Source,
    status: CaptureStatus,
    error: Option<String>,
) {
    states.send_modify(|state| {
        let at = index(source);
        state.statuses[at] = status;
        if status == CaptureStatus::Running {
            state.errors[at] = None;
        }
        if let Some(error) = error {
            state.errors[at] = Some(error);
        }
        state.revisions[at] = state.revisions[at].wrapping_add(1);
    });
}
#[derive(Debug, Clone, thiserror::Error)]
pub enum Error {
    #[error("通话已停止")]
    Stopped,
    #[error("媒体必须在 SDP 协商前且只附加一次")]
    AlreadyNegotiated,
    #[error("采集类型与所选轨不匹配")]
    SourceMismatch,
    #[error("无效的媒体帧或配置")]
    Invalid,
    #[error("{0}")]
    Backend(String),
    #[error("媒体操作超时")]
    Timeout,
}
fn index(source: Source) -> usize {
    match source {
        Source::Microphone => 0,
        Source::Camera => 1,
        Source::Screen => 2,
    }
}
fn emit(events: &mpsc::Sender<CallEvent>, event: CallEvent) {
    let _ = events.try_send(event);
}
fn failed(events: &mpsc::Sender<CallEvent>, source: Source, message: impl ToString) {
    emit(
        events,
        CallEvent::Failed {
            source: Some(source),
            message: message.to_string(),
        },
    );
}
async fn bounded<T, E: ToString>(
    future: impl Future<Output = Result<T, E>>,
    duration: Duration,
) -> Result<T, Error> {
    timeout(duration, future)
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|e| Error::Backend(e.to_string()))
}
struct Worker {
    cancel: watch::Sender<bool>,
    task: JoinHandle<Result<(), Error>>,
}
impl Worker {
    async fn stop(mut self) -> Result<(), Error> {
        let _ = self.cancel.send_replace(true);
        match timeout(IO_TIMEOUT, &mut self.task).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(Error::Backend(format!(
                "媒体任务异常退出，关闭未获确认：{error}"
            ))),
            Err(_) => {
                self.task.abort();
                let _ = (&mut self.task).await;
                Err(Error::Backend(
                    "媒体任务关闭超时，子进程关闭未获确认".into(),
                ))
            }
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.cancel.send_replace(true);
        self.task.abort();
    }
}
/// 控制future取消会直接drop被移出的Worker/采集器；kill-on-drop不是退出确认。
/// 守卫把这种失去确认的路径固定为Unconfirmed，禁止下一次空stop误清。
struct CaptureOperation {
    states: watch::Sender<CaptureState>,
    source: Source,
    cancelled_message: &'static str,
    complete: bool,
}
impl CaptureOperation {
    fn new(
        states: &watch::Sender<CaptureState>,
        source: Source,
        cancelled_message: &'static str,
    ) -> Self {
        Self {
            states: states.clone(),
            source,
            cancelled_message,
            complete: false,
        }
    }
    fn complete(&mut self) {
        self.complete = true;
    }
}
impl Drop for CaptureOperation {
    fn drop(&mut self) {
        if !self.complete {
            capture_state_changed(
                &self.states,
                self.source,
                CaptureStatus::Unconfirmed,
                Some(self.cancelled_message.into()),
            );
        }
    }
}
async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let _ = cancel.changed().await;
}

/// 先 attach，再创建/处理 offer。接收开关与本机采集完全独立。
/// 控制方法顺序调用；停止/断开后不能重新启动同一实例，应创建新的会话。
pub struct CallSession {
    media: Arc<Media>,
    captures: [Option<Worker>; 3],
    keyframes: [watch::Sender<u64>; 3],
    remote: mpsc::Sender<RemoteCommand>,
    receiver: Option<Worker>,
    monitor: Option<Worker>,
    session_closed: watch::Sender<bool>,
    events: mpsc::Sender<CallEvent>,
    stopped: bool,
    shutdown_error: Option<Error>,
    capture_states: watch::Sender<CaptureState>,
    playback_states: watch::Receiver<CaptureState>,
}
impl CallSession {
    pub async fn attach(
        chat: &Chat,
        sink: VideoSink,
    ) -> Result<(Self, mpsc::Receiver<CallEvent>), Error> {
        let peer = chat.peer().connection();
        let termination = chat.termination_observer();
        if peer.local_description().await.is_some()
            || peer.remote_description().await.is_some()
            || !peer.get_senders().await.is_empty()
        {
            return Err(Error::AlreadyNegotiated);
        }
        let (media, incoming) = Media::attach(chat.peer())
            .await
            .map_err(|e| Error::Backend(e.to_string()))?;
        let media = Arc::new(media);
        let (events, event_rx) = mpsc::channel(32);
        let (remote, commands) = mpsc::channel(4);
        let (cancel, cancel_rx) = watch::channel(false);
        let keyframes = std::array::from_fn(|_| watch::channel(0u64).0);
        let session_closed = cancel.clone();
        let (monitor_cancel, mut monitor_cancel_rx) = watch::channel(false);
        let monitor_closed = session_closed.clone();
        let monitor_media = media.clone();
        let monitor_events = events.clone();
        let monitor = tokio::spawn(async move {
            use surreal_ck_peer_transport::webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
            loop {
                tokio::select! {
                    biased;
                    _ = cancelled(&mut monitor_cancel_rx) => break,
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if termination.is_terminated() || matches!(peer.connection_state(), RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
                            for source in ALL_SOURCES { monitor_media.set_enabled(source, false); }
                            let _ = monitor_closed.send_replace(true);
                            emit(&monitor_events, CallEvent::Failed { source: None, message: "WebRTC 已断开，网络轨已禁用，正在关闭设备；需要重新建立通话".into() });
                            break;
                        }
                    }
                }
            }
            Ok(())
        });
        let (playback_publisher, playback_states) = watch::channel(CaptureState::default());
        let task = tokio::spawn(receive_loop(
            incoming,
            commands,
            cancel_rx,
            keyframes.clone(),
            sink,
            events.clone(),
            playback_publisher,
        ));
        Ok((
            Self {
                media,
                captures: std::array::from_fn(|_| None),
                keyframes,
                remote,
                receiver: Some(Worker { cancel, task }),
                monitor: Some(Worker {
                    cancel: monitor_cancel,
                    task: monitor,
                }),
                session_closed,
                events,
                stopped: false,
                shutdown_error: None,
                capture_states: watch::channel(CaptureState::default()).0,
                playback_states,
            },
            event_rx,
        ))
    }
    fn active(&self) -> Result<(), Error> {
        if self.stopped || *self.session_closed.borrow() {
            Err(Error::Stopped)
        } else {
            Ok(())
        }
    }

    /// 仅在用户明确点击、选择此设备/区域并完成适用系统授权后调用。
    /// 不接受来自对端信令的设备名，不自动选择默认设备，不失败回退测试图。
    /// 首个真实编码包读到后才开启网络轨；设备失联自动关闭网络轨。
    pub async fn start_capture(
        &mut self,
        source: Source,
        input: CaptureInput,
    ) -> Result<(), Error> {
        self.active()?;
        validate_input(source, &input)?;
        if self.captures[index(source)].is_some()
            || self.capture_states.borrow().status(source) != CaptureStatus::Stopped
        {
            self.stop_capture(source).await?;
        } else {
            self.media.set_enabled(source, false);
        }
        let mut capture = match Capture::start(input) {
            Ok(capture) => capture,
            Err(error) => {
                capture_state_changed(
                    &self.capture_states,
                    source,
                    CaptureStatus::Stopped,
                    Some(error.to_string()),
                );
                emit(&self.events, CallEvent::CaptureStopped(source));
                return Err(Error::Backend(error.to_string()));
            }
        };
        let mut operation = CaptureOperation::new(
            &self.capture_states,
            source,
            "采集启动操作被取消，进程关闭未获确认",
        );
        let mut closed = self.session_closed.subscribe();
        let first_result = tokio::select! {
            biased;
            _ = cancelled(&mut closed) => Err(Error::Stopped),
            first = bounded(capture.next(), START_TIMEOUT) => first,
        };
        let first = match first_result {
            Ok(frame) => frame,
            Err(error) => {
                let stopped =
                    stop_capture_process(&mut capture, source, &self.capture_states, &self.events)
                        .await;
                operation.complete();
                stopped?;
                return Err(error);
            }
        };
        if let Err(error) = validate_encoded(source, &first) {
            let stopped =
                stop_capture_process(&mut capture, source, &self.capture_states, &self.events)
                    .await;
            operation.complete();
            stopped?;
            return Err(error);
        }
        if let Encoded::Video { data, .. } = &first {
            if video_dimensions(data)?.is_none() {
                let stopped =
                    stop_capture_process(&mut capture, source, &self.capture_states, &self.events)
                        .await;
                operation.complete();
                stopped?;
                return Err(Error::Invalid);
            }
        }
        let (cancel, cancel_rx) = watch::channel(false);
        capture_state_changed(&self.capture_states, source, CaptureStatus::Running, None);
        self.media.set_enabled(source, true);
        // 首包已读取；必须先发布 Started，防止快速失败的任务先发布 Stopped 后被反序覆盖。
        emit(&self.events, CallEvent::CaptureStarted(source));
        let task = tokio::spawn(capture_loop(
            capture,
            first,
            source,
            self.media.clone(),
            CaptureControl {
                cancel: cancel_rx,
                requests: self.keyframes[index(source)].subscribe(),
                closed: self.session_closed.subscribe(),
                events: self.events.clone(),
                states: self.capture_states.clone(),
            },
        ));
        self.captures[index(source)] = Some(Worker { cancel, task });
        operation.complete();
        Ok(())
    }
    pub async fn stop_capture(&mut self, source: Source) -> Result<(), Error> {
        self.media.set_enabled(source, false);
        if let Some(worker) = self.captures[index(source)].take() {
            let mut operation = CaptureOperation::new(
                &self.capture_states,
                source,
                "停止采集操作被取消，进程关闭未获确认",
            );
            let stopped = worker.stop().await;
            operation.complete();
            if let Err(error) = stopped {
                capture_state_changed(
                    &self.capture_states,
                    source,
                    CaptureStatus::Unconfirmed,
                    Some(error.to_string()),
                );
                failed(&self.events, source, &error);
                return Err(error);
            }
        }
        if self.capture_states.borrow().status(source) == CaptureStatus::Unconfirmed {
            return Err(Error::Backend(
                "上次采集关闭未获确认，不能把空任务当作设备已关闭；请检查系统设备状态".into(),
            ));
        }
        capture_state_changed(&self.capture_states, source, CaptureStatus::Stopped, None);
        emit(&self.events, CallEvent::CaptureStopped(source));
        Ok(())
    }
    /// Unconfirmed 也保守视为可能仍在采集。
    pub fn capture_active(&self, source: Source) -> bool {
        self.capture_states.borrow().status(source) != CaptureStatus::Stopped
    }
    /// UI 必须持续订阅；普通事件队列饱和不会丢失最新状态和采集错误。
    pub fn capture_state(&self) -> watch::Receiver<CaptureState> {
        self.capture_states.subscribe()
    }
    /// 接收consumer的独立权威状态；Running仅表示允许接收，不代表已播放声音/帧。
    /// Stopped仅由逐源decoder/player关闭成功发布，不依赖总会话stop结果。
    pub fn playback_state(&self) -> watch::Receiver<CaptureState> {
        self.playback_states.clone()
    }
    pub async fn set_remote_video_enabled(&mut self, enabled: bool) -> Result<(), Error> {
        self.active()?;
        self.configure_remote(true, enabled).await
    }
    pub async fn set_remote_audio_enabled(&mut self, enabled: bool) -> Result<(), Error> {
        self.active()?;
        self.configure_remote(false, enabled).await
    }
    async fn configure_remote(&self, video: bool, enabled: bool) -> Result<(), Error> {
        let (ack, done) = oneshot::channel();
        self.remote
            .send(RemoteCommand {
                video,
                enabled,
                ack,
            })
            .await
            .map_err(|_| Error::Stopped)?;
        done.await.map_err(|_| Error::Stopped)?
    }
    /// UI 断开/关闭窗口时先 stop，再 Chat::close；不保留后台采集或播放。
    pub async fn stop(&mut self) -> Result<(), Error> {
        if self.stopped {
            return self.shutdown_error.clone().map_or(Ok(()), Err);
        }
        self.stopped = true;
        // 在第一次await之前记录未完成。取消整个future后再次stop不能读取初始None而误报成功。
        self.shutdown_error = Some(Error::Backend(
            "通话关闭被取消或尚未完成，不能确认所有媒体已关闭".into(),
        ));
        let _ = self.session_closed.send_replace(true);
        for source in ALL_SOURCES {
            self.media.set_enabled(source, false);
        }
        let mut result = Ok(());
        for source in ALL_SOURCES {
            if let Err(error) = self.stop_capture(source).await {
                result = Err(error);
            }
        }
        for worker in [self.receiver.take(), self.monitor.take()]
            .into_iter()
            .flatten()
        {
            if let Err(error) = worker.stop().await {
                emit(
                    &self.events,
                    CallEvent::Failed {
                        source: None,
                        message: error.to_string(),
                    },
                );
                result = Err(error);
            }
        }
        if result.is_ok() {
            emit(&self.events, CallEvent::Stopped);
        }
        self.shutdown_error = result.as_ref().err().cloned();
        result
    }
}
impl Drop for CallSession {
    fn drop(&mut self) {
        let _ = self.session_closed.send_replace(true);
        for source in ALL_SOURCES {
            self.media.set_enabled(source, false);
        }
        // Worker::drop 中取消和 abort，子进程的 kill_on_drop 是未 await stop 时的最后防线。
    }
}
fn validate_input(source: Source, input: &CaptureInput) -> Result<(), Error> {
    let matches = match input {
        CaptureInput::Microphone { .. }
        | CaptureInput::MacMicrophone { .. }
        | CaptureInput::WindowsMicrophone { .. } => source == Source::Microphone,
        CaptureInput::Camera { .. } | CaptureInput::WindowsCamera { .. } => {
            source == Source::Camera
        }
        CaptureInput::X11Screen { .. } | CaptureInput::WindowsScreen { .. } => {
            source == Source::Screen
        }
        // AVFoundation 的索引可表示摄像头或屏幕，调用者必须通过枚举确认来源。
        CaptureInput::MacVideo { .. } => source == Source::Camera || source == Source::Screen,
    };
    if matches {
        Ok(())
    } else {
        Err(Error::SourceMismatch)
    }
}
fn validate_encoded(source: Source, encoded: &Encoded) -> Result<(), Error> {
    match encoded {
        Encoded::Audio { data, duration }
            if source == Source::Microphone && *duration == Duration::from_millis(20) =>
        {
            validate_opus(data)
        }
        Encoded::Video { data, duration }
            if source != Source::Microphone
                && !duration.is_zero()
                && *duration <= Duration::from_secs(1) =>
        {
            video_dimensions(data).map(|_| ())
        }
        _ => Err(Error::SourceMismatch),
    }
}
struct CaptureControl {
    cancel: watch::Receiver<bool>,
    requests: watch::Receiver<u64>,
    closed: watch::Receiver<bool>,
    events: mpsc::Sender<CallEvent>,
    states: watch::Sender<CaptureState>,
}
fn capture_failed(
    states: &watch::Sender<CaptureState>,
    events: &mpsc::Sender<CallEvent>,
    source: Source,
    error: impl ToString,
) {
    let message = error.to_string();
    let status = states.borrow().status(source);
    capture_state_changed(states, source, status, Some(message.clone()));
    failed(events, source, message);
}
async fn stop_capture_process(
    capture: &mut Capture,
    source: Source,
    states: &watch::Sender<CaptureState>,
    events: &mpsc::Sender<CallEvent>,
) -> Result<(), Error> {
    match bounded(capture.stop(), IO_TIMEOUT).await {
        Ok(()) => {
            capture_state_changed(states, source, CaptureStatus::Stopped, None);
            emit(events, CallEvent::CaptureStopped(source));
            Ok(())
        }
        Err(error) => {
            let error = Error::Backend(format!("采集进程关闭未获确认：{error}"));
            capture_state_changed(
                states,
                source,
                CaptureStatus::Unconfirmed,
                Some(error.to_string()),
            );
            failed(events, source, &error);
            Err(error)
        }
    }
}
async fn capture_loop(
    mut capture: Capture,
    first: Encoded,
    source: Source,
    media: Arc<Media>,
    control: CaptureControl,
) -> Result<(), Error> {
    let CaptureControl {
        mut cancel,
        mut requests,
        mut closed,
        events,
        states,
    } = control;
    let mut next = Some(first);
    let mut keyframe_deadline: Option<Instant> = None;
    'capture: loop {
        let frame = if let Some(frame) = next.take() {
            frame
        } else {
            // PLI 到来不能取消 read_exact：否则会丢失已经读入的 IVF/Ogg 部分帧。
            // 固定同一个 next future，更新关键帧截止时间后继续读它。
            let pending = bounded(capture.next(), START_TIMEOUT);
            tokio::pin!(pending);
            loop {
                let deadline = keyframe_deadline.unwrap_or_else(|| Instant::now() + START_TIMEOUT);
                tokio::select! {
                    biased;
                    _ = cancelled(&mut cancel) => break 'capture,
                    _ = cancelled(&mut closed) => break 'capture,
                    request = requests.changed(), if source != Source::Microphone => {
                        if request.is_err() { break 'capture; }
                        requests.borrow_and_update();
                        keyframe_deadline.get_or_insert(Instant::now() + KEYFRAME_TIMEOUT);
                    }
                    _ = tokio::time::sleep_until(deadline), if keyframe_deadline.is_some() => {
                        capture_failed(&states, &events, source, "关键帧请求超时，请重新选择设备并启动");
                        break 'capture;
                    }
                    frame = &mut pending => match frame {
                        Ok(frame) => break frame,
                        Err(error) => { capture_failed(&states, &events, source, error); break 'capture; }
                    }
                }
            }
        };
        if *cancel.borrow() || *closed.borrow() {
            break;
        }
        if let Err(error) = validate_encoded(source, &frame) {
            capture_failed(&states, &events, source, error);
            break;
        }
        let (data, duration) = match frame {
            Encoded::Video { data, duration } | Encoded::Audio { data, duration } => {
                (data, duration)
            }
        };
        if let Some(deadline) = keyframe_deadline {
            if Instant::now() > deadline {
                capture_failed(
                    &states,
                    &events,
                    source,
                    "关键帧请求超时，请重新选择设备并启动",
                );
                break;
            }
            if data[0] & 1 != 0 {
                continue;
            }
            keyframe_deadline = None;
        }
        let sent = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            _ = cancelled(&mut closed) => break,
            result = bounded(media.send(source, data, duration), IO_TIMEOUT) => result,
        };
        if let Err(error) = sent {
            capture_failed(&states, &events, source, error);
            break;
        }
    }
    media.set_enabled(source, false);
    stop_capture_process(&mut capture, source, &states, &events).await
}

struct RemoteCommand {
    video: bool,
    enabled: bool,
    ack: oneshot::Sender<Result<(), Error>>,
}
struct Packet {
    epoch: u64,
    timestamp: u32,
    data: Bytes,
}
struct Consumer {
    sender: mpsc::Sender<Packet>,
    epoch: Arc<AtomicU64>,
    worker: Worker,
}
impl Consumer {
    fn submit(&self, timestamp: u32, data: Bytes) {
        let epoch = self.epoch.load(Ordering::SeqCst);
        if self
            .sender
            .try_send(Packet {
                epoch,
                timestamp,
                data,
            })
            .is_err()
        {
            // 队列中旧帧被 epoch 淘汰，不无界积压，也不把丢失参考帧后的 delta 当完整图像。
            self.epoch.fetch_add(1, Ordering::SeqCst);
        }
    }
    async fn stop(self) -> Result<(), Error> {
        self.worker.stop().await
    }
}
fn consumer(source: Source, sink: VideoSink, events: mpsc::Sender<CallEvent>) -> Consumer {
    let (sender, packets) = mpsc::channel(if source == Source::Microphone {
        AUDIO_QUEUE
    } else {
        VIDEO_QUEUE
    });
    let (cancel, cancel_rx) = watch::channel(false);
    let epoch = Arc::new(AtomicU64::new(0));
    let worker_epoch = epoch.clone();
    let task = tokio::spawn(async move {
        let result = if source == Source::Microphone {
            audio_loop(packets, cancel_rx, worker_epoch, events.clone()).await
        } else {
            video_loop(
                source,
                packets,
                cancel_rx,
                worker_epoch,
                sink,
                events.clone(),
            )
            .await
        };
        if let Err(error) = &result {
            failed(&events, source, error);
        }
        result
    });
    Consumer {
        sender,
        epoch,
        worker: Worker { cancel, task },
    }
}
/// 播放关闭成功可清除本次清理中的临时错误；真实失败保留到后续显式确认。
fn playback_state_changed(
    states: &watch::Sender<CaptureState>,
    source: Source,
    status: CaptureStatus,
    error: Option<String>,
) {
    states.send_modify(|state| {
        let at = index(source);
        state.statuses[at] = status;
        state.errors[at] = error;
        state.revisions[at] = state.revisions[at].wrapping_add(1);
    });
}
struct ReceiverState {
    states: watch::Sender<CaptureState>,
    consumers: [Option<Consumer>; 3],
    enabled: [bool; 3],
    // 关闭失败的consumer被take后，仍保留失败，不能下一次空关闭/重开就遗忘。
    shutdown_errors: [Option<String>; 3],
}
impl ReceiverState {
    #[cfg(test)]
    fn new() -> Self {
        Self::with_states(watch::channel(CaptureState::default()).0)
    }
    fn with_states(states: watch::Sender<CaptureState>) -> Self {
        Self {
            states,
            consumers: std::array::from_fn(|_| None),
            enabled: [false; 3],
            shutdown_errors: std::array::from_fn(|_| None),
        }
    }
    async fn close_source(
        &mut self,
        source: Source,
        events: &mpsc::Sender<CallEvent>,
    ) -> Result<(), Error> {
        let at = index(source);
        self.enabled[at] = false;
        if let Some(old) = self.consumers[at].take() {
            // 即使本次等待被取消，状态也不会变成“没有consumer所以已关闭”。
            self.shutdown_errors[at] = Some("接收媒体关闭尚未确认".into());
            playback_state_changed(
                &self.states,
                source,
                CaptureStatus::Unconfirmed,
                self.shutdown_errors[at].clone(),
            );
            match old.stop().await {
                Ok(()) => self.shutdown_errors[at] = None,
                Err(error) => {
                    self.shutdown_errors[at] = Some(error.to_string());
                    failed(events, source, &error);
                }
            }
        }
        match &self.shutdown_errors[at] {
            Some(error) => {
                playback_state_changed(
                    &self.states,
                    source,
                    CaptureStatus::Unconfirmed,
                    Some(error.clone()),
                );
                Err(Error::Backend(error.clone()))
            }
            None => {
                playback_state_changed(&self.states, source, CaptureStatus::Stopped, None);
                Ok(())
            }
        }
    }
    async fn close_group(
        &mut self,
        video: bool,
        events: &mpsc::Sender<CallEvent>,
    ) -> Result<(), Error> {
        let mut result = Ok(());
        for source in ALL_SOURCES {
            if (source != Source::Microphone) == video {
                if let Err(error) = self.close_source(source, events).await {
                    result = Err(error);
                }
            }
        }
        result
    }
    async fn configure(
        &mut self,
        video: bool,
        enabled: bool,
        cancel: &watch::Receiver<bool>,
        sink: &VideoSink,
        events: &mpsc::Sender<CallEvent>,
    ) -> Result<(), Error> {
        // 两阶段切换：全部旧consumer关闭成功前，一个新consumer都不能启动。
        self.close_group(video, events).await?;
        if *cancel.borrow() {
            return Err(Error::Stopped);
        }
        if enabled {
            for source in ALL_SOURCES {
                if (source != Source::Microphone) == video {
                    self.consumers[index(source)] =
                        Some(consumer(source, sink.clone(), events.clone()));
                    self.enabled[index(source)] = true;
                    playback_state_changed(&self.states, source, CaptureStatus::Running, None);
                }
            }
        }
        Ok(())
    }
    fn submit(&self, source: Source, timestamp: u32, data: Bytes) {
        if self.enabled[index(source)] {
            if let Some(consumer) = &self.consumers[index(source)] {
                consumer.submit(timestamp, data);
            }
        }
    }
    async fn shutdown(&mut self, events: &mpsc::Sender<CallEvent>) -> Result<(), Error> {
        let mut result = Ok(());
        for source in ALL_SOURCES {
            if let Err(error) = self.close_source(source, events).await {
                result = Err(error);
            }
        }
        result
    }
}
async fn receive_loop(
    mut incoming: mpsc::Receiver<Event>,
    mut commands: mpsc::Receiver<RemoteCommand>,
    mut cancel: watch::Receiver<bool>,
    keyframes: [watch::Sender<u64>; 3],
    sink: VideoSink,
    events: mpsc::Sender<CallEvent>,
    playback_states: watch::Sender<CaptureState>,
) -> Result<(), Error> {
    let mut state = ReceiverState::with_states(playback_states);
    loop {
        tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            command = commands.recv() => {
                let Some(command) = command else { break; };
                // 取消允许请求应不启动；取消停止请求仍执行停止，不能把停止意图吞掉。
                if command.enabled && command.ack.is_closed() { continue; }
                let result = state.configure(command.video, command.enabled, &cancel, &sink, &events).await;
                if command.enabled && command.ack.is_closed() {
                    // 控制future在等待旧consumer关闭时被取消，也不能留下迟到的新播放。
                    let _ = state.close_group(command.video, &events).await;
                    continue;
                }
                // 与ack发送原子地判断调用者还在等待。已取消的允许请求需要回滚。
                let applied = result.is_ok();
                let accepted = command.ack.send(result).is_ok();
                if !accepted && command.enabled {
                    let _ = state.close_group(command.video, &events).await;
                } else if applied {
                    emit(&events, if command.video { CallEvent::RemoteVideoEnabled(command.enabled) } else { CallEvent::RemoteAudioEnabled(command.enabled) });
                }
            }
            event = incoming.recv() => match event {
                None => break,
                Some(Event::KeyframeRequested(source)) => { keyframes[index(source)].send_modify(|n| *n = n.wrapping_add(1)); }
                Some(Event::Ended(source)) => {
                    let _ = state.close_source(source, &events).await;
                    emit(&events, CallEvent::RemoteEnded(source));
                }
                Some(Event::Frame { source, timestamp, data }) => state.submit(source, timestamp, data),
            }
        }
    }
    state.shutdown(&events).await
}

/// 只接受可显示的 VP8 帧。关键帧携带实际尺寸；每次尺寸变化都重建解码器。
fn video_dimensions(data: &[u8]) -> Result<Option<(u16, u16)>, Error> {
    if data.len() < 3 || data.len() > MAX_VIDEO_FRAME || data[0] & 0x10 == 0 {
        return Err(Error::Invalid);
    }
    if data[0] & 1 != 0 {
        return Ok(None);
    }
    if data.len() < 10 || &data[3..6] != b"\x9d\x01\x2a" {
        return Err(Error::Invalid);
    }
    let raw_width = u16::from_le_bytes([data[6], data[7]]);
    let raw_height = u16::from_le_bytes([data[8], data[9]]);
    if raw_width & 0xc000 != 0
        || raw_height & 0xc000 != 0
        || raw_width == 0
        || raw_height == 0
        || raw_width > 1920
        || raw_height > 1080
    {
        return Err(Error::Invalid);
    }
    Ok(Some((raw_width, raw_height)))
}
fn is_newer(timestamp: u32, previous: u32) -> bool {
    (timestamp.wrapping_sub(previous) as i32) > 0
}
async fn clear_decoder(decoder: &mut Option<VideoDecoder>) -> Result<(), Error> {
    if let Some(mut decoder) = decoder.take() {
        bounded(decoder.stop(), IO_TIMEOUT).await?;
    }
    Ok(())
}
async fn video_loop(
    source: Source,
    mut packets: mpsc::Receiver<Packet>,
    mut cancel: watch::Receiver<bool>,
    epoch: Arc<AtomicU64>,
    sink: VideoSink,
    events: mpsc::Sender<CallEvent>,
) -> Result<(), Error> {
    let mut decoder = None;
    let mut dimensions = (0, 0);
    let mut current_epoch = 0;
    let mut last_timestamp = None;
    let mut presented = false;
    loop {
        let packet = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            packet = timeout(Duration::from_secs(5), packets.recv()) => match packet {
                Ok(Some(packet)) => packet,
                Ok(None) => break,
                Err(_) => { clear_decoder(&mut decoder).await?; last_timestamp = None; continue; }
            }
        };
        let latest_epoch = epoch.load(Ordering::SeqCst);
        if current_epoch != latest_epoch {
            clear_decoder(&mut decoder).await?;
            current_epoch = latest_epoch;
            last_timestamp = None;
        }
        if packet.epoch != current_epoch {
            continue;
        }
        if last_timestamp.is_some_and(|last| !is_newer(packet.timestamp, last)) {
            continue;
        }
        let frame_dimensions = match video_dimensions(&packet.data) {
            Ok(dimensions) => dimensions,
            Err(error) => {
                failed(&events, source, error);
                clear_decoder(&mut decoder).await?;
                continue;
            }
        };
        if let Some(new_dimensions) = frame_dimensions {
            if decoder.is_none() || dimensions != new_dimensions {
                clear_decoder(&mut decoder).await?;
                dimensions = new_dimensions;
                let created = tokio::select! {
                    biased;
                    _ = cancelled(&mut cancel) => break,
                    created = bounded(VideoDecoder::new(VideoConfig { width: dimensions.0, height: dimensions.1, fps: 30 }), IO_TIMEOUT) => created,
                };
                match created {
                    Ok(new) => decoder = Some(new),
                    Err(error) => {
                        failed(&events, source, error);
                        break;
                    }
                }
            }
        }
        let Some(active) = decoder.as_mut() else {
            continue;
        };
        let decoded = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            decoded = bounded(active.decode_rgba(&packet.data), IO_TIMEOUT) => decoded,
        };
        let pixels = match decoded {
            Ok(pixels) => pixels,
            Err(error) => {
                failed(&events, source, error);
                clear_decoder(&mut decoder).await?;
                continue;
            }
        };
        last_timestamp = Some(packet.timestamp);
        if epoch.load(Ordering::SeqCst) != current_epoch || *cancel.borrow() {
            continue;
        }
        let result = catch_unwind(AssertUnwindSafe(|| {
            sink(source, dimensions.0, dimensions.1, pixels)
        }));
        match result {
            Ok(Ok(())) => {
                if !presented {
                    emit(&events, CallEvent::VideoPresented(source));
                    presented = true;
                }
            }
            Ok(Err(error)) => {
                failed(&events, source, error);
                break;
            }
            Err(_) => {
                failed(&events, source, "原生视频 sink 异常");
                break;
            }
        }
    }
    clear_decoder(&mut decoder).await
}
/// 本桥接只支持一个 RTP 包恰好20ms的 Opus，不猜测不同 packetization。
fn validate_opus(data: &[u8]) -> Result<(), Error> {
    if data.is_empty() || data.len() > 1275 {
        return Err(Error::Invalid);
    }
    let config = data[0] >> 3;
    let samples_per_frame: u32 = if config >= 16 {
        120 << (config & 3)
    } else if config >= 12 {
        480 << (config & 1)
    } else {
        [480, 960, 1920, 2880][usize::from(config & 3)]
    };
    let count = match data[0] & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => u32::from(*data.get(1).ok_or(Error::Invalid)? & 0x3f),
    };
    if samples_per_frame * count == 960 {
        Ok(())
    } else {
        Err(Error::Invalid)
    }
}
async fn clear_player(player: &mut Option<AudioPlayer>) -> Result<(), Error> {
    if let Some(mut player) = player.take() {
        bounded(player.stop(), IO_TIMEOUT).await?;
    }
    Ok(())
}
async fn audio_loop(
    mut packets: mpsc::Receiver<Packet>,
    mut cancel: watch::Receiver<bool>,
    epoch: Arc<AtomicU64>,
    events: mpsc::Sender<CallEvent>,
) -> Result<(), Error> {
    let mut player = None;
    let mut current_epoch = 0;
    let mut last_timestamp = None;
    loop {
        let packet = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            packet = timeout(Duration::from_secs(2), packets.recv()) => match packet {
                Ok(Some(packet)) => packet,
                Ok(None) => break,
                Err(_) => { clear_player(&mut player).await?; last_timestamp = None; continue; }
            }
        };
        let latest_epoch = epoch.load(Ordering::SeqCst);
        if current_epoch != latest_epoch {
            clear_player(&mut player).await?;
            current_epoch = latest_epoch;
            last_timestamp = None;
        }
        if packet.epoch != current_epoch {
            continue;
        }
        if let Some(last) = last_timestamp {
            if !is_newer(packet.timestamp, last) {
                continue;
            }
            if packet.timestamp.wrapping_sub(last) != 960 {
                clear_player(&mut player).await?;
            }
        }
        if let Err(error) = validate_opus(&packet.data) {
            failed(&events, Source::Microphone, error);
            continue;
        }
        // 无论是首次启动还是丢包后的重建，都先检查当前明确开启的生命周期。
        if *cancel.borrow() {
            break;
        }
        if player.is_none() {
            let created = tokio::select! {
                biased;
                _ = cancelled(&mut cancel) => break,
                created = bounded(AudioPlayer::new(), IO_TIMEOUT) => created,
            };
            match created {
                Ok(new) => player = Some(new),
                Err(error) => {
                    failed(&events, Source::Microphone, error);
                    break;
                }
            }
        }
        let written = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            written = bounded(player.as_mut().expect("player created").write_opus_20ms(&packet.data), IO_TIMEOUT) => written,
        };
        if let Err(error) = written {
            failed(&events, Source::Microphone, error);
            break;
        }
        last_timestamp = Some(packet.timestamp);
    }
    clear_player(&mut player).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn keyframe(width: u16, height: u16) -> Vec<u8> {
        let mut data = vec![0x10, 0, 0, 0x9d, 0x01, 0x2a];
        data.extend(width.to_le_bytes());
        data.extend(height.to_le_bytes());
        data
    }
    #[test]
    fn vp8_dimensions_and_bounds_are_validated() {
        assert_eq!(
            video_dimensions(&keyframe(1920, 1080)).unwrap(),
            Some((1920, 1080))
        );
        for (w, h) in [(0, 1), (1, 0), (1921, 1080), (1920, 1081), (0xc040, 48)] {
            assert!(video_dimensions(&keyframe(w, h)).is_err());
        }
        assert!(video_dimensions(&[0x10, 0, 0]).is_err());
        assert!(video_dimensions(&[1, 0, 0]).is_err());
        assert_eq!(video_dimensions(&[0x11, 0, 0]).unwrap(), None);
    }
    #[test]
    fn input_source_is_not_remote_controlled() {
        let mic = CaptureInput::Microphone {
            source: "explicit-user-selection".into(),
        };
        assert!(validate_input(Source::Microphone, &mic).is_ok());
        assert!(validate_input(Source::Screen, &mic).is_err());
        let screen = CaptureInput::WindowsScreen {
            x: -100,
            y: 0,
            video: VideoConfig {
                width: 64,
                height: 48,
                fps: 10,
            },
        };
        assert!(validate_input(Source::Screen, &screen).is_ok());
        assert!(validate_input(Source::Camera, &screen).is_err());
    }
    #[test]
    fn opus_duration_and_timestamp_wrap() {
        assert!(validate_opus(&[0xf8, 0xff, 0xfe]).is_ok());
        assert!(validate_opus(&[0xf0]).is_err());
        assert!(validate_opus(&[0xff]).is_err());
        assert!(validate_opus(&[0xff, 0]).is_err());
        assert!(validate_opus(&[]).is_err());
        assert!(is_newer(4, u32::MAX - 3));
        assert!(!is_newer(5, 6));
        assert!(!is_newer(5, 5));
    }
    #[tokio::test]
    async fn overflow_invalidates_old_packets_and_cancel_is_joined() {
        let (tx, mut rx) = mpsc::channel(1);
        let (cancel, cancel_rx) = watch::channel(false);
        let finished = Arc::new(AtomicU64::new(0));
        let done = finished.clone();
        let worker = Worker {
            cancel,
            task: tokio::spawn(async move {
                let mut cancel = cancel_rx;
                cancelled(&mut cancel).await;
                done.store(1, Ordering::SeqCst);
                Ok(())
            }),
        };
        let consumer = Consumer {
            sender: tx,
            epoch: Arc::new(AtomicU64::new(0)),
            worker,
        };
        consumer.submit(1, Bytes::from_static(b"a"));
        consumer.submit(2, Bytes::from_static(b"b"));
        assert_eq!(consumer.epoch.load(Ordering::SeqCst), 1);
        assert_eq!(rx.recv().await.unwrap().epoch, 0);
        consumer.stop().await.unwrap();
        assert_eq!(finished.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn defaults_and_drop_disable_all_tracks() {
        use surreal_ck_peer_transport::Route;
        let (chat, _chat_events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (session, _events) = CallSession::attach(&chat, Arc::new(|_, _, _, _| Ok(())))
            .await
            .unwrap();
        let media = session.media.clone();
        for source in ALL_SOURCES {
            assert!(media
                .send(
                    source,
                    Bytes::from_static(&[0xf8, 0xff, 0xfe]),
                    Duration::from_millis(20)
                )
                .await
                .is_err());
            // 仅测试手动模拟已启用轨，drop 必须立即将它复原。
            media.set_enabled(source, true);
        }
        drop(session);
        for source in ALL_SOURCES {
            assert!(media
                .send(
                    source,
                    Bytes::from_static(&[0xf8, 0xff, 0xfe]),
                    Duration::from_millis(20)
                )
                .await
                .is_err());
        }
        chat.close().await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_is_latched_before_a_worker_subscribes() {
        let (cancel, receiver) = watch::channel(false);
        drop(receiver);
        cancel.send_replace(true);
        let mut receiver = cancel.subscribe();
        timeout(Duration::from_millis(10), cancelled(&mut receiver))
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn failed_shutdown_never_emits_a_confirmed_stopped_event() {
        use surreal_ck_peer_transport::Route;
        let (chat, _chat_events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (mut session, mut events) = CallSession::attach(&chat, Arc::new(|_, _, _, _| Ok(())))
            .await
            .unwrap();
        session.captures[index(Source::Camera)] = Some(Worker {
            cancel: watch::channel(false).0,
            task: tokio::spawn(async { Err(Error::Backend("测试：关闭未获确认".into())) }),
        });
        assert!(session.stop().await.is_err());
        assert!(session.stop().await.is_err());
        let mut failure = false;
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(
                event,
                CallEvent::Stopped | CallEvent::CaptureStopped(Source::Camera)
            ));
            failure |= matches!(event, CallEvent::Failed { .. });
        }
        assert!(failure);
        chat.close().await.unwrap();
    }
    #[tokio::test]
    async fn full_event_queue_cannot_lose_capture_privacy_or_hide_unknown_shutdown() {
        use surreal_ck_peer_transport::Route;
        let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (mut session, _full_events) = CallSession::attach(&chat, Arc::new(|_, _, _, _| Ok(())))
            .await
            .unwrap();
        for _ in 0..32 {
            emit(&session.events, CallEvent::VideoPresented(Source::Camera));
        }
        let mut snapshot = session.capture_state();
        capture_state_changed(
            &session.capture_states,
            Source::Camera,
            CaptureStatus::Running,
            None,
        );
        snapshot.changed().await.unwrap();
        assert_eq!(
            snapshot.borrow_and_update().status(Source::Camera),
            CaptureStatus::Running
        );
        // 模拟真实关闭确认失败，独立快照必须保存它，即使普通队列一直无人读取。
        session.captures[index(Source::Camera)] = Some(Worker {
            cancel: watch::channel(false).0,
            task: tokio::spawn(async { Err(Error::Backend("测试关闭未获确认".into())) }),
        });
        assert!(session.stop_capture(Source::Camera).await.is_err());
        assert!(session.capture_active(Source::Camera));
        assert_eq!(
            snapshot.borrow().status(Source::Camera),
            CaptureStatus::Unconfirmed
        );
        assert!(snapshot.borrow().error(Source::Camera).is_some());
        assert!(session.stop_capture(Source::Camera).await.is_err());
        assert!(timeout(Duration::from_secs(1), session.stop())
            .await
            .unwrap()
            .is_err());
        chat.close().await.unwrap();
    }
    #[tokio::test]
    async fn empty_stop_confirms_only_when_no_unknown_capture_exists() {
        use surreal_ck_peer_transport::Route;
        let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (mut session, _events) = CallSession::attach(&chat, Arc::new(|_, _, _, _| Ok(())))
            .await
            .unwrap();
        let mut states = session.capture_state();
        session.stop_capture(Source::Camera).await.unwrap();
        states.changed().await.unwrap();
        assert_eq!(
            states.borrow().status(Source::Camera),
            CaptureStatus::Stopped
        );
        session.stop().await.unwrap();
        chat.close().await.unwrap();
    }
    // 只注入一个等待清理的任务，不打开设备；精确模拟调用future被取消时的所有权转移。
    async fn session_with_stalled_capture() -> (Chat, CallSession, oneshot::Receiver<()>) {
        use surreal_ck_peer_transport::Route;
        let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (mut session, _events) = CallSession::attach(&chat, Arc::new(|_, _, _, _| Ok(())))
            .await
            .unwrap();
        let (cancel, mut cancelled_rx) = watch::channel(false);
        let (entered, entered_rx) = oneshot::channel();
        session.captures[index(Source::Camera)] = Some(Worker {
            cancel,
            task: tokio::spawn(async move {
                cancelled(&mut cancelled_rx).await;
                let _ = entered.send(());
                std::future::pending::<Result<(), Error>>().await
            }),
        });
        capture_state_changed(
            &session.capture_states,
            Source::Camera,
            CaptureStatus::Running,
            None,
        );
        (chat, session, entered_rx)
    }
    #[tokio::test]
    async fn cancelling_source_stop_cannot_turn_the_next_empty_stop_into_confirmation() {
        let (chat, mut session, entered) = session_with_stalled_capture().await;
        {
            let operation = session.stop_capture(Source::Camera);
            tokio::pin!(operation);
            tokio::select! {
                _ = entered => {},
                result = &mut operation => panic!("cleanup unexpectedly completed: {result:?}"),
            }
            // 现在drop这个控制future，Worker已经被take但并未确认子进程退出。
        }
        assert_eq!(
            session.capture_state().borrow().status(Source::Camera),
            CaptureStatus::Unconfirmed
        );
        assert!(session.stop_capture(Source::Camera).await.is_err());
        assert!(session.stop().await.is_err());
        chat.close().await.unwrap();
    }
    #[tokio::test]
    async fn cancelling_whole_stop_never_caches_a_successful_shutdown() {
        let (chat, mut session, entered) = session_with_stalled_capture().await;
        {
            let operation = session.stop();
            tokio::pin!(operation);
            tokio::select! {
                _ = entered => {},
                result = &mut operation => panic!("cleanup unexpectedly completed: {result:?}"),
            }
        }
        assert!(
            session.stop().await.is_err(),
            "取消的stop不能把初始None误当成功"
        );
        assert!(session.capture_active(Source::Camera));
        chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn cancelling_queued_playback_control_cannot_enable_later() {
        use surreal_ck_peer_transport::Route;
        let (chat, _chat_events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (mut session, mut events) = CallSession::attach(&chat, Arc::new(|_, _, _, _| Ok(())))
            .await
            .unwrap();
        let (ack, done) = oneshot::channel();
        session
            .remote
            .send(RemoteCommand {
                video: false,
                enabled: true,
                ack,
            })
            .await
            .unwrap();
        drop(done); // 请求future取消，actor尚未取得这个命令。
        tokio::time::sleep(Duration::from_millis(10)).await;
        while let Ok(event) = events.try_recv() {
            assert!(
                !matches!(event, CallEvent::RemoteAudioEnabled(true)),
                "已取消的请求不能迟到开启播放"
            );
        }
        session.stop().await.unwrap();
        chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn cancelling_startup_guard_preserves_unknown_cleanup() {
        use surreal_ck_peer_transport::Route;
        let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (mut session, _events) = CallSession::attach(&chat, Arc::new(|_, _, _, _| Ok(())))
            .await
            .unwrap();
        {
            // 与Capture::start成功之后等待首包的future使用同一守卫；不创建真实设备。
            let _operation = CaptureOperation::new(
                &session.capture_states,
                Source::Camera,
                "测试启动被取消，关闭未确认",
            );
        }
        assert_eq!(
            session.capture_state().borrow().status(Source::Camera),
            CaptureStatus::Unconfirmed
        );
        assert!(session.stop_capture(Source::Camera).await.is_err());
        assert!(session.stop().await.is_err());
        chat.close().await.unwrap();
    }
    fn cleanup_fixture(result: Result<(), Error>) -> Consumer {
        let (sender, _packets) = mpsc::channel(1);
        Consumer {
            sender,
            epoch: Arc::new(AtomicU64::new(0)),
            worker: Worker {
                cancel: watch::channel(false).0,
                task: tokio::spawn(async move { result }),
            },
        }
    }
    #[tokio::test]
    async fn playback_watch_waits_for_consumer_release_and_replays_real_final_state() {
        let mut state = ReceiverState::new();
        let snapshot = state.states.subscribe();
        let (events, _events) = mpsc::channel(32);
        let (cancel, mut cancel_rx) = watch::channel(false);
        let (entered, entered_rx) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let (sender, _packets) = mpsc::channel(1);
        state.consumers[index(Source::Microphone)] = Some(Consumer {
            sender,
            epoch: Arc::new(AtomicU64::new(0)),
            worker: Worker {
                cancel,
                task: tokio::spawn(async move {
                    cancelled(&mut cancel_rx).await;
                    let _ = entered.send(());
                    let _ = released.await;
                    Ok(())
                }),
            },
        });
        {
            let closing = state.close_source(Source::Microphone, &events);
            tokio::pin!(closing);
            tokio::select! {
                _ = entered_rx => {},
                result = &mut closing => panic!("关闭不应先于真实release完成：{result:?}"),
            }
            assert_eq!(
                snapshot.borrow().status(Source::Microphone),
                CaptureStatus::Unconfirmed
            );
            let _ = release.send(());
            closing.await.unwrap();
        }
        let replay = snapshot.clone();
        assert_eq!(
            replay.borrow().status(Source::Microphone),
            CaptureStatus::Stopped
        );
        assert!(replay.borrow().error(Source::Microphone).is_none());
        assert!(replay.borrow().revision(Source::Microphone) >= 2);
    }

    #[tokio::test]
    async fn failed_playback_release_stays_unknown_after_consumer_is_taken() {
        let mut state = ReceiverState::new();
        let snapshot = state.states.subscribe();
        let (events, _events) = mpsc::channel(32);
        state.consumers[index(Source::Camera)] = Some(cleanup_fixture(Err(Error::Backend(
            "decoder释放失败".into(),
        ))));
        assert!(state.close_source(Source::Camera, &events).await.is_err());
        assert!(state.consumers[index(Source::Camera)].is_none());
        assert_eq!(
            snapshot.borrow().status(Source::Camera),
            CaptureStatus::Unconfirmed
        );
        assert!(state.close_source(Source::Camera, &events).await.is_err());
        assert_eq!(
            snapshot.borrow().status(Source::Camera),
            CaptureStatus::Unconfirmed
        );
        assert!(snapshot.borrow().error(Source::Camera).is_some());
    }

    #[tokio::test]
    async fn playback_watch_survives_chat_close_without_inventing_capture_results() {
        use surreal_ck_peer_transport::Route;
        let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (mut session, _events) = CallSession::attach(&chat, Arc::new(|_, _, _, _| Ok(())))
            .await
            .unwrap();
        let playback = session.playback_state();
        session.set_remote_audio_enabled(true).await.unwrap();
        session.set_remote_video_enabled(true).await.unwrap();
        for source in ALL_SOURCES {
            assert_eq!(playback.borrow().status(source), CaptureStatus::Running);
            assert_eq!(
                session.capture_state().borrow().status(source),
                CaptureStatus::Stopped
            );
        }
        chat.close().await.unwrap();
        session.stop().await.unwrap();
        for source in ALL_SOURCES {
            assert_eq!(playback.borrow().status(source), CaptureStatus::Stopped);
            assert!(playback.borrow().error(source).is_none());
        }
    }

    #[tokio::test]
    async fn remote_shutdown_failure_is_latched_and_blocks_restart_and_final_success() {
        let mut state = ReceiverState::new();
        let (events, _received) = mpsc::channel(32);
        let (_cancel, cancel) = watch::channel(false);
        let sink: VideoSink = Arc::new(|_, _, _, _| Ok(()));
        state.consumers[index(Source::Microphone)] = Some(cleanup_fixture(Err(Error::Backend(
            "测试播放器退出未确认".into(),
        ))));
        assert!(state
            .configure(false, false, &cancel, &sink, &events)
            .await
            .is_err());
        assert!(state
            .configure(false, true, &cancel, &sink, &events)
            .await
            .is_err());
        assert!(state.consumers[index(Source::Microphone)].is_none());
        assert!(!state.enabled[index(Source::Microphone)]);
        assert!(state.shutdown(&events).await.is_err());
    }
    #[tokio::test]
    async fn failed_screen_cleanup_cannot_partially_enable_camera() {
        let mut state = ReceiverState::new();
        let (events, _received) = mpsc::channel(32);
        let (_cancel, cancel) = watch::channel(false);
        let sink: VideoSink = Arc::new(|_, _, _, _| Ok(()));
        state.consumers[index(Source::Camera)] = Some(cleanup_fixture(Ok(())));
        state.consumers[index(Source::Screen)] = Some(cleanup_fixture(Err(Error::Backend(
            "测试屏幕decoder退出未确认".into(),
        ))));
        assert!(state
            .configure(true, true, &cancel, &sink, &events)
            .await
            .is_err());
        assert!(state.consumers[index(Source::Camera)].is_none());
        assert!(state.consumers[index(Source::Screen)].is_none());
        assert_eq!(state.enabled, [false; 3]);
        assert!(state.shutdown(&events).await.is_err());
    }
    #[tokio::test]
    async fn cancelled_session_rejects_playback_rebuild_before_creating_consumers() {
        let mut state = ReceiverState::new();
        let (events, _received) = mpsc::channel(32);
        let (_cancel, cancel) = watch::channel(true);
        let sink: VideoSink = Arc::new(|_, _, _, _| Ok(()));
        assert!(matches!(
            state.configure(false, true, &cancel, &sink, &events).await,
            Err(Error::Stopped)
        ));
        assert!(matches!(
            state.configure(true, true, &cancel, &sink, &events).await,
            Err(Error::Stopped)
        ));
        assert!(state.consumers.iter().all(Option::is_none));
        assert_eq!(state.enabled, [false; 3]);
        state.shutdown(&events).await.unwrap();
    }
    #[tokio::test]
    async fn cancelled_playback_stop_still_stops_instead_of_discarding_stop_intent() {
        use surreal_ck_peer_transport::Route;
        let (chat, _chat_events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (mut session, mut events) = CallSession::attach(&chat, Arc::new(|_, _, _, _| Ok(())))
            .await
            .unwrap();
        session.set_remote_audio_enabled(true).await.unwrap();
        while events.try_recv().is_ok() {}
        let (ack, done) = oneshot::channel();
        session
            .remote
            .send(RemoteCommand {
                video: false,
                enabled: false,
                ack,
            })
            .await
            .unwrap();
        drop(done);
        let stopped = timeout(Duration::from_secs(1), async {
            loop {
                if matches!(
                    events.recv().await,
                    Some(CallEvent::RemoteAudioEnabled(false))
                ) {
                    break;
                }
            }
        })
        .await;
        assert!(stopped.is_ok(), "取消停止future仍必须执行已发出的停止请求");
        session.stop().await.unwrap();
        chat.close().await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_during_old_player_cleanup_prevents_new_player_creation() {
        let mut state = ReceiverState::new();
        let (events, _events) = mpsc::channel(32);
        let (session_cancel, cancel) = watch::channel(false);
        let sink: VideoSink = Arc::new(|_, _, _, _| Ok(()));
        let (worker_cancel, mut worker_cancelled) = watch::channel(false);
        let (entered, entered_rx) = oneshot::channel();
        let (release, release_rx) = oneshot::channel();
        let (sender, _packets) = mpsc::channel(1);
        state.consumers[index(Source::Microphone)] = Some(Consumer {
            sender,
            epoch: Arc::new(AtomicU64::new(0)),
            worker: Worker {
                cancel: worker_cancel,
                task: tokio::spawn(async move {
                    cancelled(&mut worker_cancelled).await;
                    let _ = entered.send(());
                    let _ = release_rx.await;
                    Ok(())
                }),
            },
        });
        {
            let rebuilding = state.configure(false, true, &cancel, &sink, &events);
            tokio::pin!(rebuilding);
            tokio::select! {
                _ = entered_rx => {},
                result = &mut rebuilding => panic!("旧播放器应仍等待清理：{result:?}"),
            }
            session_cancel.send_replace(true);
            let _ = release.send(());
            assert!(matches!(rebuilding.await, Err(Error::Stopped)));
        }
        assert!(state.consumers[index(Source::Microphone)].is_none());
        assert!(!state.enabled[index(Source::Microphone)]);
        state.shutdown(&events).await.unwrap();
    }
}
