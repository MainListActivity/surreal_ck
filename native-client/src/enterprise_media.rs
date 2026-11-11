//! 企业媒体只接受本机显式命令；撤销与关闭共用唯一、不可取消的清理任务。
use super::{Call, Control, Notice, Source};
use crate::{bridge::Update, enterprise_peer::LeaseObserver};
use async_channel::{Receiver, Sender};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use surreal_ck_peer_transport::chat::Chat;
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::Duration,
};

/// 不从命令或普通Notice推断；仅映射平台权威采集watch。
// 桌面后端没有独立Starting/Stopping；Android真实异步权限/释放会发布这两态。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapturePhase {
    Stopped,
    Starting,
    Running,
    Stopping,
    Unconfirmed,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceCaptureState {
    pub source: Source,
    pub status: CapturePhase,
    pub revision: u64,
    /// 本源最近实际完成的operation_id；不是计数，也不表示启动成功。
    pub completed_operation: u64,
    pub error: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnterpriseCaptureState {
    pub session_id: u64,
    pub revision: u64,
    /// 固定顺序：麦克风、摄像头、屏幕。
    pub sources: [SourceCaptureState; 3],
    /// 独立接收consumer关闭确认；None表示平台未提供，不能推断播放已停止。
    pub playback: Option<[SourceCaptureState; 3]>,
    /// 桌面控制完成后读取的真实camera/screen流ID，不接受普通事件反写。
    pub video_streams: [Option<String>; 2],
    /// Android宿主的会话级错误不冒充任一具体设备的错误。
    pub backend_error: Option<String>,
    /// 独立于逐源状态；成功不能把Unconfirmed/Running改成Stopped。
    pub shutdown: Option<Result<(), String>>,
}
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
const SOURCES: [Source; 3] = [Source::Microphone, Source::Camera, Source::Screen];

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
type NativeCaptureState = surreal_ck_native_call::CaptureState;
#[cfg(all(target_os = "android", feature = "android-native-media"))]
type NativeCaptureState = surreal_ck_native_call::AndroidCallState;
#[cfg(not(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows",
    all(target_os = "android", feature = "android-native-media")
)))]
type NativeCaptureState = ();

fn snapshot(session_id: u64, native: &NativeCaptureState) -> EnterpriseCaptureState {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    let (sources, backend_error) = {
        use surreal_ck_native_call::CaptureStatus;
        (
            SOURCES.map(|source| SourceCaptureState {
                source,
                status: match native.status(source) {
                    CaptureStatus::Stopped => CapturePhase::Stopped,
                    CaptureStatus::Running => CapturePhase::Running,
                    CaptureStatus::Unconfirmed => CapturePhase::Unconfirmed,
                },
                revision: native.revision(source),
                completed_operation: 0,
                error: native.error(source).map(str::to_owned),
            }),
            None,
        )
    };
    #[cfg(all(target_os = "android", feature = "android-native-media"))]
    let (sources, backend_error) = {
        use surreal_ck_native_call::android::CaptureStatus;
        (
            std::array::from_fn(|at| SourceCaptureState {
                source: SOURCES[at],
                status: match native.statuses[at] {
                    CaptureStatus::Stopped => CapturePhase::Stopped,
                    CaptureStatus::Starting => CapturePhase::Starting,
                    CaptureStatus::Running => CapturePhase::Running,
                    CaptureStatus::Stopping => CapturePhase::Stopping,
                    CaptureStatus::Unconfirmed => CapturePhase::Unconfirmed,
                },
                revision: native.revisions[at],
                completed_operation: 0,
                error: None,
            }),
            native.error.clone(),
        )
    };
    #[cfg(not(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows",
        all(target_os = "android", feature = "android-native-media")
    )))]
    let (sources, backend_error) = {
        let _ = native;
        (
            SOURCES.map(|source| SourceCaptureState {
                source,
                status: CapturePhase::Unconfirmed,
                revision: 0,
                completed_operation: 0,
                error: None,
            }),
            Some("平台未实现权威采集状态".into()),
        )
    };
    EnterpriseCaptureState {
        session_id,
        revision: 0,
        sources,
        backend_error,
        playback: None,
        video_streams: [None, None],
        shutdown: None,
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
type NativePlaybackState = surreal_ck_native_call::CaptureState;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
type NativePlaybackState = ();
fn read_snapshot(
    session_id: u64,
    native: &mut watch::Receiver<NativeCaptureState>,
    playback: &Option<watch::Receiver<NativePlaybackState>>,
) -> EnterpriseCaptureState {
    let state = snapshot(session_id, &native.borrow_and_update());
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        let mut state = state;
        state.playback = playback
            .as_ref()
            .map(|rx| snapshot(session_id, &rx.borrow()).sources);
        state
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = playback;
        state
    }
}

