//! 实验企业文件通道；只由Peer内部接入，默认关闭；生产身份和设备验收另行记录。
//! 只能由EnterprisePeer提供已认证Chat/Lease；FileSession是UI代次，不是身份凭据。
//! 宿主负责明确选源/确认发送、选择新的接收路径，复用file_dialogs与file_ui。
//! 关闭顺序：同步request_stop文件，立即由Peer关闭Chat，再等待这里的真实shutdown。
//! 已保存结果必须由原主会话owner结算，不能因旧generation丢弃，也不能自动显示给
//! 下一登录账号/工作区。这里仅保留内存回执，不实现跨身份转发、持久存储或加密。
use crate::{enterprise_peer::LeaseObserver, file_dialogs};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use surreal_ck_peer_transport::{
    chat::{Chat, MAX_BINARY_BYTES},
    transfer::{CancelOutcome, CloseReport, CommittedFile, Event, Transfer},
};
use tokio::sync::{mpsc, oneshot, watch};

const COMMAND_CAPACITY: usize = 32;
const NOTICE_CAPACITY: usize = 64;
const LEASE_POLL: Duration = Duration::from_millis(100);

/// 仅绑定UI代次与一次本地attach，不代表任何授权或成员身份。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FileSession {
    generation: u64,
    instance: u64,
}
#[derive(Clone, Debug)]
pub(crate) struct FileContext {
    pub(crate) session: FileSession,
    pub(crate) lease: LeaseObserver,
    stopped: watch::Receiver<bool>,
}
impl FileContext {
    /// 仅过滤普通操作/进度。禁止用此方法丢弃FileClosure里的已保存事实。
    pub(crate) fn is_current(&self, session: FileSession) -> bool {
        self.session == session && self.lease.is_active() && !*self.stopped.borrow()
    }
}
pub(crate) struct FileNotice {
    pub(crate) context: FileContext,
    pub(crate) event: Event,
}
pub(crate) struct FileReply<T> {
    pub(crate) context: FileContext,
    /// offer成功只返回待对方确认的ID，绝不等于已送达。
    pub(crate) result: Result<T, String>,
}
#[derive(Clone)]
pub(crate) struct FileClosure {
    pub(crate) context: FileContext,
    pub(crate) result: Result<CloseReport, String>,
    /// shutdown结束后读取的已确认账本；Err时不保证所有发布结果均已查明。
    pub(crate) known_committed: Vec<CommittedFile>,
    pub(crate) cleanup_error: Option<String>,
    pub(crate) stop_reason: Option<String>,
}
impl std::fmt::Debug for FileClosure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 防止CloseOutcome的调试输出带出原会话私有文件名/路径。
        f.debug_struct("FileClosure")
            .field("session", &self.context.session)
            .field("confirmed", &self.confirmed())
            .field("committed_count", &self.committed().len())
            .finish_non_exhaustive()
    }
}

impl FileClosure {
    pub(crate) fn confirmed(&self) -> bool {
        self.result.is_ok() && self.cleanup_error.is_none()
    }
    /// 只供原主会话owner结算/提示；不得自动跨登录身份或工作区展示这些路径。
    pub(crate) fn committed(&self) -> &[CommittedFile] {
        self.result
            .as_ref()
            .map_or(self.known_committed.as_slice(), |report| {
                report.committed.as_slice()
            })
    }
}

