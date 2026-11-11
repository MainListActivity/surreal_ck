//! 已连接 Chat 上的文件会话。宿主必须显式批准目标路径，并持续消费事件。
//! DTLS 加密不等于企业用户认证；宿主负责验证对端与信令归属。
//! 不传输远端路径；仅在接收方校验、原子无覆盖保存并 ACK 后报告发送成功。
use crate::{chat::Chat, file};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch, Mutex};

#[cfg(any(target_os = "linux", target_os = "android"))]
#[path = "transfer_destination.rs"]
mod destination;
// 候选桌面后端仅在本crate单元测试中接入真实传输层，绝不进入生产library。
#[cfg(all(test, target_os = "macos"))]
#[path = "transfer_destination_macos.rs"]
mod destination;
#[cfg(all(test, target_os = "windows"))]
#[path = "transfer_destination_windows.rs"]
mod destination;
#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    all(test, any(target_os = "macos", target_os = "windows"))
)))]
mod destination {
    use std::{fs::File, path::PathBuf};
    pub(super) struct Destination;
    impl Destination {
        pub(super) fn prepare(_: PathBuf) -> Result<(Self, File), String> {
            Err("secure file receiving is not supported on this platform yet".into())
        }
        pub(super) fn publish_tracked(self, _: &File, _: &mut bool) -> Result<PathBuf, String> {
            Err("secure file receiving is not supported on this platform yet".into())
        }
    }
}

/// 平台是否实现安全接收。具体目标文件系统仍需在accept时支持匿名临时文件。
/// 不影响发送；未适配平台不得退回可由本地目录写入者替换的命名.part路径。
pub fn receive_supported() -> bool {
    cfg!(any(target_os = "linux", target_os = "android"))
}

const MAGIC: &[u8; 4] = b"CKF1";
const HEADER: usize = 21;
const MAX_NAME: usize = 255;
const WAIT: Duration = Duration::from_secs(30);
const OFFER: u8 = 1;
const ACCEPT: u8 = 2;
const REJECT: u8 = 3;
const CHUNK: u8 = 4;
const CHUNK_ACK: u8 = 5;
const FINISH: u8 = 6;
const COMPLETE: u8 = 7;
const CANCEL: u8 = 8;
type Id = [u8; 16];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Offer {
        id: String,
        name: String,
        size: u64,
    },
    Progress {
        id: String,
        done: u64,
        total: u64,
    },
    Completed {
        id: String,
        destination: Option<PathBuf>,
    },
    /// 仅表示本地传输已停止；不能据此断言对端尚未保存。
    Cancelled {
        id: String,
    },
    Error {
        id: Option<String>,
        message: String,
    },
}
/// 取消与发布竞争的真实结果；发布准入已先发生时不能声称撤回文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelOutcome {
    Cancelled,
    CommitInProgress,
    Completed { destination: Option<PathBuf> },
    PublicationUncertain { message: String },
    NotActive,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedFile {
    pub id: String,
    pub destination: Option<PathBuf>,
}
/// 只在所有登记工作实际退出后返回；committed 不会被取消或删除。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloseReport {
    pub cancelled: Vec<String>,
    pub committed: Vec<CommittedFile>,
}
#[derive(Clone)]
enum FilePhase {
    Active,
    Cancelled,
    Publishing,
    Completed(Option<PathBuf>),
    PublicationUncertain(String),
    Failed,
}
#[derive(Default)]
struct LifeState {
    stopped: bool,
    jobs: usize,
    per_file_jobs: HashMap<Id, usize>,
    files: HashMap<Id, FilePhase>,
    // UI通知队列不等于用户已看到；保存事实保留至关闭，达到上限拒绝新传输。
    committed: HashMap<Id, Option<PathBuf>>,
    recent: VecDeque<(Id, FilePhase)>,
    fault: bool,
    notices: HashSet<Id>,
    cancel_requested: HashSet<Id>,
    admitted: usize,
    report: Option<CloseReport>,
}
struct Lifecycle {
    // 仅计数、状态与发布准入使用短临界区；里面不做I/O，不等待Tokio锁。
    state: StdMutex<LifeState>,
    changed: watch::Sender<u64>,
    #[cfg(test)]
    pauses: StdMutex<HashMap<&'static str, TestPause>>,
}
struct Work {
    life: Arc<Lifecycle>,
    id: Option<Id>,
}
// 返回值可能持有FD；被取消的调用方丢弃结果时，先drop值，再归还工作登记。
struct BlockingResult<T> {
    value: T,
    _registered: Work,
}
impl Drop for Work {
    fn drop(&mut self) {
        let mut state = self.life.state.lock().unwrap_or_else(|e| e.into_inner());
        if std::thread::panicking() {
            state.fault = true;
        }
        state.jobs -= 1;
        if let Some(id) = self.id {
            if let Some(count) = state.per_file_jobs.get_mut(&id) {
                *count -= 1;
                if *count == 0 {
                    state.per_file_jobs.remove(&id);
                }
            }
        }
        drop(state);
        self.life.wake();
    }
}
impl Lifecycle {
    fn new() -> Arc<Self> {
        let (changed, _) = watch::channel(0);
        Arc::new(Self {
            state: StdMutex::new(LifeState::default()),
            changed,
            #[cfg(test)]
            pauses: StdMutex::new(HashMap::new()),
        })
    }
    fn wake(&self) {
        self.changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }
    fn work(self: &Arc<Self>, id: Option<Id>, child: bool) -> Result<Work, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if (state.stopped || state.fault) && !child {
            return Err("file session stopped".into());
        }
        // child仅从仍持Work的调用创建，必须在spawn之前登记。
        state.jobs += 1;
        if let Some(id) = id {
            *state.per_file_jobs.entry(id).or_default() += 1;
        }
        Ok(Work {
            life: self.clone(),
            id,
        })
    }
    fn register(&self, id: Id) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.stopped
            || state.fault
            || state.files.contains_key(&id)
            || state.committed.contains_key(&id)
            || state.cancel_requested.contains(&id)
            || state.admitted >= 256
        {
            return Err("file session stopped, duplicate transfer, or 256 transfer receipts retained; close before more transfers".into());
        }
        state.admitted += 1;
        state.files.insert(id, FilePhase::Active);
        Ok(())
    }
    fn active(&self, id: Id) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        !state.stopped && matches!(state.files.get(&id), Some(FilePhase::Active))
    }
    fn stopped(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).stopped
    }
    fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.stopped = true;
        for phase in state.files.values_mut() {
            if matches!(phase, FilePhase::Active) {
                *phase = FilePhase::Cancelled;
            }
        }
        drop(state);
        self.wake();
    }
    async fn until_stopped(&self) {
        let mut changed = self.changed.subscribe();
        loop {
            if self.stopped() {
                return;
            }
            let _ = changed.changed().await;
        }
    }
    async fn idle(&self, id: Option<Id>) {
        let mut changed = self.changed.subscribe();
        loop {
            let idle = {
                let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                id.map_or(state.jobs == 0, |id| {
                    state.per_file_jobs.get(&id).copied().unwrap_or(0) == 0
                })
            };
            if idle {
                return;
            }
            let _ = changed.changed().await;
        }
    }
    fn cancel(&self, id: Id) -> CancelOutcome {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.files.contains_key(&id) || state.committed.contains_key(&id) {
            // 取消请求单调保留；后来收到真实保存ACK也不能恢复已阻塞的工作。
            state.cancel_requested.insert(id);
        }
        let phase = if let Some(phase) = state.files.get_mut(&id) {
            if matches!(phase, FilePhase::Active) {
                *phase = FilePhase::Cancelled;
            }
            Some(phase.clone())
        } else if let Some(destination) = state.committed.get(&id) {
            Some(FilePhase::Completed(destination.clone()))
        } else {
            state
                .recent
                .iter()
                .rev()
                .find(|(old, _)| old == &id)
                .map(|(_, phase)| phase.clone())
        };
        drop(state);
        self.wake();
        match phase {
            Some(FilePhase::Cancelled) => CancelOutcome::Cancelled,
            Some(FilePhase::Publishing) => CancelOutcome::CommitInProgress,
            Some(FilePhase::Completed(destination)) => CancelOutcome::Completed { destination },
            Some(FilePhase::PublicationUncertain(message)) => {
                CancelOutcome::PublicationUncertain { message }
            }
            _ => CancelOutcome::NotActive,
        }
    }
    fn admit_publish(&self, id: Id) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.stopped || !matches!(state.files.get(&id), Some(FilePhase::Active)) {
            return Err("file publication cancelled before commit".into());
        }
        state.files.insert(id, FilePhase::Publishing);
        Ok(())
    }
    fn published(&self, id: Id, result: &Result<PathBuf, String>, linked: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let phase = match result {
            Ok(path) => FilePhase::Completed(Some(path.clone())),
            Err(error) if linked => FilePhase::PublicationUncertain(error.clone()),
            Err(_) => FilePhase::Failed,
        };
        if let FilePhase::Completed(destination) = &phase {
            state.committed.insert(id, destination.clone());
        }
        state.files.insert(id, phase);
        drop(state);
        self.wake();
    }
    fn receipt(&self, id: Id) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(
            state.files.get(&id),
            Some(FilePhase::Active | FilePhase::Cancelled)
        ) {
            state.files.insert(id, FilePhase::Completed(None));
            state.committed.insert(id, None);
        }
        drop(state);
        self.wake();
    }
    fn retire(&self, id: Id) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(phase) = state.files.remove(&id) {
            if matches!(phase, FilePhase::PublicationUncertain(_)) {
                state.files.insert(id, phase);
                return;
            }
            if state.recent.len() == 16 {
                state.recent.pop_front();
            }
            state.recent.push_back((id, phase));
        }
        drop(state);
        self.wake();
    }
    fn cancelled(&self, id: Id) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.stopped
            || state.cancel_requested.contains(&id)
            || matches!(state.files.get(&id), Some(FilePhase::Cancelled))
            || state
                .recent
                .iter()
                .any(|(old, phase)| old == &id && matches!(phase, FilePhase::Cancelled))
    }
    async fn until_cancel_requested(&self, id: Id) {
        let mut changed = self.changed.subscribe();
        loop {
            if self.cancelled(id) {
                return;
            }
            let _ = changed.changed().await;
        }
    }
    fn begin_notice(&self, id: Id) -> Result<bool, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.stopped || state.notices.contains(&id) {
            return Ok(false);
        }
        if state.notices.len() >= 256 {
            return Err("file terminal notification backlog is full".into());
        }
        state.notices.insert(id);
        Ok(true)
    }
    fn known_committed(&self) -> Vec<CommittedFile> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut files: Vec<_> = state
            .committed
            .iter()
            .map(|(id, destination)| CommittedFile {
                id: id_string(*id),
                destination: destination.clone(),
            })
            .collect();
        files.sort_by(|a, b| a.id.cmp(&b.id));
        files
    }
    fn report(&self) -> Result<CloseReport, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.jobs != 0 || state.fault {
            return Err("file cleanup is not confirmed".into());
        }
        if let Some(report) = &state.report {
            return Ok(report.clone());
        }
        let mut report = CloseReport::default();
        for (id, phase) in &state.files {
            match phase {
                FilePhase::Completed(_) => {}
                FilePhase::Publishing | FilePhase::PublicationUncertain(_) => {
                    return Err(
                        "file publication outcome is uncertain; a verified file may already exist"
                            .into(),
                    );
                }
                _ => report.cancelled.push(id_string(*id)),
            }
        }
        report.committed = state
            .committed
            .iter()
            .map(|(id, destination)| CommittedFile {
                id: id_string(*id),
                destination: destination.clone(),
            })
            .collect();
        report.cancelled.sort();
        report.committed.sort_by(|a, b| a.id.cmp(&b.id));
        state.report = Some(report.clone());
        Ok(report)
    }
}