fn video_streams(call: &Call) -> [Option<String>; 2] {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        call.video_streams()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = call;
        [None, None]
    }
}

fn publish_snapshot(
    published: &watch::Sender<EnterpriseCaptureState>,
    mut next: EnterpriseCaptureState,
    shutdown: Option<Result<(), String>>,
    completed: Option<(Source, u64)>,
    playback_completed: Option<(bool, u64)>,
    streams: Option<[Option<String>; 2]>,
) {
    published.send_modify(|current| {
        // 唯一发布者仍显式禁止终态被迟到普通watch更新覆盖。
        if current.shutdown.is_some() {
            return;
        }
        for (source, previous) in next.sources.iter_mut().zip(&current.sources) {
            source.completed_operation = completed
                .filter(|(target, _)| *target == source.source)
                .map_or(previous.completed_operation, |(_, id)| id);
        }
        if let (Some(playback), Some(previous)) = (&mut next.playback, &current.playback) {
            for (source, old) in playback.iter_mut().zip(previous) {
                source.completed_operation = playback_completed
                    .filter(|(video, _)| (source.source != Source::Microphone) == *video)
                    .map_or(old.completed_operation, |(_, id)| id);
            }
        }
        next.video_streams = streams.unwrap_or_else(|| current.video_streams.clone());
        next.revision = current.revision.saturating_add(1);
        next.shutdown = shutdown;
        *current = next;
    });
}

type Refresh = (
    Option<(Source, u64)>,
    Option<(bool, u64)>,
    [Option<String>; 2],
    oneshot::Sender<()>,
);
type Finalize = (Result<(), String>, [Option<String>; 2], oneshot::Sender<()>);
fn capture_snapshots(
    mut native: watch::Receiver<NativeCaptureState>,
    session_id: u64,
    mut playback: Option<watch::Receiver<NativePlaybackState>>,
) -> (
    watch::Receiver<EnterpriseCaptureState>,
    oneshot::Sender<Finalize>,
    mpsc::Sender<Refresh>,
) {
    let initial = read_snapshot(session_id, &mut native, &playback);
    let (published, states) = watch::channel(initial);
    let (finish, mut final_request) = oneshot::channel::<Finalize>();
    let (refresh, mut refreshes) = mpsc::channel::<Refresh>(1);
    tokio::spawn(async move {
        let mut open = true;
        let mut playback_open = playback.is_some();
        loop {
            tokio::select! {
                biased;
                final_state = &mut final_request => {
                    let (result, streams, ack) = match final_state {
                        Ok((result, streams, ack)) => (result, streams, Some(ack)),
                        Err(_) => (Err("媒体控制任务结束，设备停止未确认".into()), [None, None], None),
                    };
                    publish_snapshot(&published, read_snapshot(session_id, &mut native, &playback), Some(result), None, None, Some(streams));
                    if let Some(ack) = ack { let _ = ack.send(()); }
                    break;
                }
                Some((source, playback_group, streams, ack)) = refreshes.recv() => {
                    publish_snapshot(&published, read_snapshot(session_id, &mut native, &playback), None, source, playback_group, Some(streams));
                    let _ = ack.send(());
                }
                changed = async {
                    match playback.as_mut() {
                        Some(state) => state.changed().await,
                        None => std::future::pending().await,
                    }
                }, if playback_open => {
                    if changed.is_err() { playback_open = false; continue; }
                    publish_snapshot(&published, read_snapshot(session_id, &mut native, &playback), None, None, None, None);
                }
                changed = native.changed(), if open => {
                    if changed.is_err() { open = false; continue; }
                    publish_snapshot(&published, read_snapshot(session_id, &mut native, &playback), None, None, None, None);
                }
            }
        }
    });
    (states, finish, refresh)
}