struct PendingOffer {
    id: String,
    size: u64,
}
struct Shared {
    context: FileContext,
    transfer: Transfer,
    stop: watch::Sender<bool>,
    closure: watch::Receiver<Option<FileClosure>>,
    pending: Mutex<Option<PendingOffer>>,
    reason: Mutex<Option<String>>,
    runtime: tokio::runtime::Handle,
}
impl Shared {
    fn request_stop(&self) {
        // 不依赖共享lease变化，也不等待命令队列、磁盘锁或UI消费。
        self.stop.send_replace(true);
        self.transfer.request_stop();
    }
    fn stop_with_reason(&self, reason: String) {
        self.reason
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_insert(reason);
        self.request_stop();
    }
    fn ensure_active(&self) -> Result<(), String> {
        if !self.context.lease.is_active() {
            self.stop_with_reason("成员会话已失效，文件通道已请求停止".into());
        }
        if *self.stop.borrow() {
            Err("文件通道已停止或正在停止，操作未获准".into())
        } else {
            Ok(())
        }
    }
    fn reply<T>(&self, result: Result<T, String>) -> FileReply<T> {
        FileReply {
            context: self.context.clone(),
            result,
        }
    }
    async fn closure(&self) -> FileClosure {
        let mut closure = self.closure.clone();
        loop {
            if let Some(result) = closure.borrow_and_update().clone() {
                return result;
            }
            if closure.changed().await.is_err() {
                return FileClosure {
                    context: self.context.clone(),
                    result: Err("文件关闭owner退出，真实清理未确认".into()),
                    known_committed: self.transfer.known_committed(),
                    cleanup_error: Some("文件关闭回执未返回".into()),
                    stop_reason: self
                        .reason
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone(),
                };
            }
        }
    }
}
async fn stopped(mut stop: watch::Receiver<bool>) {
    loop {
        if *stop.borrow_and_update() {
            return;
        }
        if stop.changed().await.is_err() {
            return;
        }
    }
}

enum Operation {
    Offer(PathBuf, oneshot::Sender<Result<String, String>>),
    Accept(String, PathBuf, oneshot::Sender<Result<(), String>>),
    Reject(String, oneshot::Sender<Result<(), String>>),
    Binary(Vec<u8>),
}
struct Cancellation {
    id: String,
    reply: oneshot::Sender<Result<CancelOutcome, String>>,
}
#[derive(Clone)]
pub(crate) struct FileHandle {
    shared: Arc<Shared>,
    commands: mpsc::Sender<Operation>,
    cancellations: mpsc::Sender<Cancellation>,
}
impl FileHandle {
    pub(crate) fn session(&self) -> FileSession {
        self.shared.context.session
    }
    pub(crate) fn is_active(&self) -> bool {
        self.shared.context.is_current(self.session())
    }
    /// UI失效也可同步撤销文件准入；真实清理仍由原owner独立完成并返回回执。
    pub(crate) fn request_stop(&self) {
        self.shared.request_stop();
    }
    async fn command<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<T, String>>) -> Operation,
    ) -> FileReply<T> {
        if let Err(error) = self.shared.ensure_active() {
            return self.shared.reply(Err(error));
        }
        let (reply, result) = oneshot::channel();
        if self.commands.try_send(make(reply)).is_err() {
            return self
                .shared
                .reply(Err("文件命令队列已满或关闭，请等待当前操作结束".into()));
        }
        // 入队不是成功。调用方future被drop不取消已经开始的磁盘清理。
        self.shared.reply(
            result
                .await
                .unwrap_or_else(|_| Err("文件操作未返回确认；请查看原会话关闭回执".into())),
        )
    }
    /// 仅在用户选择本地源文件并明确确认发送后调用；宿主负责SAF源文件的保留与释放。
    pub(crate) async fn offer_confirmed(&self, source: PathBuf) -> FileReply<String> {
        self.command(|reply| Operation::Offer(source, reply)).await
    }
    /// destination必须来自用户批准的新路径；不得把远端文件名直接当完整路径。
    pub(crate) async fn accept_confirmed(&self, id: String, destination: PathBuf) -> FileReply<()> {
        self.command(|reply| Operation::Accept(id, destination, reply))
            .await
    }
    pub(crate) async fn reject(&self, id: String) -> FileReply<()> {
        self.command(|reply| Operation::Reject(id, reply)).await
    }
    pub(crate) async fn cancel(&self, id: String) -> FileReply<CancelOutcome> {
        if let Err(error) = self.shared.ensure_active() {
            return self.shared.reply(Err(error));
        }
        let (reply, result) = oneshot::channel();
        if self
            .cancellations
            .try_send(Cancellation { id, reply })
            .is_err()
        {
            // 停止意图不能因控制队列满而丢弃；保守停止整个文件会话，仍不谎报完成。
            self.shared
                .stop_with_reason("取消控制队列已满或关闭，整个文件会话已请求停止".into());
            return self.shared.reply(Err(
                "取消未能排队，整个文件会话已请求停止；请等待关闭回执".into()
            ));
        }
        self.shared.reply(
            result
                .await
                .unwrap_or_else(|_| Err("文件取消未返回确认，请查看原会话关闭回执".into())),
        )
    }
    /// Peer必须按Chat Binary到达顺序调用；本返回值仅表示入队，不表示文件已处理/送达。
    /// 只路由文件协议帧；过长/满队列失去可靠顺序时立即停止文件，不丢帧继续。
    pub(crate) fn binary(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.shared.ensure_active()?;
        if bytes.is_empty() || bytes.len() > MAX_BINARY_BYTES {
            self.shared
                .stop_with_reason("文件帧大小无效，文件通道已停止".into());
            return Err("文件帧大小无效".into());
        }
        if self.commands.try_send(Operation::Binary(bytes)).is_err() {
            self.shared
                .stop_with_reason("文件帧队列已满或关闭，不能确认后续帧顺序".into());
            return Err("文件帧未入队，文件通道已请求停止".into());
        }
        Ok(())
    }
    /// 独立于显示队列保存；等待不会发起停止，原主会话owner仍须结算并呈现此回执。
    #[allow(dead_code)] // 显式等待接口保留给原会话owner；当前UI采用独立observe_closed。
    pub(crate) async fn closed_receipt(&self) -> FileClosure {
        self.shared.closure().await
    }
    /// 与NSH组件生命周期独立；用于原会话私有结算与确认后释放SAF源，不能写UI信号。
    pub(crate) fn observe_closed(&self, observer: impl FnOnce(FileClosure) + Send + 'static) {
        let shared = self.shared.clone();
        self.shared.runtime.spawn(async move {
            let closure = shared.closure().await;
            observer(closure);
        });
    }
}