#[cfg(test)]
struct TestPause {
    entered: tokio::sync::oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}
#[cfg(test)]
impl Lifecycle {
    fn pause(&self, point: &'static str) {
        let pause = self.pauses.lock().unwrap().remove(point);
        if let Some(pause) = pause {
            let _ = pause.entered.send(());
            pause
                .release
                .recv_timeout(Duration::from_secs(10))
                .expect("测试闸门未释放");
        }
    }
    fn gate(
        &self,
        point: &'static str,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (entered, wait) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        self.pauses.lock().unwrap().insert(
            point,
            TestPause {
                entered,
                release: blocked,
            },
        );
        (wait, release)
    }
}

#[derive(Clone)]
struct Metadata {
    id: Id,
    name: String,
    size: u64,
    hash: [u8; 32],
}
struct Receiving {
    metadata: Metadata,
    receiver: file::Receiver<File>,
    destination: destination::Destination,
    done: u64,
}
enum Incoming {
    Pending(Metadata),
    Receiving(Box<Receiving>),
}
impl Incoming {
    fn id(&self) -> Id {
        match self {
            Self::Pending(m) => m.id,
            Self::Receiving(r) => r.metadata.id,
        }
    }
}
#[derive(Debug)]
enum Signal {
    Accepted,
    ChunkAck,
    Complete,
    Cancel,
}
struct Outgoing {
    id: Id,
    signals: mpsc::Sender<Signal>,
    accepted: bool,
    expected_ack: Option<u64>,
    awaiting_receipt: bool,
}
#[derive(Default)]
struct State {
    incoming: Option<Incoming>,
    outgoing: Option<Outgoing>,
    closed: bool,
    preparing: Option<Id>,
    // 吞掉取消后已在途的少量旧帧，不保留无限历史。
    retired: VecDeque<Id>,
}
impl State {
    fn retire(&mut self, id: Id) {
        if self.retired.len() == 16 {
            self.retired.pop_front();
        }
        self.retired.push_back(id);
    }
}
type CloseResult = Result<CloseReport, String>;
type CloseReceiver = watch::Receiver<Option<CloseResult>>;
struct Inner {
    chat: Arc<Chat>,
    events: mpsc::Sender<Event>,
    state: Mutex<State>,
    lifecycle: Arc<Lifecycle>,
    close_result: StdMutex<Option<CloseReceiver>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.lifecycle.stop();
    }
}
#[derive(Clone)]
pub struct Transfer {
    inner: Arc<Inner>,
}

// Offer调用方被取消时，清理由独立任务继续；不能留下永久busy槽或未跟踪hash。
struct OfferReservation {
    transfer: Transfer,
    id: Id,
    finished: bool,
    maybe_sent: bool,
    runtime: tokio::runtime::Handle,
}
impl OfferReservation {
    fn finish(&mut self) {
        self.finished = true;
    }
}
impl Drop for OfferReservation {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let transfer = self.transfer.clone();
        let id = self.id;
        let maybe_sent = self.maybe_sent;
        transfer.inner.lifecycle.cancel(id);
        let Ok(registered) = transfer.inner.lifecycle.work(None, true) else {
            return;
        };
        self.runtime.spawn(async move {
            let _registered = registered;
            transfer.inner.lifecycle.idle(Some(id)).await;
            transfer.remove(id).await;
            if maybe_sent {
                let _ = transfer.send(CANCEL, id, &[]).await;
            }
            let _ = transfer.notify_terminal(id);
        });
    }
}