pub struct EnterpriseCall {
    commands: Sender<(u64, Control)>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<Option<Result<(), String>>>,
    lease: LeaseObserver,
    captures: watch::Receiver<EnterpriseCaptureState>,
    next_operation: Arc<AtomicU64>,
}

/// UI可克隆的受控句柄。Drop不关闭会话；唯一actor/EnterpriseCall仍拥有清理责任。
#[derive(Clone)]
pub struct EnterpriseMediaHandle {
    commands: Sender<(u64, Control)>,
    stop: watch::Sender<bool>,
    lease: LeaseObserver,
    next_operation: Arc<AtomicU64>,
}
impl EnterpriseMediaHandle {
    pub fn request_stop(&self) {
        self.stop.send_replace(true);
    }

    pub fn control(&self, command: Control) -> Result<(), String> {
        self.submit(command).map(|_| ())
    }
    pub fn submit(&self, command: Control) -> Result<u64, String> {
        let command = command.into_action();
        if requires_lease(&command) && (!self.lease.is_active() || *self.stop.borrow()) {
            return Err("成员会话已失效或正在关闭，媒体未启动".into());
        }
        let operation = self
            .next_operation
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| {
                self.request_stop();
                "媒体操作编号耗尽，已请求停止，请重启客户端".to_owned()
            })?;
        if !requires_lease(&command) && (!self.lease.is_active() || *self.stop.borrow()) {
            self.stop.send_replace(true);
            return Ok(operation);
        }
        let stopping = !requires_lease(&command);
        match self.commands.try_send((operation, command)) {
            Ok(()) => Ok(operation),
            Err(_) if stopping => {
                self.stop.send_replace(true);
                Ok(operation)
            }
            Err(_) => Err("媒体操作队列已满或已关闭，请重试".into()),
        }
    }
}

fn requires_lease(control: &Control) -> bool {
    let control = control.action();
    #[cfg(all(target_os = "android", feature = "android-native-media"))]
    if matches!(control, Control::StopAllNativeMedia) {
        return false;
    }
    !matches!(
        control,
        Control::Stop(_) | Control::RemoteAudio(false) | Control::RemoteVideo(false)
    )
}

