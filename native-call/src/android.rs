//! Android 独立通话适配；所有权限、采集和播放开关均由原生 Activity 显式操作。
pub use host::CaptureStatus;
use std::{sync::Arc, time::Duration};
use surreal_ck_native_media_platform::android as host;
pub use surreal_ck_peer_transport::media::Source;
use surreal_ck_peer_transport::{
    chat::{Chat, TerminationObserver},
    media::{Event, Media},
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{timeout, Instant},
};

const SOURCES: [Source; 3] = [Source::Microphone, Source::Camera, Source::Screen];
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

/// running 只来自宿主真实设备状态；closed 只来自真实释放后的 Closed。
#[derive(Clone, Debug)]
pub struct AndroidCallState {
    pub running: [bool; 3],
    pub statuses: [CaptureStatus; 3],
    pub revisions: [u64; 3],
    pub closed: bool,
    pub stopping: bool,
    pub error: Option<String>,
    /// 有界接收队列拒绝的帧数，不代表已渲染或已播放。
    pub dropped_frames: u64,
}

impl Default for AndroidCallState {
    fn default() -> Self {
        Self {
            running: [false; 3],
            statuses: [CaptureStatus::Stopped; 3],
            revisions: [0; 3],
            closed: false,
            stopping: false,
            error: None,
            dropped_frames: 0,
        }
    }
}
fn sync_snapshot(session: u64, states: &watch::Sender<AndroidCallState>) -> Result<bool, String> {
    let snapshot = host::snapshot(session)?;
    let closed = snapshot.closed
        && snapshot
            .states
            .iter()
            .all(|s| matches!(s, CaptureStatus::Stopped));
    states.send_if_modified(|state| {
        // 宿主错误独立于有界帧事件队列。关闭确认不能清除已展示的故障。
        let error = snapshot.error.clone().or_else(|| state.error.clone());
        if state.revisions == snapshot.revisions
            && state.closed == closed
            && state.statuses == snapshot.states
            && state.error == error
        {
            return false;
        }
        state.error = error;
        state.statuses = snapshot.states;
        state.revisions = snapshot.revisions;
        state.running = snapshot.states.map(|s| matches!(s, CaptureStatus::Running));
        state.closed = closed;
        if closed {
            state.stopping = false;
        }
        true
    });
    Ok(closed)
}

/// 发送循环必须观察权威错误；关闭轮询仍应继续等待实际资源释放。
fn sync_capture_snapshot(
    session: u64,
    states: &watch::Sender<AndroidCallState>,
) -> Result<bool, String> {
    let closed = sync_snapshot(session, states)?;
    if let Some(error) = &states.borrow().error {
        return Err(error.clone());
    }
    Ok(closed)
}

