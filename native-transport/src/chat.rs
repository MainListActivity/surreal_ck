//! 手工信令聊天桥接；SDP 可能含地址，只应交给已验证的对端。
use crate::{Peer, Route};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tokio::sync::{mpsc, Mutex};
use webrtc::data_channel::{data_channel_state::RTCDataChannelState, RTCDataChannel};
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
pub const MAX_TEXT_BYTES: usize = 16 * 1024;
/// 文件协议单帧上限，包含协议头。
pub const MAX_BINARY_BYTES: usize = crate::file::CHUNK_SIZE + 64;
#[derive(Debug, Clone)]
pub enum Event {
    Open,
    Text(String),
    Binary(Vec<u8>),
    State(String),
    Closed,
}
/// 可共享的只读连接代次。UI 消费排队结果时仍能检查真实回调已观察的变化。
/// 私有 Atomic 不向宿主提供重置入口；0 表示计数耗尽，永久不可用于人工核对。
#[derive(Clone, Debug)]
pub struct ConnectionEpoch(Arc<AtomicU64>);
impl ConnectionEpoch {
    fn new() -> Self {
        Self(Arc::new(AtomicU64::new(1)))
    }
    pub fn current(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    fn advance(&self) {
        let mut previous = self.current();
        loop {
            let next = if previous == 0 {
                0
            } else {
                previous.checked_add(1).unwrap_or(0)
            };
            match self
                .0
                .compare_exchange_weak(previous, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return,
                Err(observed) => previous = observed,
            }
        }
    }
}
/// 单调、只读的会话终止观察器；独立于事件队列和人工核对代次。
/// 一旦终止便不可复位，正常协商不会改变它。
#[derive(Clone, Debug)]
pub struct TerminationObserver(Arc<AtomicBool>);
impl TerminationObserver {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    pub fn is_terminated(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    fn terminate(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
// 同步标记必须发生在构造事件发送future之前，不能等待有界队列腾出空间。
fn closed_event(
    epoch: &ConnectionEpoch,
    termination: &TerminationObserver,
    tx: mpsc::Sender<Event>,
) -> impl std::future::Future<Output = ()> + Send + 'static {
    epoch.advance();
    termination.terminate();
    async move {
        let _ = tx.send(Event::Closed).await;
    }
}
pub struct Chat {
    peer: Peer,
    channel: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    connection_epoch: ConnectionEpoch,
    termination: TerminationObserver,
}
fn attach(
    channel: Arc<RTCDataChannel>,
    tx: mpsc::Sender<Event>,
    epoch: ConnectionEpoch,
    termination: TerminationObserver,
) {
    let open_tx = tx.clone();
    channel.on_open(Box::new(move || {
        Box::pin(async move {
            let _ = open_tx.send(Event::Open).await;
        })
    }));
    let close_tx = tx.clone();
    channel.on_close(Box::new(move || {
        // 数据通道关闭不一定改变PeerConnection状态，也必须立即撤销核对。
        Box::pin(closed_event(&epoch, &termination, close_tx.clone()))
    }));
    channel.on_message(Box::new(move |message| {
        let tx = tx.clone();
        Box::pin(async move {
            if message.is_string && message.data.len() <= MAX_TEXT_BYTES {
                if let Ok(text) = String::from_utf8(message.data.to_vec()) {
                    let _ = tx.send(Event::Text(text)).await;
                }
            } else if !message.is_string && message.data.len() <= MAX_BINARY_BYTES {
                let _ = tx.send(Event::Binary(message.data.to_vec())).await;
            }
        })
    }));
}
impl Chat {
    /// 每次协商入口和 PeerConnection 状态回调都会推进；不要缓存此值作实时判断。
    pub fn connection_epoch(&self) -> u64 {
        self.connection_epoch.current()
    }
    pub fn connection_epoch_observer(&self) -> ConnectionEpoch {
        self.connection_epoch.clone()
    }
    pub fn termination_observer(&self) -> TerminationObserver {
        self.termination.clone()
    }
    /// 媒体轨必须在 offer/answer 之前通过这个 Peer 附加。
    pub fn peer(&self) -> &Peer {
        &self.peer
    }
    pub async fn new(
        initiator: bool,
        route: Route,
        stun_urls: Vec<String>,
    ) -> Result<(Self, mpsc::Receiver<Event>), crate::Error> {
        let peer = Peer::new(route, stun_urls).await?;
        Self::from_peer(peer, initiator).await
    }
    pub async fn from_peer(
        peer: Peer,
        initiator: bool,
    ) -> Result<(Self, mpsc::Receiver<Event>), crate::Error> {
        let (tx, rx) = mpsc::channel(128);
        let channel = Arc::new(Mutex::new(None));
        let connection_epoch = ConnectionEpoch::new();
        let termination = TerminationObserver::new();
        let state_termination = termination.clone();
        let state_epoch = connection_epoch.clone();
        let state_tx = tx.clone();
        peer.connection()
            .on_peer_connection_state_change(Box::new(move |state| {
                // 必须先撤销旧人工确认，不能等待UI事件队列空间或消费者。
                state_epoch.advance();
                use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
                if matches!(
                    state,
                    RTCPeerConnectionState::Disconnected
                        | RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Closed
                ) {
                    state_termination.terminate();
                }
                let tx = state_tx.clone();
                Box::pin(async move {
                    let _ = tx.send(Event::State(state.to_string())).await;
                })
            }));
        if initiator {
            let dc = peer
                .connection()
                .create_data_channel("chat-v1", None)
                .await?;
            attach(
                dc.clone(),
                tx,
                connection_epoch.clone(),
                termination.clone(),
            );
            *channel.lock().await = Some(dc);
        } else {
            let slot = channel.clone();
            let data_channel_epoch = connection_epoch.clone();
            let data_channel_termination = termination.clone();
            peer.connection().on_data_channel(Box::new(move |dc| {
                let slot = slot.clone();
                let tx = tx.clone();
                let epoch = data_channel_epoch.clone();
                let termination = data_channel_termination.clone();
                Box::pin(async move {
                    let mut guard = slot.lock().await;
                    if dc.label() != "chat-v1" || guard.is_some() {
                        let _ = dc.close().await;
                        return;
                    }
                    attach(dc.clone(), tx, epoch, termination);
                    *guard = Some(dc);
                })
            }));
        }
        Ok((
            Self {
                peer,
                channel,
                connection_epoch,
                termination,
            },
            rx,
        ))
    }
    pub async fn offer_json(&self) -> Result<String, String> {
        self.connection_epoch.advance();
        serde_json::to_string(&self.peer.offer().await.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
    fn parse(json: &str) -> Result<RTCSessionDescription, String> {
        if json.len() > 256 * 1024 {
            return Err("SDP too large".into());
        }
        serde_json::from_str(json).map_err(|e| e.to_string())
    }
    pub async fn answer_json(&self, offer: &str) -> Result<String, String> {
        self.connection_epoch.advance();
        serde_json::to_string(
            &self
                .peer
                .answer(Self::parse(offer)?)
                .await
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }
    pub async fn accept_answer_json(&self, answer: &str) -> Result<(), String> {
        self.connection_epoch.advance();
        self.peer
            .accept_answer(Self::parse(answer)?)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn send_text(&self, text: &str) -> Result<(), String> {
        if text.len() > MAX_TEXT_BYTES {
            return Err("message exceeds 16 KiB".into());
        }
        let guard = self.channel.lock().await;
        let channel = guard.as_ref().ok_or("no channel")?;
        if channel.ready_state() != RTCDataChannelState::Open {
            return Err("channel not open".into());
        }
        if channel.buffered_amount().await > 256 * 1024 {
            return Err("backpressure: retry later".into());
        }
        channel
            .send_text(text)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    /// 有界二进制发送；超过高水位等待，30 秒后报告连接/背压错误。
    pub async fn send_binary(&self, data: &[u8]) -> Result<(), String> {
        if data.is_empty() || data.len() > MAX_BINARY_BYTES {
            return Err("invalid binary frame size".into());
        }
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let guard = self.channel.lock().await;
                let channel = guard.as_ref().ok_or("no channel")?;
                if channel.ready_state() != RTCDataChannelState::Open {
                    return Err("channel not open".into());
                }
                if channel.buffered_amount().await <= 256 * 1024 {
                    return channel
                        .send(&bytes::Bytes::copy_from_slice(data))
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string());
                }
                drop(guard);
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| "binary send backpressure timed out".to_string())?
    }
    pub async fn close(&self) -> Result<(), crate::Error> {
        self.termination.terminate();
        self.connection_epoch.advance();
        self.peer.close().await
    }
}

#[cfg(test)]
mod epoch_tests {
    use super::*;

    #[tokio::test]
    async fn termination_precedes_closed_event_even_when_queue_is_full() {
        let epoch = ConnectionEpoch::new();
        let termination = TerminationObserver::new();
        let observer = termination.clone();
        epoch.advance();
        assert!(!observer.is_terminated(), "正常协商代次不代表终止");
        let (tx, mut rx) = mpsc::channel(1);
        tx.try_send(Event::Open).unwrap();
        let notification = closed_event(&epoch, &termination, tx);
        assert!(observer.is_terminated(), "不poll事件future也必须已终止");
        tokio::pin!(notification);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(1), &mut notification)
                .await
                .is_err()
        );
        assert!(observer.is_terminated());
        assert!(matches!(rx.recv().await, Some(Event::Open)));
        notification.await;
        assert!(matches!(rx.recv().await, Some(Event::Closed)));
        epoch.advance();
        assert!(observer.is_terminated(), "后续协商不得复位终止状态");
    }

    #[test]
    fn observers_share_counter_and_overflow_permanently_invalidates() {
        let epoch = ConnectionEpoch::new();
        let observer = epoch.clone();
        assert_eq!(observer.current(), 1);
        epoch.advance();
        assert_eq!(observer.current(), 2);
        epoch.0.store(u64::MAX, Ordering::SeqCst);
        epoch.advance();
        assert_eq!(observer.current(), 0);
        epoch.advance();
        assert_eq!(observer.current(), 0);
    }
}
