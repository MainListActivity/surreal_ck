//! 实验企业信令与真实 WebRTC 连接。只接收身份层构造的连接，不接收 token/手工认证码。
//! 宿主必须在退出登录、切换工作区、成员撤销或生命周期结束时调用 close。
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use surreal_ck_native_identity::SignalConnection;
use surreal_ck_native_signaling::Signaling;
use surreal_ck_peer_transport::{
    Route,
    chat::{Chat, Event},
};
use tokio::{
    sync::{Mutex, Notify, mpsc::Receiver},
    task::JoinHandle,
    time::{Duration, timeout},
};

#[cfg(feature = "experimental-enterprise-media")]
use crate::call_bridge::{Control, EnterpriseCall, Notice};

#[cfg(feature = "experimental-enterprise-files")]
use crate::enterprise_files::{FileClosure, FileHandle, FileNotice, FileOwner};
#[cfg(feature = "experimental-enterprise-files")]
use std::sync::Mutex as StdMutex;

struct LocalClose {
    result: Result<(), String>,
    #[cfg(feature = "experimental-enterprise-files")]
    files: Option<FileClosure>,
}
impl LocalClose {
    fn failed(message: String) -> Self {
        Self {
            result: Err(message),
            #[cfg(feature = "experimental-enterprise-files")]
            files: None,
        }
    }
}
#[cfg(feature = "experimental-enterprise-files")]
#[derive(Clone)]
struct AttachedFiles {
    owner: Arc<FileOwner>,
    handle: FileHandle,
}
#[cfg(feature = "experimental-enterprise-files")]
type FilesSlot = Arc<StdMutex<Option<AttachedFiles>>>;

/// 先阻断网络，再等待全部设备/文件停止；任何错误都不跳过其它真实清理。
async fn close_local(
    chat: &Chat,
    lease: &LeaseObserver,
    #[cfg(feature = "experimental-enterprise-media")] media: Option<&EnterpriseCall>,
    #[cfg(feature = "experimental-enterprise-files")] files: Option<&FileOwner>,
) -> LocalClose {
    lease.0.store(false, Ordering::SeqCst);
    #[cfg(feature = "experimental-enterprise-files")]
    if let Some(files) = files {
        files.request_stop();
    }
    #[cfg(feature = "experimental-enterprise-media")]
    if let Some(media) = media {
        media.request_stop();
    }
    let mut errors = Vec::new();
    if let Err(error) = chat.close().await {
        errors.push(format!("网络关闭未确认：{error}"));
    }
    #[cfg(feature = "experimental-enterprise-media")]
    if let Some(media) = media
        && let Err(error) = media.shutdown().await
    {
        errors.push(format!("媒体停止未确认：{error}"));
    }
    #[cfg(feature = "experimental-enterprise-files")]
    let files = match files {
        Some(files) => {
            let closure = files.shutdown().await;
            if !closure.confirmed() {
                errors.push("文件清理未确认，请保留原会话关闭回执".into());
            }
            Some(closure)
        }
        None => None,
    };
    LocalClose {
        result: if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        },
        #[cfg(feature = "experimental-enterprise-files")]
        files,
    }
}