/// 唯一生命周期owner，不可Clone；不得向UI暴露Chat或Transfer。
pub(crate) struct FileOwner {
    shared: Arc<Shared>,
}
impl FileOwner {
    /// 只能由EnterprisePeer内部提供已认证的Chat与只读lease，不能接受UI伪造的连接。
    pub(crate) fn attach(
        chat: Arc<Chat>,
        lease: LeaseObserver,
        generation: u64,
    ) -> Result<(Self, FileHandle, mpsc::Receiver<FileNotice>), String> {
        if !lease.is_active() || chat.termination_observer().is_terminated() {
            return Err("成员或连接已失效，不能建立文件通道".into());
        }
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| "文件通道需要运行中的后台owner".to_owned())?;
        static SERIAL: AtomicU64 = AtomicU64::new(1);
        let instance = SERIAL
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |old| old.checked_add(1))
            .map_err(|_| "文件会话代次已耗尽，请重新启动应用".to_owned())?;
        let (stop, stopped_rx) = watch::channel(false);
        let context = FileContext {
            session: FileSession {
                generation,
                instance,
            },
            lease,
            stopped: stopped_rx,
        };
        let (events, event_rx) = mpsc::channel(NOTICE_CAPACITY);
        let (notice_tx, notices) = mpsc::channel(NOTICE_CAPACITY);
        let (commands, command_rx) = mpsc::channel(COMMAND_CAPACITY);
        let (cancellations, cancellation_rx) = mpsc::channel(1);
        let (closure_tx, closure) = watch::channel(None);
        let termination = chat.termination_observer();
        let shared = Arc::new(Shared {
            context,
            transfer: Transfer::new(chat, events),
            stop,
            closure,
            pending: Mutex::new(None),
            reason: Mutex::new(None),
            runtime: runtime.clone(),
        });
        let worker = runtime.spawn(commands_worker(shared.clone(), command_rx));
        let cancellation_worker =
            runtime.spawn(cancellations_worker(shared.clone(), cancellation_rx));
        let event_worker = runtime.spawn(events_worker(shared.clone(), event_rx, notice_tx));
        let lifecycle = shared.clone();
        // 此owner在attach时即独立启动；shutdown等待者被drop绝不取消它。
        runtime.spawn(async move {
            loop {
                if *lifecycle.stop.borrow() {
                    break;
                }
                if !lifecycle.context.lease.is_active() || termination.is_terminated() {
                    lifecycle.stop_with_reason("成员或连接已失效，文件通道已请求停止".into());
                    break;
                }
                if worker.is_finished()
                    || event_worker.is_finished()
                    || cancellation_worker.is_finished()
                {
                    lifecycle.stop_with_reason("文件处理任务已结束，文件通道已请求停止".into());
                    break;
                }
                tokio::select! {
                    biased;
                    _=stopped(lifecycle.stop.subscribe())=>break,
                    _=tokio::time::sleep(LEASE_POLL)=>{},
                }
            }
            lifecycle.request_stop();
            // 不abort任何清理。泵已由stop解除事件背压；磁盘系统调用可能无法限时结束。
            let command_result = worker.await;
            let event_result = event_worker.await;
            let cancellation_result = cancellation_worker.await;
            let result = lifecycle.transfer.shutdown().await;
            let known_committed = lifecycle.transfer.known_committed();
            let cleanup_error = match (command_result, event_result, cancellation_result) {
                (Ok(()), Ok(()), Ok(())) => None,
                _ => Some("文件处理任务异常退出，宿主清理未完全确认".into()),
            };
            let stop_reason = lifecycle
                .reason
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            closure_tx.send_replace(Some(FileClosure {
                context: lifecycle.context.clone(),
                result,
                known_committed,
                cleanup_error,
                stop_reason,
            }));
        });
        Ok((
            Self {
                shared: shared.clone(),
            },
            FileHandle {
                shared,
                commands,
                cancellations,
            },
            notices,
        ))
    }
    pub(crate) fn request_stop(&self) {
        self.shared.request_stop();
    }
    /// 同步请求停止后返回独立等待future；未poll/drop该future也不会终止真实清理。
    /// 本模块不关闭Chat，Peer唯一关闭owner必须立即独立阻断网络。
    pub(crate) fn shutdown(&self) -> impl Future<Output = FileClosure> + Send + 'static {
        self.request_stop();
        let shared = self.shared.clone();
        async move { shared.closure().await }
    }
}
impl Drop for FileOwner {
    fn drop(&mut self) {
        self.request_stop();
    }
}