fn id_string(id: Id) -> String {
    id.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn parse_id(id: &str) -> Result<Id, String> {
    if id.len() != 32 || !id.is_ascii() {
        return Err("invalid transfer id".into());
    }
    let mut result = [0; 16];
    for (i, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&id[i * 2..i * 2 + 2], 16).map_err(|_| "invalid transfer id")?;
    }
    Ok(result)
}
fn new_id() -> Id {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let mut hash = Sha256::new();
    hash.update(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_be_bytes(),
    );
    hash.update(SERIAL.fetch_add(1, Ordering::Relaxed).to_be_bytes());
    hash.update(std::process::id().to_be_bytes());
    hash.finalize()[..16]
        .try_into()
        .expect("fixed digest length")
}
fn packet(kind: u8, id: Id, data: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER + data.len());
    bytes.extend_from_slice(MAGIC);
    bytes.push(kind);
    bytes.extend_from_slice(&id);
    bytes.extend_from_slice(data);
    bytes
}
fn safe_name(name: &str) -> bool {
    // 名称会成为桌面保存对话框的默认值，必须同时满足各平台的单文件名边界。
    // Windows 的盘符/ADS、设备名与尾点/空格不能作为对端提供的默认目标。
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !reserved
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
}
#[cfg(test)]
fn prepare_source(path: PathBuf) -> Result<(Metadata, File), String> {
    let lifecycle = Lifecycle::new();
    let id = new_id();
    lifecycle.register(id)?;
    prepare_source_checked(path, id, &lifecycle)
}
fn prepare_source_checked(
    path: PathBuf,
    id: Id,
    lifecycle: &Lifecycle,
) -> Result<(Metadata, File), String> {
    if !lifecycle.active(id) {
        return Err("file preparation cancelled".into());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid file name")?
        .to_owned();
    if !safe_name(&name) {
        return Err("invalid file name".into());
    }
    // 非Unix继续保留打开前的类型筛查；所有平台以实际打开FD的metadata为准。
    #[cfg(not(unix))]
    {
        let initial = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if !initial.is_file() || initial.len() > file::MAX_FILE_SIZE {
            return Err("source must be a regular file up to 1 GiB".into());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // 防止本地目录写入者在path检查与open之间换成FIFO而阻塞hash任务。
        // 普通文件忽略NONBLOCK；最终符号链接明确拒绝，不跟随至其它源文件。
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let mut source = options.open(path).map_err(|e| e.to_string())?;
    let info = source.metadata().map_err(|e| e.to_string())?;
    if !info.is_file() || info.len() > file::MAX_FILE_SIZE {
        return Err("source must be a regular file up to 1 GiB".into());
    }
    #[cfg(test)]
    lifecycle.pause("hash");
    let size = info.len();
    let mut hash = Sha256::new();
    let mut buffer = [0; file::CHUNK_SIZE];
    let mut remaining = size;
    while remaining > 0 {
        if !lifecycle.active(id) {
            return Err("file preparation cancelled".into());
        }
        let length = remaining.min(buffer.len() as u64) as usize;
        source
            .read_exact(&mut buffer[..length])
            .map_err(|e| e.to_string())?;
        hash.update(&buffer[..length]);
        remaining -= length as u64;
    }
    if !lifecycle.active(id) {
        return Err("file preparation cancelled".into());
    }
    if source.read(&mut buffer[..1]).map_err(|e| e.to_string())? != 0 {
        return Err("source changed while hashing".into());
    }
    source.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    Ok((
        Metadata {
            id,
            name,
            size,
            hash: hash.finalize().into(),
        },
        source,
    ))
}
fn prepare_destination(metadata: Metadata, destination: PathBuf) -> Result<Receiving, String> {
    let (destination, writer) = destination::Destination::prepare(destination)?;
    let receiver =
        file::Receiver::new(writer, metadata.size, metadata.hash).map_err(|e| e.to_string())?;
    Ok(Receiving {
        metadata,
        receiver,
        destination,
        done: 0,
    })
}
fn finalize(receiving: Receiving, lifecycle: &Lifecycle) -> Result<PathBuf, String> {
    let id = receiving.metadata.id;
    if !lifecycle.active(id) {
        return Err("file finalization cancelled".into());
    }
    let Receiving {
        receiver,
        destination,
        ..
    } = receiving;
    let writer = receiver.finish().map_err(|e| e.to_string())?;
    writer.sync_all().map_err(|e| e.to_string())?;
    // 发布准入是线性化点；其后到达的取消不声称撤回，shutdown等待真实结果。
    #[cfg(test)]
    lifecycle.pause("before_publish");
    lifecycle.admit_publish(id)?;
    #[cfg(test)]
    lifecycle.pause("publishing");
    let mut linked = false;
    let result = destination.publish_tracked(&writer, &mut linked);
    lifecycle.published(id, &result, linked);
    result
}

impl Transfer {
    pub fn new(chat: Arc<Chat>, events: mpsc::Sender<Event>) -> Self {
        Self {
            inner: Arc::new(Inner {
                chat,
                events,
                state: Mutex::new(State::default()),
                lifecycle: Lifecycle::new(),
                close_result: StdMutex::new(None),
            }),
        }
    }
    async fn emit(&self, event: Event) -> bool {
        let id = match &event {
            Event::Offer { id, .. }
            | Event::Progress { id, .. }
            | Event::Completed { id, .. }
            | Event::Cancelled { id } => parse_id(id).ok(),
            Event::Error { id, .. } => id.as_deref().and_then(|id| parse_id(id).ok()),
        };
        if matches!(&event, Event::Cancelled { .. } | Event::Completed { .. }) {
            return id.is_some_and(|id| self.notify_terminal(id).is_ok());
        }
        let cancelled = async {
            match id {
                Some(id) => self.inner.lifecycle.until_cancel_requested(id).await,
                None => self.inner.lifecycle.until_stopped().await,
            }
        };
        tokio::select! {
            biased;
            _=cancelled=>false,
            result=self.inner.events.send(event)=>result.is_ok(),
        }
    }
    fn notify_terminal(&self, id: Id) -> Result<(), String> {
        if !self.inner.lifecycle.begin_notice(id)? {
            return Ok(());
        }
        let registered = self.inner.lifecycle.work(None, true)?;
        let lifecycle = self.inner.lifecycle.clone();
        let events = self.inner.events.clone();
        // 终态通知不占该文件的idle计数，最多256个待处理ID；关闭打断容量等待。
        tokio::spawn(async move {
            let _registered = registered;
            let permit = tokio::select! {
                biased;
                _=lifecycle.until_stopped()=>None,
                result=async {lifecycle.idle(Some(id)).await;events.reserve().await}=>result.ok(),
            };
            // 拿到容量后才读真实账本，并把去重释放与入队放在同一短临界区。
            // 若receipt后到，它必看到已释放的notice，能再排Completed而不会丢失更新。
            let mut state = lifecycle.state.lock().unwrap_or_else(|e| e.into_inner());
            state.notices.remove(&id);
            if let Some(permit) = permit.filter(|_| !state.stopped) {
                let event = if let Some(destination) = state.committed.get(&id) {
                    Some(Event::Completed {
                        id: id_string(id),
                        destination: destination.clone(),
                    })
                } else if state.cancel_requested.contains(&id)
                    || matches!(state.files.get(&id), Some(FilePhase::Cancelled))
                    || state
                        .recent
                        .iter()
                        .any(|(old, phase)| old == &id && matches!(phase, FilePhase::Cancelled))
                {
                    Some(Event::Cancelled { id: id_string(id) })
                } else {
                    None
                };
                if let Some(event) = event {
                    permit.send(event);
                }
            }
        });
        Ok(())
    }
    async fn send(&self, kind: u8, id: Id, payload: &[u8]) -> Result<(), String> {
        if self.inner.lifecycle.stopped() {
            return Err("file session stopped".into());
        }
        if kind == COMPLETE {
            let state = self
                .inner
                .lifecycle
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if !state.committed.get(&id).is_some_and(Option::is_some) {
                return Err("completion acknowledgement requires a verified saved file".into());
            }
        }
        let bytes = packet(kind, id, payload);
        let cancelled = async {
            // 已保存ACK不能被后来单文件取消吞掉；全局停止依旧优先阻断网络。
            if matches!(kind, CANCEL | REJECT | COMPLETE) {
                self.inner.lifecycle.until_stopped().await
            } else {
                self.inner.lifecycle.until_cancel_requested(id).await
            }
        };
        tokio::select! {
            biased;
            _=cancelled=>Err("file session stopped or transfer cancelled".into()),
            result=self.inner.chat.send_binary(&bytes)=>result,
        }
    }
    async fn blocking<T: Send + 'static>(
        &self,
        id: Id,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, String> {
        let registered = self.inner.lifecycle.work(Some(id), true)?;
        let result = tokio::task::spawn_blocking(move || {
            let value = work();
            BlockingResult {
                value,
                _registered: registered,
            }
        })
        .await
        .map_err(|_| "file blocking task failed; cleanup must be checked".to_owned())?;
        Ok(result.value)
    }
    /// 只读取/哈希所选文件并发送 metadata；接收方 ACCEPT 前绝不发送内容。
    pub async fn offer(&self, source: PathBuf) -> Result<String, String> {
        let id = new_id();
        let _operation = self.inner.lifecycle.work(Some(id), false)?;
        {
            let mut state = self.inner.state.lock().await;
            if state.closed
                || state.preparing.is_some()
                || state.outgoing.is_some()
                || state.incoming.is_some()
            {
                return Err("session closed or file transfer busy".into());
            }
            self.inner.lifecycle.register(id)?;
            state.preparing = Some(id);
        }
        let mut reservation = OfferReservation {
            transfer: self.clone(),
            id,
            finished: false,
            maybe_sent: false,
            runtime: tokio::runtime::Handle::current(),
        };
        // hash拥有自己的登记，调用方future被取消也不能让shutdown提前返回。
        let lifecycle = self.inner.lifecycle.clone();
        let prepared = self
            .blocking(id, move || prepare_source_checked(source, id, &lifecycle))
            .await;
        let mut state = self.inner.state.lock().await;
        if state.preparing == Some(id) {
            state.preparing = None;
        }
        let (metadata, source) = match prepared {
            Ok(Ok(value)) if !state.closed && self.inner.lifecycle.active(id) => value,
            other => {
                self.inner.lifecycle.retire(id);
                reservation.finish();
                return Err(match other {
                    Ok(Err(error)) | Err(error) => error,
                    _ => "file preparation cancelled".into(),
                });
            }
        };
        let (signals, rx) = mpsc::channel(4);
        state.outgoing = Some(Outgoing {
            id,
            signals,
            accepted: false,
            expected_ack: None,
            awaiting_receipt: false,
        });
        drop(state);
        let mut payload = Vec::with_capacity(42 + metadata.name.len());
        payload.extend_from_slice(&metadata.size.to_be_bytes());
        payload.extend_from_slice(&metadata.hash);
        payload.extend_from_slice(&(metadata.name.len() as u16).to_be_bytes());
        payload.extend_from_slice(metadata.name.as_bytes());
        reservation.maybe_sent = true;
        if let Err(error) = self.send(OFFER, id, &payload).await {
            self.fail(id, error.clone()).await;
            reservation.finish();
            return Err(error);
        }
        let session = self.clone();
        let registered = self.inner.lifecycle.work(Some(id), true)?;
        tokio::spawn(async move {
            let _registered = registered;
            if let Err(error) = session.stream(metadata, source, rx).await {
                session.fail(id, error).await;
            } else if session.inner.lifecycle.cancelled(id) {
                // 偏置取消分支可先于已入队的最终ACK退出；账本保留事实，busy必须释放。
                session.remove(id).await;
            }
        });
        reservation.finish();
        Ok(id_string(id))
    }
    /// 只能由用户明确批准后的宿主调用；destination 为完整文件路径，不能由远端决定。
    /// 路径准备失败仍保留待确认 offer，允许重新选择。
    pub async fn accept(&self, id: &str, destination: PathBuf) -> Result<(), String> {
        let id = parse_id(id)?;
        let _operation = self.inner.lifecycle.work(Some(id), false)?;
        let mut state = self.inner.state.lock().await;
        if !self.inner.lifecycle.active(id) {
            return Err("file session stopped or transfer cancelled".into());
        }
        let metadata = match &state.incoming {
            Some(Incoming::Pending(m)) if m.id == id => m.clone(),
            _ => return Err("no pending incoming offer".into()),
        };
        let lifecycle = self.inner.lifecycle.clone();
        let receiving = self
            .blocking(id, move || -> Result<Receiving, String> {
                if !lifecycle.active(id) {
                    return Err("file receiving cancelled".into());
                }
                let receiving = prepare_destination(metadata, destination)?;
                if !lifecycle.active(id) {
                    return Err("file receiving cancelled".into());
                }
                Ok(receiving)
            })
            .await??;
        if !self.inner.lifecycle.active(id) {
            return Err("file receiving cancelled".into());
        }
        state.incoming = Some(Incoming::Receiving(Box::new(receiving)));
        drop(state);
        if let Err(error) = self.send(ACCEPT, id, &[]).await {
            self.fail(id, error.clone()).await;
            return Err(error);
        }
        Ok(())
    }
    pub async fn reject(&self, id: &str) -> Result<(), String> {
        let id = parse_id(id)?;
        let _operation = self.inner.lifecycle.work(Some(id), false)?;
        let mut state = self.inner.state.lock().await;
        if !matches!(&state.incoming, Some(Incoming::Pending(m)) if m.id == id) {
            return Err("no pending incoming offer".into());
        }
        state.incoming.take();
        state.retire(id);
        self.inner.lifecycle.cancel(id);
        self.inner.lifecycle.retire(id);
        drop(state);
        let notification = self.notify_terminal(id);
        self.send(REJECT, id, &[]).await?;
        notification
    }
    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        match self.cancel_outcome(id).await? {
            CancelOutcome::Cancelled => Ok(()),
            CancelOutcome::CommitInProgress => {
                Err("file publication already started; cancellation cannot retract it".into())
            }
            CancelOutcome::Completed { .. } => {
                Err("file already completed; cancellation cannot retract it".into())
            }
            CancelOutcome::PublicationUncertain { message } => Err(message),
            CancelOutcome::NotActive => Err("no active transfer".into()),
        }
    }
    pub async fn cancel_outcome(&self, id: &str) -> Result<CancelOutcome, String> {
        let id = parse_id(id)?;
        // 本取消请求计入全局工作，但不计入该文件等待，避免等待自身。
        let _operation = self.inner.lifecycle.work(None, false)?;
        let outcome = self.inner.lifecycle.cancel(id);
        if matches!(outcome, CancelOutcome::Completed { .. }) {
            self.inner.lifecycle.idle(Some(id)).await;
            self.remove(id).await;
            self.notify_terminal(id)?;
            return Ok(outcome);
        }
        if outcome != CancelOutcome::Cancelled {
            return Ok(outcome);
        }
        self.inner.lifecycle.idle(Some(id)).await;
        let settled = self.inner.lifecycle.cancel(id);
        if settled != CancelOutcome::Cancelled {
            if matches!(settled, CancelOutcome::Completed { .. }) {
                self.remove(id).await;
                self.notify_terminal(id)?;
            }
            return Ok(settled);
        }
        self.remove(id).await;
        let notification = self.notify_terminal(id);
        self.send(CANCEL, id, &[]).await?;
        notification?;
        Ok(CancelOutcome::Cancelled)
    }
    async fn remove(&self, id: Id) -> bool {
        let mut state = self.inner.state.lock().await;
        let mut removed = false;
        if state.preparing == Some(id) {
            state.preparing = None;
            removed = true;
        }
        if state.incoming.as_ref().is_some_and(|i| i.id() == id) {
            state.incoming.take();
            removed = true;
        }
        if state.outgoing.as_ref().is_some_and(|o| o.id == id) {
            if let Some(outgoing) = state.outgoing.take() {
                let _ = outgoing.signals.try_send(Signal::Cancel);
            }
            removed = true;
        }
        if removed {
            state.retire(id);
            self.inner.lifecycle.retire(id);
        }
        removed
    }
    async fn fail(&self, id: Id, message: String) {
        let cancelled = self.inner.lifecycle.cancelled(id);
        if self.remove(id).await && !cancelled {
            let _ = self.send(CANCEL, id, &[]).await;
            self.emit(Event::Error {
                id: Some(id_string(id)),
                message,
            })
            .await;
        }
    }
    /// 必须按 Chat::Event::Binary 的到达顺序调用，不可为每帧并发 spawn。
    pub async fn handle_binary(&self, bytes: &[u8]) -> Result<(), String> {
        let _operation = self.inner.lifecycle.work(
            if bytes.len() >= HEADER {
                bytes[5..HEADER].try_into().ok()
            } else {
                None
            },
            false,
        )?;
        if bytes.len() < HEADER
            || bytes.len() > crate::chat::MAX_BINARY_BYTES
            || &bytes[..4] != MAGIC
        {
            let error = "invalid file protocol header".to_string();
            self.emit(Event::Error {
                id: None,
                message: error.clone(),
            })
            .await;
            return Err(error);
        }
        let id: Id = bytes[5..HEADER].try_into().expect("checked header length");
        let result = self.handle(bytes[4], id, &bytes[HEADER..]).await;
        if let Err(error) = &result {
            self.fail(id, error.clone()).await;
        }
        result
    }
    async fn handle(&self, kind: u8, id: Id, payload: &[u8]) -> Result<(), String> {
        let mut state = self.inner.state.lock().await;
        if state.closed || self.inner.lifecycle.stopped() {
            return Err("session closed".into());
        }
        if state.retired.contains(&id) {
            return Ok(());
        }
        match kind {
            OFFER => {
                if payload.len() < 42 || payload.len() > 42 + MAX_NAME {
                    return Err("invalid file metadata".into());
                }
                let size = u64::from_be_bytes(payload[..8].try_into().unwrap());
                let name_len = u16::from_be_bytes(payload[40..42].try_into().unwrap()) as usize;
                let name = std::str::from_utf8(&payload[42..]).map_err(|_| "invalid file name")?;
                if size > file::MAX_FILE_SIZE || name_len != name.len() || !safe_name(name) {
                    return Err("invalid file metadata".into());
                }
                if state.preparing.is_some() || state.incoming.is_some() || state.outgoing.is_some()
                {
                    drop(state);
                    self.send(REJECT, id, &[]).await?;
                    return Ok(());
                }
                self.inner.lifecycle.register(id)?;
                state.incoming = Some(Incoming::Pending(Metadata {
                    id,
                    name: name.to_string(),
                    size,
                    hash: payload[8..40].try_into().unwrap(),
                }));
                drop(state);
                self.emit(Event::Offer {
                    id: id_string(id),
                    name: name.to_string(),
                    size,
                })
                .await;
            }
            ACCEPT | CHUNK_ACK | COMPLETE => {
                let outgoing = state
                    .outgoing
                    .as_mut()
                    .filter(|o| o.id == id)
                    .ok_or("unknown outgoing transfer")?;
                let signal = match kind {
                    ACCEPT if payload.is_empty() && !outgoing.accepted => {
                        outgoing.accepted = true;
                        Signal::Accepted
                    }
                    CHUNK_ACK if payload.len() == 8 => {
                        let offset = u64::from_be_bytes(payload.try_into().unwrap());
                        if outgoing.expected_ack != Some(offset) {
                            return Err("invalid chunk acknowledgement".into());
                        }
                        outgoing.expected_ack = None;
                        Signal::ChunkAck
                    }
                    COMPLETE if payload.is_empty() && outgoing.awaiting_receipt => {
                        outgoing.awaiting_receipt = false;
                        self.inner.lifecycle.receipt(id);
                        Signal::Complete
                    }
                    _ => return Err("unexpected file acknowledgement".into()),
                };
                outgoing
                    .signals
                    .try_send(signal)
                    .map_err(|_| "file acknowledgement queue closed or full")?;
            }
            REJECT | CANCEL => {
                if !payload.is_empty() {
                    return Err("invalid cancellation frame".into());
                }
                drop(state);
                let outcome = self.inner.lifecycle.cancel(id);
                if outcome == CancelOutcome::Cancelled && self.remove(id).await {
                    self.emit(Event::Cancelled { id: id_string(id) }).await;
                }
            }
            CHUNK => {
                let Some(incoming) = state.incoming.take() else {
                    return Err("no approved incoming transfer".into());
                };
                let mut receiving = match incoming {
                    Incoming::Receiving(r) if r.metadata.id == id => r,
                    other => {
                        state.incoming = Some(other);
                        return Err(
                            "file bytes arrived before acceptance or for unknown transfer".into(),
                        );
                    }
                };
                let frame = payload.to_vec();
                let lifecycle = self.inner.lifecycle.clone();
                let (receiving_result, result) = self
                    .blocking(id, move || {
                        let result = if !lifecycle.active(id) {
                            Err("file write cancelled".into())
                        } else {
                            receiving
                                .receiver
                                .receive(&frame)
                                .map_err(|e| e.to_string())
                        };
                        if result.is_ok() {
                            receiving.done += (frame.len() - 8) as u64;
                        }
                        (receiving, result)
                    })
                    .await?;
                let done = receiving_result.done;
                let total = receiving_result.metadata.size;
                state.incoming = Some(Incoming::Receiving(receiving_result));
                result?;
                drop(state);
                self.send(CHUNK_ACK, id, &done.to_be_bytes()).await?;
                self.emit(Event::Progress {
                    id: id_string(id),
                    done,
                    total,
                })
                .await;
            }
            FINISH => {
                if !payload.is_empty() {
                    return Err("invalid finish frame".into());
                }
                let Some(incoming) = state.incoming.take() else {
                    return Err("no approved incoming transfer".into());
                };
                let receiving = match incoming {
                    Incoming::Receiving(r) if r.metadata.id == id => r,
                    other => {
                        state.incoming = Some(other);
                        return Err("finish before acceptance or for unknown transfer".into());
                    }
                };
                let lifecycle = self.inner.lifecycle.clone();
                let result = self
                    .blocking(id, move || finalize(*receiving, &lifecycle))
                    .await?;
                state.retire(id);
                drop(state);
                match result {
                    Ok(destination) => {
                        let ack = self.send(COMPLETE, id, &[]).await;
                        if self
                            .emit(Event::Completed {
                                id: id_string(id),
                                destination: Some(destination),
                            })
                            .await
                        {
                            self.inner.lifecycle.retire(id);
                        }
                        ack?;
                    }
                    Err(message) => {
                        let _ = self.send(CANCEL, id, &[]).await;
                        if self
                            .emit(Event::Error {
                                id: Some(id_string(id)),
                                message: message.clone(),
                            })
                            .await
                        {
                            self.inner.lifecycle.retire(id);
                        }
                        return Err(message);
                    }
                }
            }
            _ => return Err("unknown file protocol operation".into()),
        }
        Ok(())
    }
    async fn stream(
        &self,
        metadata: Metadata,
        mut source: File,
        mut signals: mpsc::Receiver<Signal>,
    ) -> Result<(), String> {
        let accepted = tokio::select! {biased;_=self.inner.lifecycle.until_cancel_requested(metadata.id)=>None,value=signals.recv()=>value};
        if !matches!(accepted, Some(Signal::Accepted)) {
            return Ok(());
        }
        let id = metadata.id;
        let mut offset = 0;
        while offset < metadata.size {
            if !self.inner.lifecycle.active(id) {
                return Ok(());
            }
            let length = (metadata.size - offset).min(file::CHUNK_SIZE as u64) as usize;
            let lifecycle = self.inner.lifecycle.clone();
            let (reader, data) = self
                .blocking(id, move || {
                    let mut data = vec![0; length];
                    let result = if !lifecycle.active(id) {
                        Err("file read cancelled".into())
                    } else {
                        source.read_exact(&mut data).map_err(|e| e.to_string())
                    };
                    (source, result.map(|_| data))
                })
                .await?;
            source = reader;
            let data = data?;
            if !self.inner.lifecycle.active(id) {
                return Ok(());
            }
            let next = offset + data.len() as u64;
            {
                let mut state = self.inner.state.lock().await;
                let Some(outgoing) = state.outgoing.as_mut().filter(|o| o.id == id) else {
                    return Ok(());
                };
                outgoing.expected_ack = Some(next);
            }
            self.send(
                CHUNK,
                id,
                &file::frame(offset, &data).map_err(|e| e.to_string())?,
            )
            .await?;
            let received = tokio::select! {biased;_=self.inner.lifecycle.until_cancel_requested(id)=>return Ok(()),received=tokio::time::timeout(WAIT,signals.recv())=>received};
            match received {
                Ok(Some(Signal::ChunkAck)) => {}
                Ok(Some(Signal::Cancel) | None) => return Ok(()),
                _ => return Err("file chunk acknowledgement timed out or invalid".into()),
            }
            offset = next;
            self.emit(Event::Progress {
                id: id_string(id),
                done: offset,
                total: metadata.size,
            })
            .await;
        }
        {
            let mut state = self.inner.state.lock().await;
            let Some(outgoing) = state.outgoing.as_mut().filter(|o| o.id == id) else {
                return Ok(());
            };
            outgoing.awaiting_receipt = true;
        }
        self.send(FINISH, id, &[]).await?;
        let received = tokio::select! {biased;_=self.inner.lifecycle.until_cancel_requested(id)=>return Ok(()),received=tokio::time::timeout(WAIT,signals.recv())=>received};
        match received {
            Ok(Some(Signal::Complete)) => {
                self.inner.lifecycle.receipt(id);
                if self.remove(id).await {
                    self.emit(Event::Completed {
                        id: id_string(id),
                        destination: None,
                    })
                    .await;
                }
                Ok(())
            }
            Ok(Some(Signal::Cancel) | None) => Ok(()),
            _ => Err("receiver save acknowledgement timed out or invalid".into()),
        }
    }
    fn close_owner(&self) -> Result<CloseReceiver, String> {
        let mut stored = self
            .inner
            .close_result
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(receiver) = stored.as_ref() {
            return Ok(receiver.clone());
        }
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| "file cleanup requires a running Tokio owner".to_owned())?;
        let (result, receiver) = watch::channel(None);
        *stored = Some(receiver.clone());
        let inner = Arc::downgrade(&self.inner);
        let lifecycle = self.inner.lifecycle.clone();
        // 唯一任务独立于shutdown调用方；丢弃等待future不取消已开始的清理。
        runtime.spawn(async move {
            lifecycle.until_stopped().await;
            lifecycle.idle(None).await;
            if let Some(inner) = inner.upgrade() {
                let mut state = inner.state.lock().await;
                state.closed = true;
                state.preparing.take();
                state.incoming.take();
                state.outgoing.take();
                drop(state);
                let report = lifecycle.report();
                if let Ok(report) = &report {
                    for id in &report.cancelled {
                        let _ = inner.events.try_send(Event::Cancelled { id: id.clone() });
                    }
                    for file in &report.committed {
                        let _ = inner.events.try_send(Event::Completed {
                            id: file.id.clone(),
                            destination: file.destination.clone(),
                        });
                    }
                }
                result.send_replace(Some(report));
            } else {
                result.send_replace(Some(lifecycle.report()));
            }
        });
        Ok(receiver)
    }
    /// 仅返回已确认的保存事实；即使另一文件发布结果不确定也不丢已知账本。
    /// 此快照不是关闭成功回执，也不保证完整；应在shutdown后读取并保留其错误。
    pub fn known_committed(&self) -> Vec<CommittedFile> {
        self.inner.lifecycle.known_committed()
    }
    /// 同步停止准入，不等待hash/state锁；宿主还应立即独立关闭Chat以阻断网络。
    pub fn request_stop(&self) {
        self.inner.lifecycle.stop();
        // 非Tokio调用者仍立即撤销准入；随后shutdown会明确报告/启动清理owner。
        let _ = self.close_owner();
    }
    /// 调用即停止准入并启动唯一owner；即使返回future未poll/被drop，清理也继续。
    /// OS阻塞I/O不能强杀，结果未返回前不能声称清理完成。
    pub fn shutdown(
        &self,
    ) -> impl std::future::Future<Output = Result<CloseReport, String>> + Send + 'static {
        self.request_stop();
        let receiver = self.close_owner();
        async move {
            let mut receiver = receiver?;
            loop {
                if let Some(result) = receiver.borrow_and_update().clone() {
                    return result;
                }
                receiver
                    .changed()
                    .await
                    .map_err(|_| "file cleanup owner exited without confirmation".to_owned())?;
            }
        }
    }
    /// 兼容旧宿主；需要区分已先行发布的文件时使用shutdown返回的CloseReport。
    pub fn close(&self) -> impl std::future::Future<Output = Result<(), String>> + Send + 'static {
        let result = self.shutdown();
        async move { result.await.map(|_| ()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{chat, Peer, Route};
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use webrtc::{
        api::setting_engine::SettingEngine,
        util::vnet::{
            net::{Net, NetConfig},
            router::{Router, RouterConfig},
        },
    };

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("surreal-ck-transfer-test-{}", id_string(new_id())));
            std::fs::create_dir(&path).unwrap();
            // macOS /var 与 /tmp 通常是别名；夹具选择真实路径，不改变生产路径策略。
            #[cfg(target_os = "macos")]
            let path = path.canonicalize().unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
        fn no_partials(&self) {
            #[cfg(target_os = "macos")]
            {
                let root = self.path(".surreal-ck-receive");
                if root.exists() {
                    assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
                }
            }
            assert!(std::fs::read_dir(&self.0).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".part")
            }));
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[derive(Default)]
    struct Gate {
        hold_complete: AtomicBool,
        hold_chunk_ack: AtomicBool,
        corrupt_next_chunk: AtomicBool,
        held: Mutex<Option<Vec<u8>>>,
        chunks: AtomicUsize,
    }
    fn pump(
        mut events: mpsc::Receiver<chat::Event>,
        transfer: Transfer,
        gate: Arc<Gate>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    chat::Event::Binary(mut bytes) => {
                        if bytes.len() >= HEADER {
                            if (bytes[4] == COMPLETE && gate.hold_complete.load(Ordering::SeqCst))
                                || (bytes[4] == CHUNK_ACK
                                    && gate.hold_chunk_ack.load(Ordering::SeqCst))
                            {
                                *gate.held.lock().await = Some(bytes);
                                continue;
                            }
                            if bytes[4] == CHUNK {
                                gate.chunks.fetch_add(1, Ordering::SeqCst);
                                if gate.corrupt_next_chunk.swap(false, Ordering::SeqCst) {
                                    *bytes.last_mut().unwrap() ^= 0x01;
                                }
                            }
                        }
                        let _ = transfer.handle_binary(&bytes).await;
                    }
                    chat::Event::Closed => {
                        transfer.close().await.unwrap();
                        break;
                    }
                    _ => {}
                }
            }
            transfer.close().await.unwrap();
        })
    }
    async fn next(events: &mut mpsc::Receiver<Event>) -> Event {
        tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn terminal(events: &mut mpsc::Receiver<Event>) -> Event {
        loop {
            let event = next(events).await;
            if !matches!(event, Event::Progress { .. }) {
                return event;
            }
        }
    }
    async fn wait_held(gate: &Gate) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(bytes) = gate.held.lock().await.take() {
                    return bytes;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn pair() -> (
        Arc<Chat>,
        mpsc::Receiver<chat::Event>,
        Arc<Chat>,
        mpsc::Receiver<chat::Event>,
        Arc<Mutex<Router>>,
    ) {
        let router = Arc::new(Mutex::new(
            Router::new(RouterConfig {
                cidr: "10.1.0.0/24".into(),
                ..Default::default()
            })
            .unwrap(),
        ));
        let mut peers = Vec::new();
        for ip in ["10.1.0.1", "10.1.0.2"] {
            let net = Arc::new(Net::new(Some(NetConfig {
                static_ips: vec![ip.into()],
                ..Default::default()
            })));
            let nic = net.get_nic().unwrap();
            router.lock().await.add_net(nic.clone()).await.unwrap();
            nic.lock().await.set_router(router.clone()).await.unwrap();
            let mut settings = SettingEngine::default();
            settings.set_vnet(Some(net));
            peers.push(
                Peer::new_with_settings(Route::Direct, vec![], settings)
                    .await
                    .unwrap(),
            );
        }
        router.lock().await.start().await.unwrap();
        let (a, mut ae) = Chat::from_peer(peers.remove(0), true).await.unwrap();
        let (b, mut be) = Chat::from_peer(peers.remove(0), false).await.unwrap();
        let answer = b.answer_json(&a.offer_json().await.unwrap()).await.unwrap();
        a.accept_answer_json(&answer).await.unwrap();
        while !matches!(ae.recv().await, Some(chat::Event::Open)) {}
        while !matches!(be.recv().await, Some(chat::Event::Open)) {}
        (Arc::new(a), ae, Arc::new(b), be, router)
    }

    #[tokio::test]
    #[cfg_attr(
        not(any(
            target_os = "linux",
            target_os = "android",
            target_os = "macos",
            target_os = "windows"
        )),
        ignore = "secure receiving is not implemented on this platform"
    )]
    async fn real_virtual_chat_approval_stream_integrity_cancel_and_no_overwrite() {
        tokio::time::timeout(Duration::from_secs(60), async {
            let (a_chat, ae, b_chat, be, router) = pair().await;
            let (at, mut ar) = mpsc::channel(128); let (bt, mut br) = mpsc::channel(128);
            let a = Transfer::new(a_chat.clone(), at); let b = Transfer::new(b_chat.clone(), bt);
            let ag = Arc::new(Gate::default()); let bg = Arc::new(Gate::default());
            let ap = pump(ae, a.clone(), ag.clone()); let bp = pump(be, b.clone(), bg.clone());
            let source_dir = TestDir::new(); let destination_dir = TestDir::new();
            let source = source_dir.path("真实文件.bin");
            let data: Vec<u8> = (0..file::CHUNK_SIZE * 5 + 123).map(|i| (i % 251) as u8).collect();
            std::fs::write(&source, &data).unwrap();

            // 未授权前只有 metadata，无文件内容、无临时文件；最终保存 ACK 才能显示发送成功。
            ag.hold_complete.store(true, Ordering::SeqCst);
            let id = a.offer(source.clone()).await.unwrap();
            assert_eq!(next(&mut br).await, Event::Offer { id: id.clone(), name: "真实文件.bin".into(), size: data.len() as u64 });
            assert!(tokio::time::timeout(Duration::from_millis(75), br.recv()).await.is_err());
            assert_eq!(bg.chunks.load(Ordering::SeqCst), 0);
            assert_eq!(std::fs::read_dir(&destination_dir.0).unwrap().count(), 0);
            assert!(a.offer(source.clone()).await.is_err());
            assert!(b.offer(source.clone()).await.is_err());
            let destination = destination_dir.path("已批准.bin");
            b.accept(&id, destination.clone()).await.unwrap();
            assert_eq!(terminal(&mut br).await, Event::Completed { id: id.clone(), destination: Some(destination.clone()) });
            assert_eq!(std::fs::read(&destination).unwrap(), data);
            assert!(bg.chunks.load(Ordering::SeqCst) > 1);
            let held = wait_held(&ag).await;
            while let Ok(event) = ar.try_recv() { assert!(matches!(event, Event::Progress { .. })); }
            assert!(tokio::time::timeout(Duration::from_millis(75), ar.recv()).await.is_err());
            ag.hold_complete.store(false, Ordering::SeqCst); b_chat.send_binary(&held).await.unwrap();
            assert_eq!(terminal(&mut ar).await, Event::Completed { id, destination: None });
            destination_dir.no_partials();

            // 拒绝没有磁盘副作用，也没有发送任何 chunk。
            let chunks = bg.chunks.load(Ordering::SeqCst);
            let id = a.offer(source.clone()).await.unwrap(); assert!(matches!(next(&mut br).await, Event::Offer { .. }));
            b.reject(&id).await.unwrap();
            assert_eq!(terminal(&mut br).await, Event::Cancelled { id: id.clone() });
            assert_eq!(terminal(&mut ar).await, Event::Cancelled { id });
            assert_eq!(bg.chunks.load(Ordering::SeqCst), chunks); destination_dir.no_partials();

            // 篡改实际 DTLS 通道交给接收会话的一块数据，最终 SHA-256 必须失败。
            bg.corrupt_next_chunk.store(true, Ordering::SeqCst);
            let id = a.offer(source.clone()).await.unwrap(); assert!(matches!(next(&mut br).await, Event::Offer { .. }));
            let corrupt = destination_dir.path("corrupt.bin"); b.accept(&id, corrupt.clone()).await.unwrap();
            assert!(matches!(terminal(&mut br).await, Event::Error { .. }));
            assert_eq!(terminal(&mut ar).await, Event::Cancelled { id });
            assert!(!corrupt.exists()); destination_dir.no_partials();

            // 每块 ACK 背压使发送方最多一块在途，接收方取消后只删除自己的 .part。
            ag.hold_chunk_ack.store(true, Ordering::SeqCst);
            let id = a.offer(source.clone()).await.unwrap(); assert!(matches!(next(&mut br).await, Event::Offer { .. }));
            let cancelled = destination_dir.path("cancelled.bin"); b.accept(&id, cancelled.clone()).await.unwrap();
            assert!(matches!(next(&mut br).await, Event::Progress { done, .. } if done == file::CHUNK_SIZE as u64));
            let _ = wait_held(&ag).await;
            b.cancel(&id).await.unwrap();
            assert_eq!(terminal(&mut br).await, Event::Cancelled { id: id.clone() });
            assert_eq!(terminal(&mut ar).await, Event::Cancelled { id });
            assert!(!cancelled.exists()); destination_dir.no_partials();
            ag.hold_chunk_ack.store(false, Ordering::SeqCst);

            // 真实通道内重复/乱序分块必须取消整次接收，不保留目标或临时文件。
            for bad_offset in [0, file::CHUNK_SIZE as u64 + 1] {
                ag.hold_chunk_ack.store(true, Ordering::SeqCst);
                let id = a.offer(source.clone()).await.unwrap(); assert!(matches!(next(&mut br).await, Event::Offer { .. }));
                let invalid = destination_dir.path(&format!("invalid-offset-{bad_offset}.bin"));
                b.accept(&id, invalid.clone()).await.unwrap();
                assert!(matches!(next(&mut br).await, Event::Progress { done, .. } if done == file::CHUNK_SIZE as u64));
                let _ = wait_held(&ag).await;
                a_chat.send_binary(&packet(CHUNK, parse_id(&id).unwrap(), &file::frame(bad_offset, b"wrong offset").unwrap())).await.unwrap();
                assert!(matches!(terminal(&mut br).await, Event::Error { .. }));
                assert_eq!(terminal(&mut ar).await, Event::Cancelled { id });
                assert!(!invalid.exists()); destination_dir.no_partials();
                ag.hold_chunk_ack.store(false, Ordering::SeqCst);
            }

            // 已有目标在批准时失败；批准后出现的目标也绝不覆盖。
            let occupied = destination_dir.path("occupied.bin"); std::fs::write(&occupied, b"existing user file").unwrap();
            let id = a.offer(source.clone()).await.unwrap(); assert!(matches!(next(&mut br).await, Event::Offer { .. }));
            assert!(b.accept(&id, occupied.clone()).await.is_err()); destination_dir.no_partials();
            ag.hold_chunk_ack.store(true, Ordering::SeqCst);
            let race = destination_dir.path("created-after-approval.bin"); b.accept(&id, race.clone()).await.unwrap();
            assert!(matches!(next(&mut br).await, Event::Progress { .. }));
            let held = wait_held(&ag).await;
            std::fs::write(&race, b"concurrent user file").unwrap();
            ag.hold_chunk_ack.store(false, Ordering::SeqCst); b_chat.send_binary(&held).await.unwrap();
            assert!(matches!(terminal(&mut br).await, Event::Error { .. }));
            assert_eq!(terminal(&mut ar).await, Event::Cancelled { id });
            assert_eq!(std::fs::read(&occupied).unwrap(), b"existing user file");
            assert_eq!(std::fs::read(&race).unwrap(), b"concurrent user file"); destination_dir.no_partials();

            // 空文件也必须经过用户接受、hash 校验、最终保存 ACK。
            let empty_source = source_dir.path("empty.bin"); std::fs::write(&empty_source, []).unwrap();
            let id = a.offer(empty_source).await.unwrap(); assert!(matches!(next(&mut br).await, Event::Offer { size: 0, .. }));
            let empty = destination_dir.path("empty.bin"); b.accept(&id, empty.clone()).await.unwrap();
            assert_eq!(terminal(&mut br).await, Event::Completed { id: id.clone(), destination: Some(empty.clone()) });
            assert_eq!(terminal(&mut ar).await, Event::Completed { id, destination: None });
            assert_eq!(std::fs::metadata(empty).unwrap().len(), 0); destination_dir.no_partials();

            // 对端越过确认强发内容：拒绝并取消，无磁盘写入。
            let id = a.offer(source.clone()).await.unwrap(); assert!(matches!(next(&mut br).await, Event::Offer { .. }));
            a_chat.send_binary(&packet(CHUNK, parse_id(&id).unwrap(), &file::frame(0, b"unauthorized").unwrap())).await.unwrap();
            assert!(matches!(terminal(&mut br).await, Event::Error { .. }));
            assert_eq!(terminal(&mut ar).await, Event::Cancelled { id }); destination_dir.no_partials();

            // 真实通道关闭回调必须触发会话清理，不留下不完整的最终文件。
            ag.hold_chunk_ack.store(true, Ordering::SeqCst);
            let id = a.offer(source).await.unwrap(); assert!(matches!(next(&mut br).await, Event::Offer { .. }));
            let interrupted = destination_dir.path("interrupted.bin"); b.accept(&id, interrupted.clone()).await.unwrap();
            assert!(matches!(next(&mut br).await, Event::Progress { .. }));
            b_chat.close().await.unwrap();
            assert_eq!(terminal(&mut br).await, Event::Cancelled { id });
            assert!(!interrupted.exists()); destination_dir.no_partials();
            a.close().await.unwrap(); b.close().await.unwrap(); a_chat.close().await.unwrap();
            ap.abort(); bp.abort(); router.lock().await.stop().await.unwrap();
        }).await.expect("file session virtual ICE/DTLS/SCTP test timed out");
    }

    // 子进程入口只由下面的测试按精确名称启动；--ignored单独调用无夹具则失败。
    #[tokio::test]
    #[ignore = "subprocess fixture; run interrupted_process_preserves_commit_boundary_and_allows_new_session"]
    async fn interrupted_receive_child() {
        let root =
            PathBuf::from(std::env::var_os("CK_RECEIVE_CRASH_FIXTURE").expect("parent fixture"));
        let committed = std::env::var("CK_RECEIVE_CRASH_PHASE").unwrap() == "committed";
        let (a_chat, ae, b_chat, be, _router) = pair().await;
        let (at, mut ar) = mpsc::channel(128);
        let (bt, mut br) = mpsc::channel(128);
        let a = Transfer::new(a_chat, at);
        let b = Transfer::new(b_chat, bt);
        let gate = Arc::new(Gate::default());
        gate.hold_chunk_ack.store(!committed, Ordering::SeqCst);
        gate.hold_complete.store(committed, Ordering::SeqCst);
        let _ap = pump(ae, a.clone(), gate.clone());
        let _bp = pump(be, b.clone(), Arc::new(Gate::default()));
        let id = a.offer(root.join("source.bin")).await.unwrap();
        assert!(matches!(next(&mut br).await, Event::Offer { .. }));
        b.accept(&id, root.join("sink/received.bin")).await.unwrap();
        if committed {
            assert!(matches!(
                terminal(&mut br).await,
                Event::Completed {
                    destination: Some(_),
                    ..
                }
            ));
            assert_eq!(wait_held(&gate).await[4], COMPLETE);
            while let Ok(event) = ar.try_recv() {
                assert!(matches!(event, Event::Progress { .. }));
            }
        } else {
            assert!(
                matches!(next(&mut br).await, Event::Progress { done, .. } if done == file::CHUNK_SIZE as u64)
            );
            assert_eq!(wait_held(&gate).await[4], CHUNK_ACK);
        }
        // 父进程只在真实接收状态/真实落盘后、最终ACK仍被扣留时终止进程。
        std::fs::write(root.join("ready"), b"ready").unwrap();
        std::future::pending::<()>().await;
    }

    #[tokio::test]
    #[cfg(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "windows"
    ))]
    async fn interrupted_process_preserves_commit_boundary_and_allows_new_session() {
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        for phase in ["partial", "committed"] {
            let root = TestDir::new();
            let sink = root.path("sink");
            std::fs::create_dir(&sink).unwrap();
            let data = vec![7u8; file::CHUNK_SIZE * 3];
            std::fs::write(root.path("source.bin"), &data).unwrap();
            let sentinel = sink.join("unrelated.part");
            std::fs::write(&sentinel, b"existing local file").unwrap();
            let mut child = ChildGuard(
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "transfer::tests::interrupted_receive_child",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env("CK_RECEIVE_CRASH_FIXTURE", &root.0)
                    .env("CK_RECEIVE_CRASH_PHASE", phase)
                    .spawn()
                    .unwrap(),
            );
            tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    assert!(
                        child.0.try_wait().unwrap().is_none(),
                        "child failed before reaching {phase}"
                    );
                    if root.path("ready").exists() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("child never reached actual receive checkpoint");
            child.0.kill().unwrap();
            assert!(!child.0.wait().unwrap().success());
            let target = sink.join("received.bin");
            if phase == "partial" {
                assert!(
                    !target.exists(),
                    "interruption must not publish incomplete bytes"
                );
            } else {
                assert_eq!(
                    std::fs::read(&target).unwrap(),
                    data,
                    "saved before ACK stays saved"
                );
            }
            assert_eq!(std::fs::read(&sentinel).unwrap(), b"existing local file");
            // 只枚举本测试独占夹具的已知staging位置，不做生产回收或递归删除。
            #[allow(unused_mut)]
            let mut leftovers: Vec<PathBuf> = Vec::new();
            #[cfg(target_os = "macos")]
            for entry in std::fs::read_dir(sink.join(".surreal-ck-receive")).unwrap() {
                leftovers.push(entry.unwrap().path().join("payload"));
            }
            #[cfg(target_os = "windows")]
            for entry in std::fs::read_dir(&sink).unwrap() {
                let entry = entry.unwrap();
                if entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".surreal-ck-")
                {
                    leftovers.push(entry.path());
                }
            }
            // Linux匿名inode在进程关闭后回收；桌面命名staging目前故意不自动回收。
            let expected = usize::from(
                phase == "partial" && cfg!(any(target_os = "macos", target_os = "windows")),
            );
            assert_eq!(leftovers.len(), expected, "actual orphan count for {phase}");
            for path in &leftovers {
                assert_eq!(std::fs::read(path).unwrap(), &data[..file::CHUNK_SIZE]);
            }
            println!(
                "actual process interruption: phase={phase}, staging_payloads={}, saved={}",
                leftovers.len(),
                target.exists()
            );
            // 终止后由父进程在同一目录创建的新会话必须可完成；不复用/删除旧staging。
            let (a_chat, ae, b_chat, be, router) = pair().await;
            let (at, mut ar) = mpsc::channel(128);
            let (bt, mut br) = mpsc::channel(128);
            let a = Transfer::new(a_chat.clone(), at);
            let b = Transfer::new(b_chat.clone(), bt);
            let ap = pump(ae, a.clone(), Arc::new(Gate::default()));
            let bp = pump(be, b.clone(), Arc::new(Gate::default()));
            let id = a.offer(root.path("source.bin")).await.unwrap();
            assert!(matches!(next(&mut br).await, Event::Offer { .. }));
            let fresh = sink.join("fresh.bin");
            b.accept(&id, fresh.clone()).await.unwrap();
            assert!(matches!(
                terminal(&mut br).await,
                Event::Completed {
                    destination: Some(_),
                    ..
                }
            ));
            assert!(matches!(
                terminal(&mut ar).await,
                Event::Completed {
                    destination: None,
                    ..
                }
            ));
            assert_eq!(std::fs::read(fresh).unwrap(), data);
            assert_eq!(std::fs::read(&sentinel).unwrap(), b"existing local file");
            for path in &leftovers {
                assert_eq!(std::fs::read(path).unwrap(), &data[..file::CHUNK_SIZE]);
            }
            if phase == "committed" {
                assert_eq!(std::fs::read(target).unwrap(), data);
            }
            a.shutdown().await.unwrap();
            b.shutdown().await.unwrap();
            ap.abort();
            bp.abort();
            let _ = ap.await;
            let _ = bp.await;
            a_chat.close().await.unwrap();
            b_chat.close().await.unwrap();
            router.lock().await.stop().await.unwrap();
        }
    }

    async fn isolated(
        capacity: usize,
    ) -> (Transfer, mpsc::Receiver<Event>, mpsc::Receiver<chat::Event>) {
        let (chat, chat_events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
        let (tx, events) = mpsc::channel(capacity);
        (Transfer::new(Arc::new(chat), tx), events, chat_events)
    }

    #[tokio::test]
    async fn cancelled_hash_keeps_tracking_and_shutdown_survives_dropped_future() {
        let (transfer, _events, chat_events) = isolated(1).await;
        let dir = TestDir::new();
        let source = dir.path("hash.bin");
        std::fs::write(&source, b"selected source").unwrap();
        let (entered, release) = transfer.inner.lifecycle.gate("hash");
        let worker = transfer.clone();
        let offer = tokio::spawn(async move { worker.offer(source).await });
        entered.await.unwrap();
        assert!(
            transfer.inner.state.try_lock().is_ok(),
            "hash不能长持state锁"
        );
        offer.abort();
        assert!(offer.await.unwrap_err().is_cancelled());
        let first = transfer.shutdown();
        drop(first); // 未poll的future也已经启动独立清理owner。
        assert!(
            tokio::time::timeout(Duration::from_millis(30), transfer.shutdown())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        let report = tokio::time::timeout(Duration::from_secs(2), transfer.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert!(report.committed.is_empty());
        assert_eq!(report, transfer.shutdown().await.unwrap());
        assert!(transfer.inner.state.lock().await.preparing.is_none());
        assert!(transfer.offer(dir.path("new.bin")).await.is_err());
        drop(chat_events);
        transfer.inner.chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn single_file_cancel_unblocks_full_progress_queue_without_global_stop() {
        let (transfer, mut events, chat_events) = isolated(1).await;
        let id = new_id();
        transfer.inner.lifecycle.register(id).unwrap();
        transfer
            .inner
            .events
            .try_send(Event::Progress {
                id: id_string(id),
                done: 0,
                total: 2,
            })
            .unwrap();
        let registered = transfer.inner.lifecycle.work(Some(id), false).unwrap();
        let worker = transfer.clone();
        let emit = tokio::spawn(async move {
            let _registered = registered;
            worker
                .emit(Event::Progress {
                    id: id_string(id),
                    done: 1,
                    total: 2,
                })
                .await
        });
        tokio::task::yield_now().await;
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            transfer.cancel_outcome(&id_string(id)),
        )
        .await
        .expect("单文件取消被事件背压卡住");
        // 未协商Chat无法发送CANCEL，但本地清理和取消通知仍必须前进。
        assert!(result.is_err());
        assert!(!transfer.inner.lifecycle.stopped());
        assert!(!emit.await.unwrap());
        assert!(matches!(
            events.recv().await,
            Some(Event::Progress { done: 0, .. })
        ));
        assert_eq!(
            next(&mut events).await,
            Event::Cancelled { id: id_string(id) }
        );
        tokio::time::timeout(Duration::from_secs(1), transfer.inner.lifecycle.idle(None))
            .await
            .unwrap();
        transfer.shutdown().await.unwrap();
        drop(chat_events);
        transfer.inner.chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn real_receipt_cannot_erase_cancel_request_and_deadlock_full_completed_queue() {
        let (transfer, _events, chat_events) = isolated(1).await;
        let id = new_id();
        transfer.inner.lifecycle.register(id).unwrap();
        transfer
            .inner
            .events
            .try_send(Event::Progress {
                id: id_string(id),
                done: 1,
                total: 1,
            })
            .unwrap();
        let registered = transfer.inner.lifecycle.work(Some(id), false).unwrap();
        let (release, entered) = tokio::sync::oneshot::channel();
        let worker = transfer.clone();
        let emit = tokio::spawn(async move {
            let _registered = registered;
            entered.await.unwrap();
            worker
                .emit(Event::Completed {
                    id: id_string(id),
                    destination: None,
                })
                .await
        });
        let (signals, _signal_rx) = mpsc::channel(4);
        transfer.inner.state.lock().await.outgoing = Some(Outgoing {
            id,
            signals,
            accepted: true,
            expected_ack: None,
            awaiting_receipt: true,
        });
        let worker = transfer.clone();
        let cancel = tokio::spawn(async move { worker.cancel_outcome(&id_string(id)).await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !transfer.inner.lifecycle.cancelled(id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        transfer.inner.lifecycle.receipt(id); // 已校验最终ACK先行，实际结果仍为完成。
        release.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), cancel)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            CancelOutcome::Completed { destination: None }
        );
        assert!(emit.await.unwrap());
        assert!(transfer.inner.state.lock().await.outgoing.is_none());
        let report = transfer.shutdown().await.unwrap();
        assert_eq!(
            report.committed,
            vec![CommittedFile {
                id: id_string(id),
                destination: None
            }]
        );
        drop(chat_events);
        transfer.inner.chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn completed_before_cancel_releases_busy_even_when_retired_notification_is_blocked() {
        let (transfer, _events, chat_events) = isolated(1).await;
        let id = new_id();
        transfer.inner.lifecycle.register(id).unwrap();
        let (signals, _signals_rx) = mpsc::channel(4);
        transfer.inner.state.lock().await.outgoing = Some(Outgoing {
            id,
            signals,
            accepted: true,
            expected_ack: None,
            awaiting_receipt: false,
        });
        transfer.inner.lifecycle.receipt(id);
        transfer.inner.lifecycle.retire(id);
        transfer
            .inner
            .events
            .try_send(Event::Progress {
                id: id_string(id),
                done: 1,
                total: 1,
            })
            .unwrap();
        let registered = transfer.inner.lifecycle.work(Some(id), false).unwrap();
        let worker = transfer.clone();
        let emit = tokio::spawn(async move {
            let _registered = registered;
            worker
                .emit(Event::Completed {
                    id: id_string(id),
                    destination: None,
                })
                .await
        });
        tokio::task::yield_now().await;
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            transfer.cancel_outcome(&id_string(id)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, CancelOutcome::Completed { destination: None });
        assert!(emit.await.unwrap());
        assert!(transfer.inner.state.lock().await.outgoing.is_none());
        assert_eq!(
            transfer.shutdown().await.unwrap().committed,
            vec![CommittedFile {
                id: id_string(id),
                destination: None
            }]
        );
        drop(chat_events);
        transfer.inner.chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn cancel_completed_return_paths_emit_even_when_stream_exits_without_notification() {
        for receipt_during_cancel in [false, true] {
            let (transfer, mut events, chat_events) = isolated(1).await;
            let id = new_id();
            transfer.inner.lifecycle.register(id).unwrap();
            let (signals, _signals_rx) = mpsc::channel(4);
            transfer.inner.state.lock().await.outgoing = Some(Outgoing {
                id,
                signals,
                accepted: true,
                expected_ack: None,
                awaiting_receipt: true,
            });
            transfer
                .inner
                .events
                .try_send(Event::Progress {
                    id: id_string(id),
                    done: 1,
                    total: 1,
                })
                .unwrap();
            let result = if receipt_during_cancel {
                // stream持Work但沿取消分支退出，明确没有自行调用emit Completed。
                let registered = transfer.inner.lifecycle.work(Some(id), false).unwrap();
                let worker = transfer.clone();
                let cancel =
                    tokio::spawn(async move { worker.cancel_outcome(&id_string(id)).await });
                tokio::time::timeout(Duration::from_secs(1), async {
                    while !transfer.inner.lifecycle.cancelled(id) {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                transfer.inner.lifecycle.receipt(id);
                drop(registered);
                tokio::time::timeout(Duration::from_secs(1), cancel)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
            } else {
                transfer.inner.lifecycle.receipt(id);
                tokio::time::timeout(
                    Duration::from_secs(1),
                    transfer.cancel_outcome(&id_string(id)),
                )
                .await
                .unwrap()
                .unwrap()
            };
            assert_eq!(result, CancelOutcome::Completed { destination: None });
            assert!(transfer.inner.state.lock().await.outgoing.is_none());
            assert!(matches!(events.recv().await, Some(Event::Progress { .. })));
            assert_eq!(
                next(&mut events).await,
                Event::Completed {
                    id: id_string(id),
                    destination: None
                }
            );
            assert_eq!(transfer.shutdown().await.unwrap().committed.len(), 1);
            drop(chat_events);
            transfer.inner.chat.close().await.unwrap();
        }
    }

    #[tokio::test]
    async fn full_terminal_queue_does_not_block_global_shutdown() {
        let (transfer, _events, chat_events) = isolated(1).await;
        let id = new_id();
        transfer.inner.lifecycle.register(id).unwrap();
        transfer.inner.lifecycle.cancel(id);
        transfer
            .inner
            .events
            .try_send(Event::Progress {
                id: id_string(id),
                done: 0,
                total: 1,
            })
            .unwrap();
        transfer.notify_terminal(id).unwrap();
        let report = tokio::time::timeout(Duration::from_secs(1), transfer.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(report.cancelled, vec![id_string(id)]);
        drop(chat_events);
        transfer.inner.chat.close().await.unwrap();
    }

    #[tokio::test]
    #[cfg(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "windows"
    ))]
    async fn publish_gate_distinguishes_cancel_before_and_after_commit_admission() {
        for point in ["before_publish", "publishing"] {
            let (transfer, _events, chat_events) = isolated(1).await;
            let dir = TestDir::new();
            let path = dir.path("verified.bin");
            let id = new_id();
            transfer.inner.lifecycle.register(id).unwrap();
            let receiving = prepare_destination(
                Metadata {
                    id,
                    name: "verified.bin".into(),
                    size: 0,
                    hash: Sha256::digest(b"").into(),
                },
                path.clone(),
            )
            .unwrap();
            let (entered, release) = transfer.inner.lifecycle.gate(point);
            let registered = transfer.inner.lifecycle.work(Some(id), false).unwrap();
            let worker = transfer.clone();
            let lifecycle = transfer.inner.lifecycle.clone();
            let finish = tokio::spawn(async move {
                let _registered = registered;
                worker
                    .blocking(id, move || finalize(receiving, &lifecycle))
                    .await
                    .unwrap()
            });
            entered.await.unwrap();
            assert_eq!(
                transfer.inner.lifecycle.cancel(id),
                if point == "publishing" {
                    CancelOutcome::CommitInProgress
                } else {
                    CancelOutcome::Cancelled
                }
            );
            let wait = transfer.shutdown();
            drop(wait);
            assert!(
                tokio::time::timeout(Duration::from_millis(30), transfer.shutdown())
                    .await
                    .is_err()
            );
            release.send(()).unwrap();
            let result = finish.await.unwrap();
            let report = transfer.shutdown().await.unwrap();
            if point == "publishing" {
                assert_eq!(result.unwrap(), path);
                assert_eq!(
                    report.committed,
                    vec![CommittedFile {
                        id: id_string(id),
                        destination: Some(path.clone())
                    }]
                );
                assert!(!report.cancelled.contains(&id_string(id)));
                assert!(path.exists());
            } else {
                assert!(result.is_err());
                assert!(report.committed.is_empty());
                assert!(!path.exists());
            }
            drop(chat_events);
            transfer.inner.chat.close().await.unwrap();
        }
    }

    #[tokio::test]
    async fn pending_cancel_notice_rechecks_receipt_after_reserving_capacity() {
        let (transfer, mut events, chat_events) = isolated(1).await;
        let id = new_id();
        transfer.inner.lifecycle.register(id).unwrap();
        transfer.inner.lifecycle.cancel(id);
        transfer
            .inner
            .events
            .try_send(Event::Progress {
                id: id_string(id),
                done: 1,
                total: 1,
            })
            .unwrap();
        transfer.notify_terminal(id).unwrap();
        tokio::task::yield_now().await;
        transfer.inner.lifecycle.receipt(id);
        transfer.notify_terminal(id).unwrap(); // 同ID去重，但不能丢掉更新后的事实。
        assert!(matches!(events.recv().await, Some(Event::Progress { .. })));
        assert_eq!(
            next(&mut events).await,
            Event::Completed {
                id: id_string(id),
                destination: None
            }
        );
        tokio::time::timeout(Duration::from_secs(1), transfer.inner.lifecycle.idle(None))
            .await
            .unwrap();
        assert!(events.try_recv().is_err());
        assert!(transfer.inner.lifecycle.cancelled(id));
        assert_eq!(transfer.shutdown().await.unwrap().committed.len(), 1);
        drop(chat_events);
        transfer.inner.chat.close().await.unwrap();
    }

    #[tokio::test]
    async fn complete_ack_requires_saved_receipt_and_still_obeys_global_stop() {
        let (transfer, _events, chat_events) = isolated(1).await;
        let id = new_id();
        transfer.inner.lifecycle.register(id).unwrap();
        assert!(transfer
            .send(COMPLETE, id, &[])
            .await
            .unwrap_err()
            .contains("verified saved file"));
        transfer.inner.lifecycle.receipt(id); // 发送端的对方ACK不能冒充本地已保存。
        assert!(transfer
            .send(COMPLETE, id, &[])
            .await
            .unwrap_err()
            .contains("verified saved file"));
        transfer.request_stop();
        assert_eq!(
            transfer.send(COMPLETE, id, &[]).await.unwrap_err(),
            "file session stopped"
        );
        transfer.shutdown().await.unwrap();
        drop(chat_events);
        transfer.inner.chat.close().await.unwrap();
    }

    #[tokio::test]
    #[cfg(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "windows"
    ))]
    async fn real_virtual_chat_publish_wins_cancel_and_still_delivers_saved_ack() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let (a_chat, ae, b_chat, be, router) = pair().await;
            let (at, mut ar) = mpsc::channel(4);
            let (bt, mut br) = mpsc::channel(4);
            let a = Transfer::new(a_chat.clone(), at);
            let b = Transfer::new(b_chat.clone(), bt);
            let ap = pump(ae, a.clone(), Arc::new(Gate::default()));
            let bp = pump(be, b.clone(), Arc::new(Gate::default()));
            let source_dir = TestDir::new();
            let target_dir = TestDir::new();
            let source = source_dir.path("source.bin");
            let destination = target_dir.path("verified.bin");
            std::fs::write(&source, b"real encrypted file data").unwrap();
            let (entered, release) = b.inner.lifecycle.gate("publishing");
            let id = a.offer(source).await.unwrap();
            assert!(matches!(next(&mut br).await, Event::Offer { .. }));
            b.accept(&id, destination.clone()).await.unwrap();
            entered.await.unwrap();
            assert_eq!(
                b.cancel_outcome(&id).await.unwrap(),
                CancelOutcome::CommitInProgress
            );
            assert!(b.inner.lifecycle.cancelled(parse_id(&id).unwrap()));
            release.send(()).unwrap();
            assert_eq!(
                terminal(&mut br).await,
                Event::Completed {
                    id: id.clone(),
                    destination: Some(destination.clone())
                }
            );
            assert_eq!(
                terminal(&mut ar).await,
                Event::Completed {
                    id: id.clone(),
                    destination: None
                }
            );
            assert_eq!(
                std::fs::read(&destination).unwrap(),
                b"real encrypted file data"
            );
            assert!(
                b.inner.lifecycle.cancelled(parse_id(&id).unwrap()),
                "真实完成不清除单调取消标记"
            );
            assert!(a.inner.state.lock().await.outgoing.is_none());
            assert_eq!(
                b.shutdown().await.unwrap().committed,
                vec![CommittedFile {
                    id: id.clone(),
                    destination: Some(destination)
                }]
            );
            assert_eq!(
                a.shutdown().await.unwrap().committed,
                vec![CommittedFile {
                    id,
                    destination: None
                }]
            );
            // 测试泵没有磁盘任务未确认；先停消费者解除Chat关闭回调背压。
            ap.abort();
            bp.abort();
            let _ = ap.await;
            let _ = bp.await;
            a_chat.close().await.unwrap();
            b_chat.close().await.unwrap();
            router.lock().await.stop().await.unwrap();
        })
        .await
        .expect("发布先赢后取消的真实ACK回归超时");
    }

    #[test]
    fn committed_receipts_survive_retirement_and_capacity_never_discards_facts() {
        let lifecycle = Lifecycle::new();
        let mut first = None;
        for index in 0..256 {
            let id = new_id();
            lifecycle.register(id).unwrap();
            if index % 2 == 0 {
                lifecycle.admit_publish(id).unwrap();
                lifecycle.published(id, &Ok(PathBuf::from(format!("verified-{index}"))), true);
            } else {
                lifecycle.receipt(id);
            }
            first.get_or_insert(id);
            lifecycle.retire(id);
        }
        assert_eq!(lifecycle.state.lock().unwrap().recent.len(), 16);
        assert!(lifecycle.register(new_id()).is_err());
        lifecycle.stop();
        let report = lifecycle.report().unwrap();
        assert_eq!(report.committed.len(), 256);
        assert!(report
            .committed
            .iter()
            .any(|file| file.id == id_string(first.unwrap())));
        assert!(report.cancelled.is_empty());
    }

    #[test]
    fn failed_cleanup_keeps_confirmed_ledger_without_claiming_completeness() {
        let lifecycle = Lifecycle::new();
        let saved = new_id();
        let uncertain = new_id();
        lifecycle.register(saved).unwrap();
        lifecycle.admit_publish(saved).unwrap();
        let path = PathBuf::from("confirmed-fixture.dat");
        lifecycle.published(saved, &Ok(path.clone()), true);
        lifecycle.retire(saved);
        lifecycle.register(uncertain).unwrap();
        lifecycle.admit_publish(uncertain).unwrap();
        lifecycle.published(uncertain, &Err("publication outcome unknown".into()), true);
        lifecycle.stop();
        assert!(lifecycle.report().is_err());
        let known = lifecycle.known_committed();
        assert_eq!(
            known,
            vec![CommittedFile {
                id: id_string(saved),
                destination: Some(path)
            }]
        );
        assert!(!known.iter().any(|file| file.id == id_string(uncertain)));
        lifecycle.state.lock().unwrap().fault = true;
        assert!(lifecycle.report().is_err());
        assert_eq!(lifecycle.known_committed(), known);
    }

    #[test]
    fn uncertain_publication_never_reports_cancelled_or_clean_shutdown() {
        let lifecycle = Lifecycle::new();
        let id = new_id();
        lifecycle.register(id).unwrap();
        lifecycle.admit_publish(id).unwrap();
        lifecycle.published(id, &Err("directory changed after link".into()), true);
        lifecycle.retire(id);
        lifecycle.stop();
        assert!(matches!(
            lifecycle.cancel(id),
            CancelOutcome::PublicationUncertain { .. }
        ));
        assert!(lifecycle.report().is_err());
    }

    #[test]
    fn metadata_and_local_file_boundaries() {
        assert!(safe_name("合同.pdf"));
        for name in [
            "report.docx",
            "COM10.txt",
            "console.txt",
            "lpt.notes",
            "a b.txt",
        ] {
            assert!(safe_name(name), "ordinary name: {name}");
        }
        for name in ["", ".", "..", "../escape", "a/b", "a\\b", "a\0b", "a\nb"] {
            assert!(!safe_name(name));
        }
        for name in [
            "C:escape.txt",
            "report.txt:stream",
            "CON",
            "con.txt",
            "PrN.pdf",
            "AUX",
            "NUL.bin",
            "com1",
            "COM9.txt",
            "Lpt1.pdf",
            "LPT9",
            "COM¹.txt",
            "LPT²",
            "COM³",
            "CONIN$",
            "CONOUT$.txt",
            "CON .txt",
            "NUL .pdf",
            "COM1 .txt",
            "trailing.",
            "trailing ",
            "a?b",
            "a*b",
            "a<b",
            "a>b",
            "a|b",
            "a\"b",
        ] {
            assert!(!safe_name(name), "unsafe platform name: {name}");
        }
        assert!(!safe_name(&"a".repeat(MAX_NAME + 1)));
        assert!(parse_id(&"é".repeat(16)).is_err());
        assert!(parse_id(&"z".repeat(32)).is_err());
        let dir = TestDir::new();
        let oversized = dir.path("too-large.bin");
        let file = File::create(&oversized).unwrap();
        file.set_len(file::MAX_FILE_SIZE + 1).unwrap();
        assert!(prepare_source(oversized).is_err());
        assert!(prepare_source(dir.0.clone()).is_err());
        let metadata = Metadata {
            id: new_id(),
            name: "empty".into(),
            size: 0,
            hash: Sha256::digest(b"").into(),
        };
        let target = dir.path("target");
        if !cfg!(any(
            target_os = "linux",
            target_os = "android",
            target_os = "macos",
            target_os = "windows"
        )) {
            assert!(prepare_destination(metadata, target.clone()).is_err());
            assert!(!target.exists());
            dir.no_partials();
            return;
        }
        let partial = prepare_destination(metadata.clone(), target.clone()).unwrap();
        assert!(!target.exists());
        drop(partial);
        dir.no_partials();
        std::fs::write(&target, b"existing").unwrap();
        assert!(prepare_destination(metadata, target.clone()).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"existing");
        dir.no_partials();
    }

    #[cfg(unix)]
    #[test]
    fn source_rejects_symlink_and_fifo_without_waiting_for_a_writer() {
        use std::{
            ffi::CString,
            os::unix::{ffi::OsStrExt, fs::symlink},
        };
        let dir = TestDir::new();
        let source = dir.path("regular.bin");
        std::fs::write(&source, b"selected file").unwrap();
        let link = dir.path("source-link.bin");
        symlink(&source, &link).unwrap();
        assert!(prepare_source(link).is_err());
        assert!(prepare_source(source).is_ok());
        let fifo = dir.path("source-fifo.bin");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: NUL结尾路径位于本测试的新临时目录，只创建合成FIFO，不访问设备。
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(prepare_source(fifo).is_err());
        });
        assert!(rx
            .recv_timeout(Duration::from_secs(2))
            .expect("source open must not block waiting for a FIFO writer"));
    }
}