async fn transport_terminated(chat: &Chat) {
    let observer = chat.termination_observer();
    while !observer.is_terminated() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// UI 可持有只读观察器；撤销后排队的旧事件也必须在消费时拒绝。
#[derive(Clone)]
pub struct LeaseObserver(Arc<AtomicBool>);
impl LeaseObserver {
    pub fn is_active(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    #[cfg(test)]
    pub(crate) fn test_revoke(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
    #[cfg(test)]
    pub(crate) fn test_only(active: bool) -> Self {
        Self(Arc::new(AtomicBool::new(active)))
    }
}
impl std::fmt::Debug for LeaseObserver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("LeaseObserver")
            .field(&self.is_active())
            .finish()
    }
}
#[derive(Debug)]
pub struct CloseOutcome {
    pub local_closed: bool,
    pub remote_end_error: Option<String>,
    pub local_close_error: Option<String>,
    /// 原身份的私有回执；即使local_closed=false也必须结算，禁止跨身份自动展示。
    #[cfg(feature = "experimental-enterprise-files")]
    pub(crate) file_closure: Option<FileClosure>,
}
pub struct EnterprisePeer {
    signaling: Arc<Mutex<Signaling>>,
    monitor: Option<JoinHandle<LocalClose>>,
    stop: Arc<Notify>,
    chat: Arc<Chat>,
    answered: bool,
    lease: LeaseObserver,
    #[cfg(feature = "experimental-enterprise-files")]
    files: FilesSlot,
    #[cfg(feature = "experimental-enterprise-media")]
    media: Arc<EnterpriseCall>,
    #[cfg(feature = "experimental-enterprise-media")]
    media_events: Option<async_channel::Receiver<Notice>>,
}
impl EnterprisePeer {
    /// 当前实验只走显式直连/STUN；不静默启用任意公共TURN。
    pub async fn invite(
        connection: SignalConnection,
        recipient: &str,
        stun: Vec<String>,
    ) -> Result<(Self, Receiver<Event>), String> {
        let mut signaling = Signaling::new(connection);
        let (chat, events) = Chat::new(true, Route::Direct, stun)
            .await
            .map_err(|e| e.to_string())?;
        let chat = Arc::new(chat);
        let lease = LeaseObserver(Arc::new(AtomicBool::new(true)));
        #[cfg(feature = "experimental-enterprise-media")]
        let (media, media_events) = match EnterpriseCall::attach(&chat, lease.clone()).await {
            Ok((media, events)) => (Arc::new(media), events),
            Err(error) => {
                drop(events);
                let cleanup = close_local(
                    &chat,
                    &lease,
                    None,
                    #[cfg(feature = "experimental-enterprise-files")]
                    None,
                )
                .await
                .result;
                let _ = signaling.end().await;
                return Err(cleanup
                    .err()
                    .map_or(error.clone(), |cleanup| format!("{error}；{cleanup}")));
            }
        };
        let offer = match chat.offer_json().await {
            Ok(value) => value,
            Err(error) => {
                drop(events);
                #[cfg(feature = "experimental-enterprise-media")]
                drop(media_events);
                let cleanup = close_local(
                    &chat,
                    &lease,
                    #[cfg(feature = "experimental-enterprise-media")]
                    Some(&media),
                    #[cfg(feature = "experimental-enterprise-files")]
                    None,
                )
                .await
                .result;
                if let Err(cleanup) = cleanup {
                    return Err(format!("{error}；{cleanup}"));
                }
                return Err(error.to_string());
            }
        };
        if let Err(error) = signaling.invite(recipient, &offer).await {
            drop(events);
            #[cfg(feature = "experimental-enterprise-media")]
            drop(media_events);
            let cleanup = close_local(
                &chat,
                &lease,
                #[cfg(feature = "experimental-enterprise-media")]
                Some(&media),
                #[cfg(feature = "experimental-enterprise-files")]
                None,
            )
            .await
            .result;
            if let Err(cleanup) = cleanup {
                return Err(format!("{error}；{cleanup}"));
            }
            return Err(error.to_string());
        }
        Ok((
            Self::start_monitor(
                signaling,
                chat,
                false,
                lease,
                #[cfg(feature = "experimental-enterprise-media")]
                media,
                #[cfg(feature = "experimental-enterprise-media")]
                media_events,
            ),
            events,
        ))
    }
    /// 调用前必须明确接受该邀请。凭据始终留在身份连接，只有已校验SDP进入Peer。
    pub async fn accept(
        connection: SignalConnection,
        invitation_id: &str,
        stun: Vec<String>,
    ) -> Result<(Self, Receiver<Event>), String> {
        let mut signaling = Signaling::new(connection);
        let offer = signaling
            .accept(invitation_id)
            .await
            .map_err(|e| e.to_string())?;
        let (chat, events) = match Chat::new(false, Route::Direct, stun).await {
            Ok(value) => value,
            Err(error) => {
                let _ = signaling.end().await;
                return Err(error.to_string());
            }
        };
        let chat = Arc::new(chat);
        let lease = LeaseObserver(Arc::new(AtomicBool::new(true)));
        #[cfg(feature = "experimental-enterprise-media")]
        let (media, media_events) = match EnterpriseCall::attach(&chat, lease.clone()).await {
            Ok((media, events)) => (Arc::new(media), events),
            Err(error) => {
                drop(events);
                let cleanup = close_local(
                    &chat,
                    &lease,
                    None,
                    #[cfg(feature = "experimental-enterprise-files")]
                    None,
                )
                .await
                .result;
                let _ = signaling.end().await;
                return Err(cleanup
                    .err()
                    .map_or(error.clone(), |cleanup| format!("{error}；{cleanup}")));
            }
        };
        let answer = match chat.answer_json(offer.sdp_json()).await {
            Ok(value) => value,
            Err(error) => {
                drop(events);
                #[cfg(feature = "experimental-enterprise-media")]
                drop(media_events);
                let cleanup = close_local(
                    &chat,
                    &lease,
                    #[cfg(feature = "experimental-enterprise-media")]
                    Some(&media),
                    #[cfg(feature = "experimental-enterprise-files")]
                    None,
                )
                .await
                .result;
                if let Err(cleanup) = cleanup {
                    return Err(format!("{error}；{cleanup}"));
                }
                let _ = signaling.end().await;
                return Err(error.to_string());
            }
        };
        if let Err(error) = signaling.answer(&answer).await {
            drop(events);
            #[cfg(feature = "experimental-enterprise-media")]
            drop(media_events);
            let cleanup = close_local(
                &chat,
                &lease,
                #[cfg(feature = "experimental-enterprise-media")]
                Some(&media),
                #[cfg(feature = "experimental-enterprise-files")]
                None,
            )
            .await
            .result;
            if let Err(cleanup) = cleanup {
                return Err(format!("{error}；{cleanup}"));
            }
            let _ = signaling.end().await;
            return Err(error.to_string());
        }
        Ok((
            Self::start_monitor(
                signaling,
                chat,
                true,
                lease,
                #[cfg(feature = "experimental-enterprise-media")]
                media,
                #[cfg(feature = "experimental-enterprise-media")]
                media_events,
            ),
            events,
        ))
    }
    fn start_monitor(
        signaling: Signaling,
        chat: Arc<Chat>,
        answered: bool,
        lease: LeaseObserver,
        #[cfg(feature = "experimental-enterprise-media")] media: Arc<EnterpriseCall>,
        #[cfg(feature = "experimental-enterprise-media")] media_events: async_channel::Receiver<
            Notice,
        >,
    ) -> Self {
        let signaling = Arc::new(Mutex::new(signaling));
        let monitor_signal = signaling.clone();
        let monitor_chat = chat.clone();
        #[cfg(feature = "experimental-enterprise-media")]
        let monitor_media = media.clone();
        let monitor_lease = lease.clone();
        #[cfg(feature = "experimental-enterprise-files")]
        let files: FilesSlot = Arc::new(StdMutex::new(None));
        #[cfg(feature = "experimental-enterprise-files")]
        let monitor_files = files.clone();
        let stop = Arc::new(Notify::new());
        let monitor_stop = stop.clone();
        let monitor = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _=monitor_stop.notified()=>break,
                    _=transport_terminated(&monitor_chat)=>break,
                    _=tokio::time::sleep(Duration::from_secs(10))=>{}
                }
                let result = tokio::select! {
                    biased;
                    _=monitor_stop.notified()=>break,
                    _=transport_terminated(&monitor_chat)=>break,
                    result=timeout(Duration::from_secs(10),async {
                        monitor_signal.lock().await.revalidate_peer().await
                    })=>result,
                };
                if !matches!(result, Ok(Ok(()))) {
                    break;
                }
            }
            // 先撤销lease再取owner；attach_files在同一槽锁内复查lease，不能错过关闭。
            monitor_lease.0.store(false, Ordering::SeqCst);
            #[cfg(feature = "experimental-enterprise-files")]
            let closing_files = monitor_files
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            // 唯一close任务：通知可以取消检查，不能中断已开始的连接/设备/文件清理。
            close_local(
                &monitor_chat,
                &monitor_lease,
                #[cfg(feature = "experimental-enterprise-media")]
                Some(&monitor_media),
                #[cfg(feature = "experimental-enterprise-files")]
                closing_files.as_ref().map(|files| files.owner.as_ref()),
            )
            .await
        });
        Self {
            signaling,
            monitor: Some(monitor),
            stop,
            chat,
            answered,
            lease,
            #[cfg(feature = "experimental-enterprise-files")]
            files,
            #[cfg(feature = "experimental-enterprise-media")]
            media,
            #[cfg(feature = "experimental-enterprise-media")]
            media_events: Some(media_events),
        }
    }
    fn invalidate_and_close_in_background(&self) {
        self.lease.0.store(false, Ordering::SeqCst);
        #[cfg(feature = "experimental-enterprise-files")]
        if let Some(files) = self
            .files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            files.owner.request_stop();
        }
        #[cfg(feature = "experimental-enterprise-media")]
        self.media.request_stop();
        self.stop.notify_one();
    }
    /// 宿主一旦观察Closed即调用，不能等UI排队更新；回调原子观察另有100ms兜底。
    pub(crate) fn transport_closed(&self) {
        self.invalidate_and_close_in_background();
    }
    /// 只用本Peer的私有连接与lease；UI代次不参与授权。接收器由专用文件消费者领取。
    #[cfg(feature = "experimental-enterprise-files")]
    pub(crate) async fn attach_files(
        &mut self,
        generation: u64,
    ) -> Result<(FileHandle, Receiver<FileNotice>), String> {
        let current = self.signaling.lock().await.ensure_current();
        if let Err(error) = current {
            self.invalidate_and_close_in_background();
            return Err(error.to_string());
        }
        let mut slot = self.files.lock().unwrap_or_else(|e| e.into_inner());
        if !self.lease.is_active() || self.chat.termination_observer().is_terminated() {
            return Err("成员或连接已失效，不能建立文件通道".into());
        }
        if slot.is_some() {
            return Err("该企业连接已建立文件通道，不能重复绑定".into());
        }
        let (owner, handle, notices) =
            FileOwner::attach(self.chat.clone(), self.lease.clone(), generation)?;
        *slot = Some(AttachedFiles {
            owner: Arc::new(owner),
            handle: handle.clone(),
        });
        Ok((handle, notices))
    }
    /// 只路由文件Binary帧，保持Chat接收顺序；成功仅表示入队，不表示送达。
    #[cfg(feature = "experimental-enterprise-files")]
    pub(crate) fn file_binary(&self, bytes: Vec<u8>) -> Result<(), String> {
        let handle = self
            .files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|files| files.handle.clone())
            .ok_or("企业文件通道未建立")?;
        handle.binary(bytes)
    }
    #[cfg(feature = "experimental-enterprise-media")]
    pub(crate) fn media_capture_state(
        &self,
    ) -> Option<tokio::sync::watch::Receiver<crate::call_bridge::EnterpriseCaptureState>> {
        Some(self.media.capture_state())
    }
    #[cfg(feature = "experimental-enterprise-media")]
    pub(crate) fn media_handle(&self) -> Option<crate::call_bridge::EnterpriseMediaHandle> {
        Some(self.media.handle())
    }
    // UI尚未接入；保持crate内边界，不公开原始Chat或私有Control类型。
    #[allow(dead_code)]
    #[cfg(feature = "experimental-enterprise-media")]
    pub(crate) fn control_media(&self, command: Control) -> Result<(), String> {
        self.media.control(command)
    }
    // UI尚未接入；专用消费者只能领取一次。
    #[allow(dead_code)]
    #[cfg(feature = "experimental-enterprise-media")]
    pub(crate) fn take_media_events(&mut self) -> Option<async_channel::Receiver<Notice>> {
        self.media_events.take()
    }
    pub fn lease_observer(&self) -> LeaseObserver {
        self.lease.clone()
    }
    pub fn lease_active(&self) -> bool {
        self.lease.is_active()
    }
    /// 至少3秒间隔；返回true仅表示已应用answer，不表示ICE/通道已经连通。
    pub async fn poll_answer(&mut self) -> Result<bool, String> {
        if !self.lease_active() {
            return Err("成员会话已失效，不能继续协商".into());
        }
        if self.answered {
            return Ok(true);
        }
        let answer = self.signaling.lock().await.poll_answer().await;
        let answer = match answer {
            Ok(value) => value,
            Err(error) => {
                if error != surreal_ck_native_signaling::Error::RateLimited {
                    self.invalidate_and_close_in_background();
                }
                return Err(error.to_string());
            }
        };
        match answer {
            None => Ok(false),
            Some(answer) => {
                self.answered = true;
                if let Err(error) = self.chat.accept_answer_json(answer.sdp_json()).await {
                    self.invalidate_and_close_in_background();
                    return Err(error.to_string());
                }
                Ok(true)
            }
        }
    }
    pub async fn send_text(&self, text: &str) -> Result<(), String> {
        if !self.lease_active() {
            return Err("成员会话已失效，消息未发送".into());
        }
        let current = self.signaling.lock().await.ensure_current();
        if let Err(error) = current {
            self.invalidate_and_close_in_background();
            return Err(error.to_string());
        }
        self.chat.send_text(text).await
    }
    /// 本地通道先停止。数据库拒绝/过期不能阻止本地关闭。
    pub async fn close(mut self) -> Result<CloseOutcome, String> {
        #[cfg(feature = "experimental-enterprise-media")]
        self.media_events.take();
        self.invalidate_and_close_in_background();
        let local = match self.monitor.take() {
            Some(task) => match task.await {
                Ok(result) => result,
                Err(_) => LocalClose::failed("本地关闭任务异常，关闭未确认".into()),
            },
            None => LocalClose::failed("本地关闭任务缺失，关闭未确认".into()),
        };
        #[cfg(feature = "experimental-enterprise-files")]
        let file_closure = match local.files {
            Some(closure) => Some(closure),
            None => {
                // monitor异常也不吞掉已保存事实；文件owner独立继续清理并缓存真实回执。
                let owner = self
                    .files
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .map(|files| files.owner.clone());
                match owner {
                    Some(owner) => Some(owner.shutdown().await),
                    None => None,
                }
            }
        };
        let remote = self
            .signaling
            .lock()
            .await
            .end()
            .await
            .map_err(|e| e.to_string());
        let local_close_error = local.result.err();
        let local_closed = local_close_error.is_none();
        #[cfg(feature = "experimental-enterprise-files")]
        let local_closed = local_closed && file_closure.as_ref().is_none_or(FileClosure::confirmed);
        Ok(CloseOutcome {
            local_closed,
            local_close_error,
            remote_end_error: remote.err(),
            #[cfg(feature = "experimental-enterprise-files")]
            file_closure,
        })
    }
}
impl Drop for EnterprisePeer {
    fn drop(&mut self) {
        self.invalidate_and_close_in_background();
        // 丢JoinHandle只detach，不取消清理。显式close会await同一个任务。
        self.monitor.take();
    }
}