async fn commands_worker(shared: Arc<Shared>, mut commands: mpsc::Receiver<Operation>) {
    loop {
        let operation = tokio::select! {
            biased;
            _=stopped(shared.stop.subscribe())=>None,
            operation=commands.recv()=>operation,
        };
        let Some(operation) = operation else {
            break;
        };
        if shared.ensure_active().is_err() {
            break;
        }
        // 一旦开始磁盘操作，不通过select/abort丢弃其future；停止由Transfer协作完成。
        match operation {
            Operation::Offer(source, reply) => {
                if reply.is_closed() {
                    continue;
                }
                let result = if file_dialogs::available() {
                    shared.transfer.offer(source).await
                } else {
                    Err("当前平台文件宿主未启用".into())
                };
                let _ = reply.send(result);
            }
            Operation::Accept(id, destination, reply) => {
                if reply.is_closed() {
                    continue;
                }
                let allowed = {
                    let pending = shared.pending.lock().unwrap_or_else(|e| e.into_inner());
                    match pending.as_ref().filter(|offer| offer.id == id) {
                        None => Err("没有匹配的已展示待确认文件".to_owned()),
                        Some(_) if !file_dialogs::can_receive() => {
                            Err(file_dialogs::receive_unavailable_reason().into())
                        }
                        Some(offer) if !file_dialogs::receive_size_supported(offer.size) => {
                            Err(file_dialogs::RECEIVE_TOO_LARGE.into())
                        }
                        Some(_) => Ok(()),
                    }
                };
                let result = match allowed {
                    Ok(()) => shared.transfer.accept(&id, destination).await,
                    Err(error) => Err(error),
                };
                let _ = reply.send(result);
            }
            Operation::Reject(id, reply) => {
                if reply.is_closed() {
                    continue;
                }
                let _ = reply.send(shared.transfer.reject(&id).await);
            }
            Operation::Binary(bytes) => {
                if let Err(error) = shared.transfer.handle_binary(&bytes).await {
                    shared.stop_with_reason(format!("文件协议处理失败：{error}"));
                    break;
                }
            }
        }
    }
    // 丢弃尚未执行的操作，其oneshot返回未确认，不能被误当成功。
    commands.close();
    drop(commands);
    shared.request_stop();
}
// 取消不排在可能受UI背压或磁盘I/O阻塞的Binary泵之后。
// 独立容量1控制泵由同一关闭owner等待，不创建不受跟踪的临时任务。
async fn cancellations_worker(
    shared: Arc<Shared>,
    mut cancellations: mpsc::Receiver<Cancellation>,
) {
    loop {
        let cancellation = tokio::select! {
            biased;
            _=stopped(shared.stop.subscribe())=>None,
            cancellation=cancellations.recv()=>cancellation,
        };
        let Some(Cancellation { id, reply }) = cancellation else {
            break;
        };
        if shared.ensure_active().is_err() {
            break;
        }
        // 已入队的停止请求仍须执行；UI丢弃等待future不撤销取消意图。
        // 与Offer/Accept不同，不能因reply接收端消失而跳过安全停止。
        let result = shared.transfer.cancel_outcome(&id).await;
        let _ = reply.send(result);
    }
    cancellations.close();
    drop(cancellations);
    shared.request_stop();
}