pub struct AndroidCall {
    session: u64,
    media: Arc<Media>,
    cancel: watch::Sender<bool>,
    states: watch::Receiver<AndroidCallState>,
    worker: Option<JoinHandle<Result<(), String>>>,
}
impl AndroidCall {
    /// 必须在 SDP 前调用。只附加静音轨，不请求权限、不启动采集、不播放。
    pub async fn attach(chat: &Chat) -> Result<(Self, watch::Receiver<AndroidCallState>), String> {
        let peer = chat.peer().connection();
        let termination = chat.termination_observer();
        if peer.local_description().await.is_some()
            || peer.remote_description().await.is_some()
            || !peer.get_senders().await.is_empty()
        {
            return Err("Android 媒体必须在 SDP 之前且只附加一次".into());
        }
        let session = host::begin()?;
        let mut startup = StartupGuard {
            session,
            armed: true,
        };
        let (media, incoming) = match Media::attach(chat.peer()).await {
            Ok(value) => value,
            Err(error) => {
                let cleanup = host::stop(session).err();
                return Err(format!("附加媒体失败：{error}；宿主关闭结果：{cleanup:?}"));
            }
        };
        let media = Arc::new(media);
        let (cancel, cancel_rx) = watch::channel(false);
        let (states, state_rx) = watch::channel(AndroidCallState::default());
        let worker_media = media.clone();
        let worker = tokio::spawn(async move {
            // 即使任务 panic，释放保护也会立即禁轨并请求宿主停止。
            let _guard = HostGuard {
                session,
                media: worker_media.clone(),
            };
            let result = pump(
                session,
                &worker_media,
                incoming,
                cancel_rx,
                &states,
                peer,
                termination,
            )
            .await;
            if let Err(error) = &result {
                states.send_modify(|state| {
                    state.error = Some(error.clone());
                    if !state.closed {
                        state.stopping = true;
                        for at in 0..3 {
                            if state.statuses[at] != CaptureStatus::Stopped {
                                state.statuses[at] = CaptureStatus::Unconfirmed;
                                state.revisions[at] = state.revisions[at].wrapping_add(1);
                            }
                        }
                    }
                });
            }
            result
        });
        startup.armed = false;
        Ok((
            Self {
                session,
                media,
                cancel,
                states: state_rx.clone(),
                worker: Some(worker),
            },
            state_rx,
        ))
    }
    /// 仅从用户点击事件调用，打开原生权限和媒体控制界面。
    pub fn show_controls(&self) -> Result<(), String> {
        if *self.cancel.borrow() || self.states.borrow().closed || self.states.borrow().stopping {
            return Err("Android 通话已停止或正在关闭".into());
        }
        host::show(self.session)
    }
    /// 禁用发送后请求实际关闭，只有宿主 Closed 才返回成功。
    pub async fn stop(&mut self) -> Result<(), String> {
        disable(&self.media);
        self.cancel.send_replace(true);
        if let Some(mut worker) = self.worker.take() {
            match timeout(STOP_TIMEOUT + Duration::from_secs(2), &mut worker).await {
                Ok(result) => result.map_err(|e| format!("Android 通话任务异常：{e}"))?,
                Err(_) => {
                    worker.abort();
                    let _ = host::stop(self.session);
                    Err("Android 关闭超时，设备释放未确认".into())
                }
            }
        } else if self.states.borrow().closed {
            Ok(())
        } else {
            Err("Android 设备释放未确认".into())
        }
    }
}
impl Drop for AndroidCall {
    fn drop(&mut self) {
        disable(&self.media);
        self.cancel.send_replace(true);
        // JoinHandle 脱离后仍完成有界关闭确认；不能 abort 后假报设备已释放。
        if !self.states.borrow().closed {
            let _ = host::stop(self.session);
        }
    }
}
struct StartupGuard {
    session: u64,
    armed: bool,
}
impl Drop for StartupGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = host::stop(self.session);
        }
    }
}
struct HostGuard {
    session: u64,
    media: Arc<Media>,
}
impl Drop for HostGuard {
    fn drop(&mut self) {
        disable(&self.media);
        let _ = host::stop(self.session);
    }
}
fn disable(media: &Media) {
    for source in SOURCES {
        media.set_enabled(source, false);
    }
}
fn index(source: Source) -> usize {
    match source {
        Source::Microphone => 0,
        Source::Camera => 1,
        Source::Screen => 2,
    }
}
fn from_host(source: host::Source) -> Source {
    match source {
        host::Source::Microphone => Source::Microphone,
        host::Source::Camera => Source::Camera,
        host::Source::Screen => Source::Screen,
    }
}
fn to_host(source: Source) -> host::Source {
    match source {
        Source::Microphone => host::Source::Microphone,
        Source::Camera => host::Source::Camera,
        Source::Screen => host::Source::Screen,
    }
}