impl EnterpriseCall {
    /// 仅建立媒体协议与状态泵；不枚举设备、不采集、不播放。
    pub async fn attach(
        chat: &Chat,
        lease: LeaseObserver,
    ) -> Result<(Self, Receiver<Notice>), String> {
        if !cfg!(any(
            target_os = "linux",
            target_os = "macos",
            target_os = "windows",
            all(target_os = "android", feature = "android-native-media")
        )) {
            return Err("此平台未接通企业原生媒体；不会协商或启用设备".into());
        }
        if !lease.is_active() {
            return Err("成员会话已失效，媒体未建立".into());
        }
        let session_id = NEXT_SESSION
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| "媒体会话编号已耗尽，请重启客户端".to_owned())?;
        let (updates, incoming) = async_channel::bounded(128);
        let mut call = Call::attach(chat, updates).await?;
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        let playback = Some(call.playback_state());
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        let playback = None;
        let (captures, finalize, refresh) =
            capture_snapshots(call.capture_state(), session_id, playback);
        let (notices, events) = async_channel::bounded(128);
        let event_lease = lease.clone();
        let (stop, mut stopping) = watch::channel(false);
        let mut forwarding_stop = stopping.clone();
        let revoke_lease = lease.clone();
        let revoke_stop = stop.clone();
        let mut revoked = stopping.clone();
        // 即使控制正在等待UI背压，撤销也必须打断通知等待，唤醒唯一清理actor。
        tokio::spawn(async move {
            while revoke_lease.is_active() && !*revoked.borrow() {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(25)) => {},
                    result = revoked.changed() => { if result.is_err() { break; } }
                }
            }
            revoke_stop.send_replace(true);
        });
        // UI 即使撤销也必须收到采集/停止的权威状态，不能过滤隐私警告。
        tokio::spawn(async move {
            while let Ok(update) = incoming.recv().await {
                if let Update::Media(notice) = update {
                    if !event_lease.is_active()
                        && matches!(
                            notice,
                            Notice::VideoPresented(_)
                                | Notice::RemoteVideo { enabled: true, .. }
                                | Notice::RemoteAudio(true)
                        )
                    {
                        continue;
                    }
                    // 停止不能被无人消费的显示队列卡住。最终确认另存done watch，
                    // shutdown调用者必须使用该结果，不能把显示通知缺失当作成功。
                    if *forwarding_stop.borrow() {
                        let _ = notices.try_send(notice);
                    } else {
                        tokio::select! {
                            biased;
                            _ = forwarding_stop.changed() => { let _ = notices.try_send(notice); }
                            _ = notices.send(notice.clone()) => {}
                        }
                    }
                }
            }
        });
        let (commands, input) = async_channel::bounded::<(u64, Control)>(16);
        let (finished, done) = watch::channel(None);
        let worker_lease = lease.clone();
        let worker_stop = stop.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(25));
            loop {
                // 命令执行前及执行后都检查撤销，积压命令不能覆盖撤销。
                if *stopping.borrow() || !worker_lease.is_active() {
                    break;
                }
                tokio::select! {
                    biased;
                    changed = stopping.changed() => {
                        if changed.is_err() || *stopping.borrow() { break; }
                    }
                    _ = tick.tick() => {},
                    command = input.recv() => {
                        let Ok((operation, command)) = command else { break; };
                        if !worker_lease.is_active() { break; }
                        // 不取消进行中的设备控制future：先完成其清理所有权转移，再stop。
                        let source = command.source();
                        let playback_group = match &command { Control::RemoteAudio(_) => Some(false), Control::RemoteVideo(_) => Some(true), _ => None };
                        call.control(command).await;
                        let (ack, received) = oneshot::channel();
                        if refresh.send((source.map(|source| (source, operation)), playback_group.map(|video| (video, operation)), video_streams(&call), ack)).await.is_err() || received.await.is_err() { break; }
                    }
                }
            }
            worker_stop.send_replace(true);
            input.close();
            // 唯一关闭所有者。关闭调用者取消/Drop都不abort此任务。
            let mut result = call.shutdown().await;
            let (ack, received) = oneshot::channel();
            if finalize
                .send((result.clone(), video_streams(&call), ack))
                .is_err()
                || received.await.is_err()
            {
                result = Err("采集终态发布未获确认；不能确认设备停止".into());
            }
            // 最后真实逐源快照已发布后，才允许shutdown调用者完成。
            finished.send_replace(Some(result));
        });
        Ok((
            Self {
                commands,
                stop,
                done,
                lease,
                captures,
                next_operation: Arc::new(AtomicU64::new(1)),
            },
            events,
        ))
    }

    /// 入队不等于设备已开启；采集状态只能从capture_state读取。
    pub fn control(&self, command: Control) -> Result<(), String> {
        self.handle().control(command)
    }

    pub fn handle(&self) -> EnterpriseMediaHandle {
        EnterpriseMediaHandle {
            commands: self.commands.clone(),
            stop: self.stop.clone(),
            lease: self.lease.clone(),
            next_operation: self.next_operation.clone(),
        }
    }

    pub fn capture_state(&self) -> watch::Receiver<EnterpriseCaptureState> {
        self.captures.clone()
    }

    pub fn request_stop(&self) {
        self.stop.send_replace(true);
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.request_stop();
        wait_for_stop(self.done.clone()).await
    }
}

async fn wait_for_stop(
    mut done: watch::Receiver<Option<Result<(), String>>>,
) -> Result<(), String> {
    loop {
        if let Some(result) = done.borrow().clone() {
            return result;
        }
        done.changed()
            .await
            .map_err(|_| "媒体关闭任务异常，设备停止未确认".to_owned())?;
    }
}

impl Drop for EnterpriseCall {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        self.commands.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::timeout;