async fn events_worker(
    shared: Arc<Shared>,
    mut events: mpsc::Receiver<Event>,
    notices: mpsc::Sender<FileNotice>,
) {
    loop {
        let event = tokio::select! {
            biased;
            _=stopped(shared.stop.subscribe())=>None,
            event=events.recv()=>event,
        };
        let Some(event) = event else {
            break;
        };
        {
            let mut pending = shared.pending.lock().unwrap_or_else(|e| e.into_inner());
            match &event {
                Event::Offer { id, size, .. } => {
                    *pending = Some(PendingOffer {
                        id: id.clone(),
                        size: *size,
                    })
                }
                Event::Progress { id, .. }
                | Event::Completed { id, .. }
                | Event::Cancelled { id }
                    if pending.as_ref().is_some_and(|offer| offer.id == *id) =>
                {
                    *pending = None
                }
                Event::Error { id: Some(id), .. }
                    if pending.as_ref().is_some_and(|offer| offer.id == *id) =>
                {
                    *pending = None
                }
                _ => {}
            }
        }
        let notice = FileNotice {
            context: shared.context.clone(),
            event,
        };
        let sent = tokio::select! {
            biased;
            _=stopped(shared.stop.subscribe())=>false,
            result=notices.send(notice)=>result.is_ok(),
        };
        if !sent {
            break;
        }
    }
    // 先丢弃接收端，解除core终态通知背压；可靠已保存事实来自独立CloseReport。
    drop(events);
    shared.request_stop();
}

#[cfg(test)]
mod tests {
    use super::*;
    use surreal_ck_peer_transport::Route;