type PeerConnection = surreal_ck_peer_transport::webrtc::peer_connection::RTCPeerConnection;
async fn pump(
    session: u64,
    media: &Media,
    mut incoming: mpsc::Receiver<Event>,
    mut cancel: watch::Receiver<bool>,
    states: &watch::Sender<AndroidCallState>,
    peer: Arc<PeerConnection>,
    termination: TerminationObserver,
) -> Result<(), String> {
    let mut enabled = [false; 3];
    let mut revisions = [0; 3];
    let mut pending: [Option<(u64, bytes::Bytes)>; 3] = std::array::from_fn(|_| None);
    let mut need_keyframe = [true; 3];
    let mut clocks: [RtpClock; 3] = std::array::from_fn(|_| RtpClock::default());
    let mut ticker = tokio::time::interval(Duration::from_millis(10));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let result: Result<(), String> = async {
        loop {
            tokio::select! {
                biased;
                _ = cancel.changed() => return Ok(()),
                _ = ticker.tick() => {
                    use surreal_ck_peer_transport::webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState as PcState;
                    if termination.is_terminated() || matches!(peer.connection_state(), PcState::Disconnected | PcState::Failed | PcState::Closed) {
                        return Err("WebRTC 已断开，Android 采集正在关闭".into());
                    }
                    if sync_capture_snapshot(session, states)? { return Ok(()); }
                    let current = states.borrow().clone();
                    if current.statuses.contains(&CaptureStatus::Unconfirmed) {
                        return Err("Android 设备状态未确认，正在停止通话".into());
                    }
                    for source in SOURCES {
                        let at = index(source);
                        if revisions[at] != current.revisions[at] || enabled[at] != current.running[at] {
                            revisions[at] = current.revisions[at];
                            enabled[at] = current.running[at];
                            pending[at] = None;
                            need_keyframe[at] = true;
                            media.set_enabled(source, enabled[at]);
                            if enabled[at] && source != Source::Microphone { host::request_keyframe(session, to_host(source))?; }
                        }
                    }
                    // 每轮限量，避免采集帧洪泛饿死取消或接收分支。
                    for _ in 0..16 {
                        match host::poll(session)? {
                            None => break,
                            Some(host::Event::Closed) => {
                                if sync_capture_snapshot(session, states)? { return Ok(()); }
                            }
                            Some(host::Event::Error { source, message }) => {
                                return Err(format!("Android {:?}：{message}", source.map(from_host)));
                            }
                            Some(host::Event::State { .. }) => {} // 权威快照优先，不能应用可能滞后的队列状态。
                            Some(host::Event::Frame { source, timestamp_us, keyframe, data }) => {
                                let source = from_host(source);
                                let at = index(source);
                                if *cancel.borrow() { return Ok(()); }
                                if sync_capture_snapshot(session, states)? { return Ok(()); }
                                let current = states.borrow().clone();
                                if current.revisions[at] != revisions[at] {
                                    revisions[at] = current.revisions[at];
                                    enabled[at] = current.running[at];
                                    media.set_enabled(source, enabled[at]);
                                    pending[at] = None;
                                    need_keyframe[at] = true;
                                    // 本帧可能来自变化之前，保守丢弃并请求新关键帧。
                                    if enabled[at] && source != Source::Microphone { host::request_keyframe(session, to_host(source))?; }
                                    continue;
                                }
                                if !enabled[at] { continue; }
                                if source == Source::Microphone {
                                    let duration = opus_duration(&data)?;
                                    if let Some((previous, _)) = &pending[at] {
                                        if timestamp_us <= *previous { return Err("麦克风时间戳未递增".into()); }
                                    }
                                    pending[at] = Some((timestamp_us, bytes::Bytes::new()));
                                    send(media, source, data, duration).await?;
                                } else {
                                    if data.len() < 3 || data.len() > surreal_ck_peer_transport::media::MAX_VIDEO_FRAME {
                                        return Err("无效 VP8 帧大小".into());
                                    }
                                    // 不信任标志单独证明关键帧，VP8 首位必须也为零。
                                    if need_keyframe[at] {
                                        if !keyframe || data[0] & 1 != 0 { continue; }
                                        need_keyframe[at] = false;
                                    }
                                    if let Some((previous, frame)) = pending[at].take() {
                                        let delta = timestamp_us.checked_sub(previous).filter(|v| *v > 0 && *v <= 1_000_000).ok_or("VP8 时间戳倒退或间隔超限")?;
                                        send(media, source, frame, Duration::from_micros(delta)).await?;
                                    }
                                    pending[at] = Some((timestamp_us, data));
                                }
                            }
                        }
                    }
                },
                event = incoming.recv() => match event {
                    None => return Err("WebRTC 媒体接收已关闭".into()),
                    Some(Event::KeyframeRequested(source)) => {
                        if enabled[index(source)] && source != Source::Microphone { host::request_keyframe(session, to_host(source))?; }
                    }
                    Some(Event::Ended(source)) => { clocks[index(source)] = RtpClock::default(); }
                    Some(Event::Frame { source, timestamp, data }) => {
                        if source == Source::Microphone { opus_duration(&data)?; }
                        let rate = if source == Source::Microphone { 48_000 } else { 90_000 };
                        let Some(timestamp_us) = clocks[index(source)].convert(timestamp, rate) else { continue; };
                        if !host::present(session, to_host(source), timestamp_us, &data)? {
                            states.send_modify(|s| s.dropped_frames = s.dropped_frames.saturating_add(1));
                        }
                    }
                }
            }
        }
    }.await;
    disable(media);
    if !states.borrow().closed {
        states.send_modify(|s| s.stopping = true);
        let close_result = close_host(session, states).await;
        if let Err(error) = close_result {
            return Err(format!("{}；{error}", result.err().unwrap_or_default()));
        }
    }
    result
}
async fn send(
    media: &Media,
    source: Source,
    data: bytes::Bytes,
    duration: Duration,
) -> Result<(), String> {
    timeout(
        Duration::from_millis(500),
        media.send(source, data, duration),
    )
    .await
    .map_err(|_| "发送媒体超时".to_string())?
}
async fn close_host(session: u64, states: &watch::Sender<AndroidCallState>) -> Result<(), String> {
    if sync_snapshot(session, states)? {
        return Ok(());
    }
    host::stop(session)?;
    let deadline = Instant::now() + STOP_TIMEOUT;
    loop {
        if sync_snapshot(session, states)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Android 设备释放未获确认".into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// 从首个 RTP 帧建立相对微秒时间线，正确跨越 u32 回绕，拒绝旧/乱序包。
#[derive(Default)]
struct RtpClock {
    last: Option<u32>,
    ticks: u64,
}
impl RtpClock {
    fn convert(&mut self, timestamp: u32, rate: u64) -> Option<u64> {
        if let Some(last) = self.last {
            let delta = timestamp.wrapping_sub(last);
            if delta == 0 || delta >= 0x8000_0000 {
                return None;
            }
            self.ticks = self.ticks.checked_add(u64::from(delta))?;
        }
        self.last = Some(timestamp);
        self.ticks.checked_mul(1_000_000)?.checked_div(rate)
    }
}

/// 校验 RFC 6716 TOC、帧数、VBR/CBR 长度和 padding；最多 120ms。
fn opus_duration(data: &[u8]) -> Result<Duration, String> {
    let invalid = || "无效 Opus 包结构或时长".to_string();
    if data.len() < 2 || data.len() > 1275 {
        return Err(invalid());
    }
    let config = data[0] >> 3;
    let micros = if config >= 16 {
        2_500u64 << (config & 3)
    } else if config >= 12 {
        10_000u64 << (config & 1)
    } else {
        [10_000, 20_000, 40_000, 60_000][usize::from(config & 3)]
    };
    let mut cursor = 1;
    let mut end = data.len();
    let read_length = |cursor: &mut usize, end: usize| -> Result<usize, String> {
        if *cursor >= end {
            return Err(invalid());
        }
        let first = usize::from(data[*cursor]);
        *cursor += 1;
        if first < 252 {
            return Ok(first);
        }
        if *cursor >= end {
            return Err(invalid());
        }
        let size = first + 4 * usize::from(data[*cursor]);
        *cursor += 1;
        Ok(size)
    };
    let count = match data[0] & 3 {
        0 => 1usize,
        1 => {
            if !(end - cursor).is_multiple_of(2) {
                return Err(invalid());
            }
            2
        }
        2 => {
            let first = read_length(&mut cursor, end)?;
            if first > end - cursor {
                return Err(invalid());
            }
            2
        }
        _ => {
            let control = data[cursor];
            cursor += 1;
            let count = usize::from(control & 63);
            if count == 0 || count > 48 {
                return Err(invalid());
            }
            if control & 64 != 0 {
                loop {
                    if cursor >= end {
                        return Err(invalid());
                    }
                    let padding = usize::from(data[cursor]);
                    cursor += 1;
                    let amount = if padding == 255 { 254 } else { padding };
                    end = end
                        .checked_sub(amount)
                        .filter(|end| *end >= cursor)
                        .ok_or_else(invalid)?;
                    if padding != 255 {
                        break;
                    }
                }
            }
            if control & 128 != 0 {
                let mut used = 0usize;
                for _ in 1..count {
                    used += read_length(&mut cursor, end)?;
                }
                if used > end - cursor {
                    return Err(invalid());
                }
            } else if !(end - cursor).is_multiple_of(count) {
                return Err(invalid());
            }
            count
        }
    };
    let duration = micros * count as u64;
    if duration > 120_000 {
        return Err(invalid());
    }
    Ok(Duration::from_micros(duration))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rtp_wrap_and_old_packets() {
        let mut clock = RtpClock::default();
        assert_eq!(clock.convert(u32::MAX - 479, 48_000), Some(0));
        assert_eq!(clock.convert(480, 48_000), Some(20_000));
        assert_eq!(clock.convert(479, 48_000), None);
        assert_eq!(clock.convert(480, 48_000), None);
        assert_eq!(clock.convert(1440, 48_000), Some(40_000));
    }
    #[test]
    fn opus_toc_duration_is_not_assumed() {
        assert_eq!(
            opus_duration(&[0xf8, 0xff, 0xfe]).unwrap(),
            Duration::from_millis(20)
        );
        assert_eq!(
            opus_duration(&[0x80, 1]).unwrap(),
            Duration::from_micros(2500)
        );
        assert_eq!(
            opus_duration(&[0x18, 1]).unwrap(),
            Duration::from_millis(60)
        );
        assert!(opus_duration(&[]).is_err());
        assert!(opus_duration(&[0xf8]).is_err());
        assert!(opus_duration(&[0xfb, 0]).is_err());
        assert!(opus_duration(&[0xfb, 7, 1, 2, 3, 4, 5, 6, 7]).is_err());
        assert!(opus_duration(&[0xfa, 10, 1]).is_err());
        assert!(opus_duration(&[0xfb, 0x41, 255]).is_err());
        assert!(opus_duration(&[0xf9, 1, 2, 3]).is_err());
        assert_eq!(
            opus_duration(&[0xf9, 1, 2]).unwrap(),
            Duration::from_millis(40)
        );
        assert_eq!(
            opus_duration(&[0xfa, 1, 1, 2]).unwrap(),
            Duration::from_millis(40)
        );
        assert_eq!(
            opus_duration(&[0xfb, 2, 1, 2]).unwrap(),
            Duration::from_millis(40)
        );
        assert_eq!(
            opus_duration(&[0xfb, 0x82, 1, 1, 2]).unwrap(),
            Duration::from_millis(40)
        );
    }
}