    #[test]
    fn successful_total_stop_never_rewrites_unknown_source_and_final_cannot_regress() {
        let mut initial = snapshot(77, &NativeCaptureState::default());
        initial.sources[1].status = CapturePhase::Unconfirmed;
        initial.sources[1].revision = 9;
        initial.sources[1].error = Some("真实关闭未确认".into());
        let (published, states) = watch::channel(initial.clone());
        publish_snapshot(&published, initial.clone(), Some(Ok(())), None, None, None);
        let final_state = states.borrow().clone();
        assert_eq!(final_state.sources[1].status, CapturePhase::Unconfirmed);
        assert_eq!(final_state.sources[1].revision, 9);
        assert_eq!(final_state.shutdown, Some(Ok(())));
        publish_snapshot(
            &published,
            snapshot(77, &NativeCaptureState::default()),
            None,
            None,
            None,
            None,
        );
        assert_eq!(*states.borrow(), final_state);
    }

    #[tokio::test]
    async fn final_snapshot_is_replayable_after_receiver_was_never_polled() {
        let (_native, state) = watch::channel(NativeCaptureState::default());
        let (snapshots, finalize, _refresh) = capture_snapshots(state, 91, None);
        let (ack, received) = oneshot::channel();
        finalize
            .send((Err("真实停止失败".into()), [None, None], ack))
            .unwrap();
        received.await.unwrap();
        let replay = snapshots.clone();
        assert_eq!(replay.borrow().session_id, 91);
        assert_eq!(replay.borrow().shutdown, Some(Err("真实停止失败".into())));
        assert_eq!(
            replay.borrow().sources,
            snapshot(91, &NativeCaptureState::default()).sources
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    #[tokio::test]
    async fn final_capture_error_does_not_erase_independent_playback_confirmation() {
        let (_native, state) = watch::channel(NativeCaptureState::default());
        let (_playback, playback) = watch::channel(NativePlaybackState::default());
        let (snapshots, finalize, _refresh) = capture_snapshots(state, 93, Some(playback));
        let (ack, received) = oneshot::channel();
        finalize
            .send((Err("采集关闭失败".into()), [None, None], ack))
            .unwrap();
        received.await.unwrap();
        assert!(snapshots.borrow().shutdown.as_ref().unwrap().is_err());
        assert!(
            snapshots
                .borrow()
                .playback
                .as_ref()
                .unwrap()
                .iter()
                .all(|source| source.status == CapturePhase::Stopped)
        );
    }

    #[tokio::test]
    async fn stream_ids_follow_control_completion_and_cannot_regress_after_final_read() {
        let (_native, state) = watch::channel(NativeCaptureState::default());
        let (snapshots, finalize, refresh) = capture_snapshots(state, 94, None);
        for id in ["first-live-stream", "replacement-live-stream"] {
            let (ack, received) = oneshot::channel();
            refresh
                .send((None, None, [Some(id.into()), None], ack))
                .await
                .unwrap();
            received.await.unwrap();
            assert_eq!(snapshots.borrow().video_streams[0].as_deref(), Some(id));
        }
        let (ack, received) = oneshot::channel();
        finalize.send((Ok(()), [None, None], ack)).unwrap();
        received.await.unwrap();
        assert_eq!(snapshots.borrow().video_streams, [None, None]);
        let (ack, _) = oneshot::channel();
        assert!(
            refresh
                .send((None, None, [Some("old-stream".into()), None], ack))
                .await
                .is_err()
        );
        assert_eq!(snapshots.borrow().video_streams, [None, None]);
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    #[tokio::test]
    async fn renderer_rejection_rereads_stopped_playback_without_fabricating_success() {
        let (_native, state) = watch::channel(NativeCaptureState::default());
        let (_playback, playback) = watch::channel(NativePlaybackState::default());
        let (snapshots, finalize, refresh) = capture_snapshots(state, 95, Some(playback));
        // 模拟renderer前置校验拒绝：native configure从未执行，revision仍为0。
        let (ack, received) = oneshot::channel();
        refresh
            .send((None, Some((true, 1)), [None, None], ack))
            .await
            .unwrap();
        received.await.unwrap();
        let current = snapshots.borrow().clone();
        let playback = current.playback.unwrap();
        assert_eq!(playback[0].completed_operation, 0);
        for source in &playback[1..] {
            assert_eq!(source.status, CapturePhase::Stopped);
            assert_eq!(source.revision, 0);
            assert_eq!(source.completed_operation, 1);
        }
        assert!(
            current
                .sources
                .iter()
                .all(|source| source.completed_operation == 0)
        );
        let (ack, received) = oneshot::channel();
        finalize.send((Ok(()), [None, None], ack)).unwrap();
        received.await.unwrap();
        assert_eq!(
            snapshots.borrow().playback.as_ref().unwrap()[1].completed_operation,
            1
        );
    }

    #[tokio::test]
    async fn completed_control_rereads_state_without_fabricating_backend_revision() {
        let (_native, state) = watch::channel(NativeCaptureState::default());
        let (snapshots, finalize, refresh) = capture_snapshots(state, 92, None);
        let (ack, received) = oneshot::channel();
        refresh
            .send((Some((Source::Camera, 41)), None, [None, None], ack))
            .await
            .unwrap();
        received.await.unwrap();
        assert_eq!(snapshots.borrow().sources[1].revision, 0);
        assert_eq!(snapshots.borrow().sources[1].completed_operation, 41);
        assert_eq!(snapshots.borrow().sources[0].completed_operation, 0);
        let (ack, received) = oneshot::channel();
        finalize.send((Ok(()), [None, None], ack)).unwrap();
        received.await.unwrap();
        assert_eq!(snapshots.borrow().sources[1].completed_operation, 41);
    }

    #[test]
    fn submission_assigns_unique_ids_and_does_not_forward_ui_ticket_wrappers() {
        let (commands, input) = async_channel::bounded(4);
        let handle = EnterpriseMediaHandle {
            commands,
            stop: watch::channel(false).0,
            lease: LeaseObserver::test_only(true),
            next_operation: Arc::new(AtomicU64::new(31)),
        };
        let first = handle
            .submit(Control::Tagged {
                ticket: 999,
                control: Box::new(Control::RemoteAudio(true)),
            })
            .unwrap();
        let second = handle.clone().submit(Control::RemoteAudio(false)).unwrap();
        assert_eq!((first, second), (31, 32));
        let (id, control) = input.try_recv().unwrap();
        assert_eq!(id, 31);
        assert!(matches!(control, Control::RemoteAudio(true)));
        assert_eq!(input.try_recv().unwrap().0, 32);
        assert!(!*handle.stop.borrow());
        drop(handle.clone());
        assert!(!*handle.stop.borrow());
    }

    #[test]
    fn only_explicit_enable_commands_require_active_membership() {
        assert!(requires_lease(&Control::Start {
            source: super::super::Source::Camera,
            selection: String::new()
        }));
        assert!(requires_lease(&Control::RemoteAudio(true)));
        assert!(requires_lease(&Control::RemoteVideo(true)));
        assert!(!requires_lease(&Control::Stop(
            super::super::Source::Camera
        )));
        assert!(!requires_lease(&Control::RemoteAudio(false)));
        assert!(!requires_lease(&Control::RemoteVideo(false)));
    }

    #[tokio::test]
    async fn shutdown_waits_for_authoritative_result_and_preserves_failure() {
        let (finish, done) = watch::channel(None);
        assert!(
            timeout(Duration::from_millis(10), wait_for_stop(done.clone()))
                .await
                .is_err()
        );
        finish.send_replace(Some(Err("设备关闭未确认".into())));
        assert_eq!(
            wait_for_stop(done.clone()).await,
            Err("设备关闭未确认".into())
        );
        assert!(wait_for_stop(done).await.is_err());
    }

    #[test]
    fn full_command_queue_cannot_discard_stop_intent() {
        let (commands, _input) = async_channel::bounded(1);
        let (stop, _) = watch::channel(false);
        let (_finish, done) = watch::channel(None);
        let call = EnterpriseCall {
            commands,
            stop,
            done,
            lease: LeaseObserver::test_only(true),
            captures: watch::channel(snapshot(1, &NativeCaptureState::default())).1,
            next_operation: Arc::new(AtomicU64::new(1)),
        };
        call.control(Control::RemoteAudio(true)).unwrap();
        assert!(call.control(Control::RemoteVideo(true)).is_err());
        call.control(Control::Stop(super::super::Source::Camera))
            .unwrap();
        assert!(*call.stop.borrow());
        assert!(call.control(Control::RemoteAudio(true)).is_err());
    }

    #[tokio::test]
    async fn lost_close_owner_is_never_success() {
        let (finish, done) = watch::channel(None);
        drop(finish);
        assert!(wait_for_stop(done).await.is_err());
    }

    #[tokio::test]
    async fn attach_opens_no_capture_and_shutdown_is_repeatable() {
        let (chat, _events) = Chat::new(true, surreal_ck_peer_transport::Route::Direct, vec![])
            .await
            .unwrap();
        let (call, events) = EnterpriseCall::attach(&chat, LeaseObserver::test_only(true))
            .await
            .unwrap();
        assert!(events.try_recv().is_err());
        call.shutdown().await.unwrap();
        call.shutdown().await.unwrap();
        assert!(call.control(Control::RemoteAudio(true)).is_err());
        let mut confirmed = false;
        while let Ok(event) = events.recv().await {
            assert!(!matches!(event, Notice::Capture { active: true, .. }));
            confirmed |= matches!(
                event,
                Notice::Stopped {
                    confirmed: true,
                    ..
                }
            );
        }
        assert!(confirmed);
        chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn revoked_lease_stops_without_an_explicit_close_and_preserves_notice() {
        let (chat, _events) = Chat::new(true, surreal_ck_peer_transport::Route::Direct, vec![])
            .await
            .unwrap();
        let lease = LeaseObserver::test_only(true);
        let (call, events) = EnterpriseCall::attach(&chat, lease.clone()).await.unwrap();
        lease.test_revoke();
        assert!(call.control(Control::RemoteAudio(true)).is_err());
        timeout(Duration::from_secs(2), async {
            loop {
                if matches!(
                    events.recv().await.unwrap(),
                    Notice::Stopped {
                        confirmed: true,
                        ..
                    }
                ) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        call.shutdown().await.unwrap();
        chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn dropping_handle_requests_shutdown_without_aborting_cleanup() {
        let (chat, _events) = Chat::new(true, surreal_ck_peer_transport::Route::Direct, vec![])
            .await
            .unwrap();
        let (call, events) = EnterpriseCall::attach(&chat, LeaseObserver::test_only(true))
            .await
            .unwrap();
        drop(call);
        timeout(Duration::from_secs(2), async {
            loop {
                if matches!(
                    events.recv().await.unwrap(),
                    Notice::Stopped {
                        confirmed: true,
                        ..
                    }
                ) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn unread_full_notice_queue_cannot_block_device_shutdown() {
        let (chat, _events) = Chat::new(true, surreal_ck_peer_transport::Route::Direct, vec![])
            .await
            .unwrap();
        let (call, _unread_events) = EnterpriseCall::attach(&chat, LeaseObserver::test_only(true))
            .await
            .unwrap();
        let commands = call.commands.clone();
        let producer = tokio::spawn(async move {
            for id in 1..=400 {
                if commands
                    .send((id, Control::RemoteAudio(false)))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        timeout(Duration::from_secs(2), call.shutdown())
            .await
            .unwrap()
            .unwrap();
        producer.await.unwrap();
        let final_state = call.capture_state().borrow().clone();
        assert_eq!(final_state.shutdown, Some(Ok(())));
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        assert!(
            final_state
                .playback
                .as_ref()
                .unwrap()
                .iter()
                .all(|source| source.status == CapturePhase::Stopped)
        );

        assert!(
            final_state
                .sources
                .iter()
                .all(|source| source.status == CapturePhase::Stopped)
        );
        call.shutdown().await.unwrap();
        assert_eq!(*call.capture_state().borrow(), final_state);
        chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn inactive_lease_cannot_attach_media() {
        let (chat, _events) = Chat::new(true, surreal_ck_peer_transport::Route::Direct, vec![])
            .await
            .unwrap();
        assert!(
            EnterpriseCall::attach(&chat, LeaseObserver::test_only(false))
                .await
                .is_err()
        );
        chat.close().await.unwrap();
    }
}