    async fn isolated() -> (FileOwner, FileHandle, mpsc::Receiver<FileNotice>, Arc<Chat>) {
        let (chat, events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        drop(events);
        let chat = Arc::new(chat);
        let (owner, handle, notices) =
            FileOwner::attach(chat.clone(), LeaseObserver::test_only(true), 7).unwrap();
        (owner, handle, notices, chat)
    }
    #[tokio::test]
    async fn owner_drop_stops_handle_even_if_shared_lease_is_still_active() {
        let (owner, handle, _notices, chat) = isolated().await;
        assert!(handle.is_active());
        drop(owner);
        assert!(handle.shared.context.lease.is_active());
        assert!(!handle.is_active());
        assert!(handle.binary(vec![1]).is_err());
        let closed = tokio::time::timeout(Duration::from_secs(1), handle.closed_receipt())
            .await
            .unwrap();
        assert!(closed.confirmed());
        assert!(closed.committed().is_empty());
        chat.close().await.unwrap();
    }
    #[tokio::test]
    async fn unpolled_shutdown_still_completes_and_retains_original_context() {
        let (owner, handle, _notices, chat) = isolated().await;
        let session = handle.session();
        drop(owner.shutdown());
        let first = tokio::time::timeout(Duration::from_secs(1), handle.closed_receipt())
            .await
            .unwrap();
        let second = owner.shutdown().await;
        assert!(first.confirmed() && second.confirmed());
        assert_eq!(first.context.session, session);
        assert_eq!(first.result, second.result);
        chat.close().await.unwrap();
    }
    #[tokio::test]
    async fn invalid_binary_stops_admission_instead_of_dropping_and_continuing() {
        let (owner, handle, _notices, chat) = isolated().await;
        assert!(handle.binary(vec![0; MAX_BINARY_BYTES + 1]).is_err());
        assert!(!handle.is_active());
        let closed = owner.shutdown().await;
        assert!(closed.confirmed());
        assert!(closed.stop_reason.is_some());
        chat.close().await.unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn full_cancel_queue_stops_whole_session_without_claiming_completion() {
        let (owner, handle, _notices, chat) = isolated().await;
        let (reply, _result) = oneshot::channel();
        // 同一线程内不yield，确定控制泵尚未取走唯一槽位。
        handle
            .cancellations
            .try_send(Cancellation {
                id: "11".repeat(16),
                reply,
            })
            .unwrap_or_else(|_| panic!("测试队列应为空"));
        let reply = handle.cancel("22".repeat(16)).await;
        assert!(reply.result.is_err());
        assert!(!handle.is_active());
        assert!(
            handle.shared.context.lease.is_active(),
            "不能只依赖共享lease关闭"
        );
        let closed = tokio::time::timeout(Duration::from_secs(1), owner.shutdown())
            .await
            .unwrap();
        assert!(closed.confirmed());
        assert!(
            closed
                .stop_reason
                .as_deref()
                .unwrap()
                .contains("取消控制队列")
        );
        assert!(closed.committed().is_empty());
        chat.close().await.unwrap();
    }
    #[tokio::test]
    async fn queued_cancel_executes_after_ui_drops_its_reply_future() {
        let (owner, handle, mut notices, chat) = isolated().await;
        let id = "11".repeat(16);
        // 只构造本地真实core的待确认OFFER，不创建测试Transfer或模拟取消成功。
        let mut offer = b"CKF1".to_vec();
        offer.push(1);
        offer.extend_from_slice(&[0x11; 16]);
        offer.extend_from_slice(&0_u64.to_be_bytes());
        offer.extend_from_slice(&[0; 32]);
        offer.extend_from_slice(&1_u16.to_be_bytes());
        offer.extend_from_slice(b"x");
        handle.shared.transfer.handle_binary(&offer).await.unwrap();
        let notice = tokio::time::timeout(Duration::from_secs(1), notices.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(notice.event, Event::Offer { .. }));
        let (reply, result) = oneshot::channel();
        drop(result);
        handle
            .cancellations
            .try_send(Cancellation {
                id: id.clone(),
                reply,
            })
            .unwrap_or_else(|_| panic!("测试取消应入队"));
        let notice = tokio::time::timeout(Duration::from_secs(1), notices.recv())
            .await
            .unwrap()
            .unwrap();
        // Chat未协商，所以不声称远端收到CANCEL，只验证实际本地取消通知及清理。
        assert_eq!(notice.event, Event::Cancelled { id });
        assert!(handle.shared.pending.lock().unwrap().is_none());
        let closed = owner.shutdown().await;
        assert!(closed.confirmed());
        assert!(closed.committed().is_empty());
        chat.close().await.unwrap();
    }

    #[test]
    fn committed_history_is_kept_but_not_marked_current_for_another_generation() {
        let (stop, stopped) = watch::channel(true);
        let context = FileContext {
            session: FileSession {
                generation: 1,
                instance: 1,
            },
            lease: LeaseObserver::test_only(false),
            stopped,
        };
        let closed = FileClosure {
            context,
            result: Ok(CloseReport {
                cancelled: vec![],
                committed: vec![CommittedFile {
                    id: "original-session".into(),
                    destination: Some(PathBuf::from("private-original-path")),
                }],
            }),
            known_committed: vec![],
            cleanup_error: None,
            stop_reason: None,
        };
        assert!(!closed.context.is_current(FileSession {
            generation: 2,
            instance: 2
        }));
        assert_eq!(closed.committed().len(), 1);
        assert!(!format!("{closed:?}").contains("private-original-path"));
        drop(stop);
    }
    #[test]
    fn failed_shutdown_preserves_known_committed_without_claiming_completion() {
        let (_stop, stopped) = watch::channel(true);
        let receipt = FileClosure {
            context: FileContext {
                session: FileSession {
                    generation: 4,
                    instance: 4,
                },
                lease: LeaseObserver::test_only(false),
                stopped,
            },
            result: Err("另一文件的发布结果尚未确认".into()),
            known_committed: vec![CommittedFile {
                id: "already-verified".into(),
                destination: Some(PathBuf::from("private-earlier-file")),
            }],
            cleanup_error: None,
            stop_reason: None,
        };
        assert!(!receipt.confirmed());
        assert_eq!(receipt.committed().len(), 1);
        assert!(receipt.result.is_err());
        assert!(!format!("{receipt:?}").contains("private-earlier-file"));
    }
}