#[cfg(test)]
mod lease_tests {
    use super::*;
    #[cfg(feature = "experimental-enterprise-media")]
    #[tokio::test]
    async fn local_close_revokes_lease_and_waits_for_media_without_a_consumer() {
        let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let lease = LeaseObserver::test_only(true);
        let (media, _unread) = EnterpriseCall::attach(&chat, lease.clone()).await.unwrap();
        close_local(
            &chat,
            &lease,
            Some(&media),
            #[cfg(feature = "experimental-enterprise-files")]
            None,
        )
        .await
        .result
        .unwrap();
        assert!(!lease.is_active());
        assert!(media.control(Control::RemoteAudio(true)).is_err());
        media.shutdown().await.unwrap();
    }

    #[cfg(feature = "experimental-enterprise-files")]
    #[tokio::test]
    async fn local_close_stops_files_and_preserves_receipt_without_a_ui_consumer() {
        let (chat, events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        drop(events);
        let chat = Arc::new(chat);
        let lease = LeaseObserver::test_only(true);
        let (files, handle, _unread) = FileOwner::attach(chat.clone(), lease.clone(), 9).unwrap();
        let local = close_local(
            &chat,
            &lease,
            #[cfg(feature = "experimental-enterprise-media")]
            None,
            Some(&files),
        )
        .await;
        assert!(!lease.is_active());
        assert!(!handle.is_active());
        assert!(local.result.is_ok());
        let receipt = local.files.expect("文件回执不能依赖UI显示队列");
        assert!(receipt.confirmed());
        assert_eq!(receipt.context.session, handle.session());
        assert_eq!(receipt.result, handle.closed_receipt().await.result);
    }

    #[test]
    fn queued_observer_reads_revocation_after_clone() {
        let lease = LeaseObserver::test_only(true);
        let queued = lease.clone();
        assert!(queued.is_active());
        lease.test_revoke();
        assert!(!queued.is_active());
        assert!(!LeaseObserver::test_only(false).is_active());
    }
}
// TEST-ONLY extension, appended after an exact byte-for-byte production source prefix.
// Bypasses CaptureInput and Media.enabled. Never claims device capture or device release.
#[cfg(test)]
impl EnterprisePeer {
    async fn synthetic_camera_sample(&self, bytes: bytes::Bytes) -> Result<(), String> {
        use surreal_ck_peer_transport::webrtc::{
            media::Sample, peer_connection::peer_connection_state::RTCPeerConnectionState,
            track::track_local::track_local_static_sample::TrackLocalStaticSample,
        };
        if !self.lease_active() {
            return Err("test input lease revoked".into());
        }
        let pc = self.chat.peer().connection();
        if pc.connection_state() != RTCPeerConnectionState::Connected {
            return Err("test input peer not connected".into());
        }
        for sender in pc.get_senders().await {
            if let Some(track) = sender.track().await {
                if track.id() == "camera" {
                    let sample = track
                        .as_any()
                        .downcast_ref::<TrackLocalStaticSample>()
                        .ok_or("camera track is not the production static sample track")?;
                    // Recheck immediately before input. This is a test-input guard, not
                    // evidence that the production Media.send gate was exercised.
                    if !self.lease_active() {
                        return Err("test input lease revoked".into());
                    }
                    return sample
                        .write_sample(&Sample {
                            data: bytes,
                            duration: std::time::Duration::from_millis(100),
                            ..Default::default()
                        })
                        .await
                        .map_err(|e| e.to_string());
                }
            }
        }
        Err("production camera sender missing".into())
    }
}
#[cfg(test)]
#[path = "media-tests.rs"]
mod enterprise_media_e2e;
