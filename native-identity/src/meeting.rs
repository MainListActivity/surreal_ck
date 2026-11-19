//! Participant 会议信令；不采集媒体、不解释 SDP。Lagged 后须重新读取 snapshot。
//! 32 个命令、256 个事件、512 个会议、4096 个成员行、8192 个有效信令，溢出明确结束。
//! 重连先 LIVE 再补拉所有未过期收件箱；不重放已过期的协商。Drop 清理依赖存活的 runtime。
use crate::{
    chat::{wire::Wire, ChatError},
    members::connect_authenticated,
    IdentityClient, IdentityError, Session, SurrealConfig, Workspace,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    sync::{broadcast, mpsc, oneshot, watch},
    task::JoinHandle,
    time::{sleep, timeout},
};

pub type MeetingResult<T> = Result<T, MeetingError>;
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum MeetingError {
    #[error("会议身份已过期，请重新登录")]
    Expired,
    #[error("会议成员身份或工作区失效")]
    Identity,
    #[error("会议认证被拒绝")]
    Authentication,
    #[error("会议连接中断")]
    Network,
    #[error("会议请求超时；写入结果未知，请核对快照")]
    Timeout,
    #[error("会议数据库拒绝请求")]
    Database,
    #[error("会议事务冲突，可重试")]
    Conflict,
    #[error("会议输入无效")]
    Input,
    #[error("会议协议响应无效")]
    Protocol,
    #[error("会议缓冲区已满，需重新同步")]
    Overflow,
    #[error("会议客户端已停止")]
    Stopped,
}
impl From<ChatError> for MeetingError {
    fn from(error: ChatError) -> Self {
        match error {
            ChatError::Expired => Self::Expired,
            ChatError::Identity => Self::Identity,
            ChatError::Authentication => Self::Authentication,
            ChatError::Network => Self::Network,
            ChatError::Timeout => Self::Timeout,
            ChatError::Conflict => Self::Conflict,
            ChatError::Input => Self::Input,
            ChatError::Protocol => Self::Protocol,
            ChatError::Overflow => Self::Overflow,
            ChatError::Stopped => Self::Stopped,
            ChatError::Database | ChatError::NotEnabled => Self::Database,
        }
    }
}
impl From<IdentityError> for MeetingError {
    fn from(error: IdentityError) -> Self {
        ChatError::from(error).into()
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeetingState {
    Active,
    Ended,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Meeting {
    pub id: String,
    pub code: String,
    pub title: String,
    pub host: String,
    pub status: MeetingState,
    pub conversation: Option<String>,
    pub created_at: String,
    pub ended_at: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Participant {
    pub id: String,
    pub meeting: String,
    pub user: String,
    pub role: String,
    pub joined_at: String,
    pub left_at: Option<String>,
    pub last_seen: String,
    pub mic: bool,
    pub cam: bool,
    pub screen: bool,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MediaState {
    pub mic: bool,
    pub cam: bool,
    pub screen: bool,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SignalKind {
    Offer,
    Answer,
    Ice,
    Bye,
}
impl SignalKind {
    fn name(self) -> &'static str {
        match self {
            Self::Offer => "offer",
            Self::Answer => "answer",
            Self::Ice => "ice",
            Self::Bye => "bye",
        }
    }
}
#[derive(Clone, Deserialize, PartialEq, Eq)]
pub struct MeetingSignal {
    pub id: String,
    pub meeting: String,
    pub from: String,
    pub to: String,
    pub kind: SignalKind,
    pub payload: String,
    pub session: String,
    pub nonce: String,
    pub created_ns: u64,
    pub expires_ns: u64,
}
impl std::fmt::Debug for MeetingSignal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MeetingSignal([REDACTED])")
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct MeetingSnapshot {
    #[serde(default)]
    pub member_id: String,
    pub meetings: Vec<Meeting>,
    pub participants: Vec<Participant>,
    pub signals: Vec<MeetingSignal>,
    /// 065 不向普通成员公开 ended 记录；自己有成员行、但已不在活跃列表中的会议即已结束。
    #[serde(default)]
    pub ended_meetings: Vec<String>,
    pub server_ns: u64,
}
#[derive(Clone, Debug)]
pub enum MeetingEvent {
    Snapshot(Arc<MeetingSnapshot>),
    Participant(Participant),
    Signal(MeetingSignal),
    MeetingEnded(String),
    Reconnecting { attempt: u8 },
    Ended(MeetingError),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeetingStatus {
    Connecting,
    Connected,
    Reconnecting,
    Ended(MeetingError),
}

enum Operation {
    List,
    Create {
        title: String,
        conversation: Option<String>,
    },
    Join(String),
    Leave {
        meeting: String,
        user: Option<String>,
    },
    End(String),
    Heartbeat(String),
    Media {
        meeting: String,
        state: MediaState,
    },
    Signal {
        meeting: String,
        to: String,
        kind: SignalKind,
        payload: String,
        session: String,
        nonce: String,
    },
}
enum Reply {
    Snapshot(Arc<MeetingSnapshot>),
    Meeting(Meeting),
    Participant(Participant),
    Signal(MeetingSignal),
}
struct Command {
    operation: Operation,
    reply: oneshot::Sender<MeetingResult<Reply>>,
}
pub struct MeetingClient {
    commands: mpsc::Sender<Command>,
    events: broadcast::Sender<MeetingEvent>,
    snapshot: watch::Receiver<Arc<MeetingSnapshot>>,
    status: watch::Receiver<MeetingStatus>,
    cancel: watch::Sender<bool>,
    worker: Option<JoinHandle<()>>,
}
impl std::fmt::Debug for MeetingClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MeetingClient([REDACTED])")
    }
}
impl MeetingClient {
    pub async fn connect(
        client: &IdentityClient,
        session: Arc<Session>,
        config: &SurrealConfig,
        slug: &str,
    ) -> MeetingResult<Self> {
        session.ensure_current()?;
        if session.access() != Some("participant") {
            return Err(MeetingError::Identity);
        }
        let workspaces = timeout(
            Duration::from_secs(20),
            client.list_workspaces_async(&session),
        )
        .await
        .map_err(|_| MeetingError::Timeout)??;
        let workspace = workspaces
            .workspaces
            .into_iter()
            .find(|w| w.slug == slug)
            .ok_or(MeetingError::Identity)?;
        session.require_collaboration_scope(&workspace)?;
        let (commands, receiver) = mpsc::channel(32);
        let (events, _) = broadcast::channel(256);
        let (snapshot_tx, snapshot) = watch::channel(Arc::new(MeetingSnapshot::default()));
        let (status_tx, status) = watch::channel(MeetingStatus::Connecting);
        let (cancel, stop) = watch::channel(false);
        let (ready, wait) = oneshot::channel();
        let worker = Worker {
            client: client.clone(),
            session,
            config: config.clone(),
            workspace,
            commands: receiver,
            events: events.clone(),
            snapshot: snapshot_tx,
            status: status_tx,
            stop,
            ready: Some(ready),
            seen: HashMap::new(),
        };
        let handle = Self {
            commands,
            events,
            snapshot,
            status,
            cancel,
            worker: Some(tokio::spawn(worker.run())),
        };
        timeout(Duration::from_secs(60), wait)
            .await
            .map_err(|_| MeetingError::Timeout)?
            .map_err(|_| MeetingError::Stopped)??;
        Ok(handle)
    }
    pub fn subscribe(&self) -> broadcast::Receiver<MeetingEvent> {
        self.events.subscribe()
    }
    pub fn snapshot(&self) -> Arc<MeetingSnapshot> {
        self.snapshot.borrow().clone()
    }
    pub fn status(&self) -> watch::Receiver<MeetingStatus> {
        self.status.clone()
    }
    async fn request(&self, operation: Operation) -> MeetingResult<Reply> {
        if let MeetingStatus::Ended(error) = *self.status.borrow() {
            return Err(error);
        }
        let (reply, receive) = oneshot::channel();
        timeout(Duration::from_secs(45), async {
            self.commands
                .send(Command { operation, reply })
                .await
                .map_err(|_| MeetingError::Stopped)?;
            receive.await.map_err(|_| MeetingError::Stopped)?
        })
        .await
        .map_err(|_| MeetingError::Timeout)?
    }
    pub async fn meetings(&self) -> MeetingResult<Arc<MeetingSnapshot>> {
        match self.request(Operation::List).await? {
            Reply::Snapshot(v) => Ok(v),
            _ => Err(MeetingError::Protocol),
        }
    }
    pub async fn create(&self, title: &str, conversation: Option<&str>) -> MeetingResult<Meeting> {
        if title.trim().is_empty() || title.chars().count() > 200 {
            return Err(MeetingError::Input);
        }
        if let Some(room) = conversation {
            record(room, "chat_conversation")?;
        }
        match self
            .request(Operation::Create {
                title: title.into(),
                conversation: conversation.map(str::to_owned),
            })
            .await?
        {
            Reply::Meeting(v) => Ok(v),
            _ => Err(MeetingError::Protocol),
        }
    }
    pub async fn join(&self, code: &str) -> MeetingResult<Participant> {
        let code = code.trim().to_ascii_lowercase();
        if code.len() != 12 || !code.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(MeetingError::Input);
        }
        participant(self.request(Operation::Join(code)).await?)
    }
    pub async fn leave(&self, meeting: &str) -> MeetingResult<Participant> {
        self.remove(meeting, None).await
    }
    pub async fn remove_participant(
        &self,
        meeting: &str,
        user: &str,
    ) -> MeetingResult<Participant> {
        record(user, "user")?;
        self.remove(meeting, Some(user.into())).await
    }
    async fn remove(&self, meeting: &str, user: Option<String>) -> MeetingResult<Participant> {
        record(meeting, "meeting")?;
        participant(
            self.request(Operation::Leave {
                meeting: meeting.into(),
                user,
            })
            .await?,
        )
    }
    pub async fn end(&self, meeting: &str) -> MeetingResult<Meeting> {
        record(meeting, "meeting")?;
        match self.request(Operation::End(meeting.into())).await? {
            Reply::Meeting(v) => Ok(v),
            _ => Err(MeetingError::Protocol),
        }
    }
    pub async fn heartbeat(&self, meeting: &str) -> MeetingResult<Participant> {
        record(meeting, "meeting")?;
        participant(self.request(Operation::Heartbeat(meeting.into())).await?)
    }
    pub async fn update_media(
        &self,
        meeting: &str,
        state: MediaState,
    ) -> MeetingResult<Participant> {
        record(meeting, "meeting")?;
        participant(
            self.request(Operation::Media {
                meeting: meeting.into(),
                state,
            })
            .await?,
        )
    }
    /// session 标识一次协商，nonce 标识一次发送。超时不自动重发 offer/answer。
    pub async fn send_signal(
        &self,
        meeting: &str,
        to: &str,
        kind: SignalKind,
        payload: &str,
        session: &str,
        nonce: &str,
    ) -> MeetingResult<MeetingSignal> {
        record(meeting, "meeting")?;
        record(to, "user")?;
        key(session)?;
        key(nonce)?;
        if payload.is_empty() || payload.chars().count() > 49152 {
            return Err(MeetingError::Input);
        }
        match self
            .request(Operation::Signal {
                meeting: meeting.into(),
                to: to.into(),
                kind,
                payload: payload.into(),
                session: session.into(),
                nonce: nonce.into(),
            })
            .await?
        {
            Reply::Signal(v) => Ok(v),
            _ => Err(MeetingError::Protocol),
        }
    }
    pub async fn stop(mut self) -> MeetingResult<()> {
        self.cancel.send_replace(true);
        if let Some(worker) = self.worker.take() {
            timeout(Duration::from_secs(5), worker)
                .await
                .map_err(|_| MeetingError::Timeout)?
                .map_err(|_| MeetingError::Stopped)?;
        }
        Ok(())
    }
}
impl Drop for MeetingClient {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}
pub fn fresh_key() -> MeetingResult<String> {
    let mut bytes = [0; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| MeetingError::Input)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn key(value: &str) -> MeetingResult<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(MeetingError::Input)
    }
}
pub(crate) fn record(value: &str, table: &str) -> MeetingResult<()> {
    if value.len() > 512
        || !value.starts_with(&format!("{table}:"))
        || value.len() <= table.len() + 1
    {
        Err(MeetingError::Input)
    } else {
        Ok(())
    }
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> MeetingResult<T> {
    serde_json::from_value(value).map_err(|_| MeetingError::Protocol)
}
fn one<T: serde::de::DeserializeOwned>(value: Value) -> MeetingResult<T> {
    let mut rows: Vec<T> = decode(value)?;
    if rows.len() != 1 {
        return Err(MeetingError::Database);
    }
    Ok(rows.remove(0))
}
fn participant(reply: Reply) -> MeetingResult<Participant> {
    match reply {
        Reply::Participant(v) => Ok(v),
        _ => Err(MeetingError::Protocol),
    }
}
fn transient(error: MeetingError) -> bool {
    matches!(error, MeetingError::Network | MeetingError::Timeout)
}
struct Worker {
    client: IdentityClient,
    session: Arc<Session>,
    config: SurrealConfig,
    workspace: Workspace,
    commands: mpsc::Receiver<Command>,
    events: broadcast::Sender<MeetingEvent>,
    snapshot: watch::Sender<Arc<MeetingSnapshot>>,
    status: watch::Sender<MeetingStatus>,
    stop: watch::Receiver<bool>,
    ready: Option<oneshot::Sender<MeetingResult<()>>>,
    seen: HashMap<String, u64>,
}
impl Worker {
    async fn establish(&self) -> MeetingResult<Wire> {
        self.session.ensure_current()?;
        let list = timeout(
            Duration::from_secs(20),
            self.client.list_workspaces_async(&self.session),
        )
        .await
        .map_err(|_| MeetingError::Timeout)??;
        if !list
            .workspaces
            .iter()
            .any(|w| w.slug == self.workspace.slug && w.db_name == self.workspace.db_name)
        {
            return Err(MeetingError::Identity);
        }
        Ok(Wire::new(
            connect_authenticated(&self.session, &self.config, &self.workspace).await?,
        ))
    }
    async fn verify(&self, wire: &Wire) -> MeetingResult<String> {
        self.session.ensure_current()?;
        let rows: Vec<Value> = decode(
            wire.query(include_str!("../sql/signal-identity.surql"), json!({}))
                .await?,
        )?;
        if rows.len() != 1 || rows[0]["subject"].as_str() != Some(self.session.subject()) {
            return Err(MeetingError::Identity);
        }
        rows[0]["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or(MeetingError::Identity)
    }
    async fn run(mut self) {
        let mut attempts = 0u8;
        let terminal = loop {
            let mut stop = self.stop.clone();
            let result = tokio::select! { _=stop.changed()=>break MeetingError::Stopped, v=self.establish()=>v };
            let result = match result {
                Ok(mut wire) => {
                    let mut stop = self.stop.clone();
                    let result = tokio::select! { _=stop.changed()=>Err(MeetingError::Stopped), v=self.connected(&mut wire,&mut attempts)=>v };
                    wire.close().await;
                    result
                }
                Err(error) => Err(error),
            };
            let error = result.err().unwrap_or(MeetingError::Stopped);
            if !transient(error) || attempts >= 5 {
                break error;
            }
            attempts += 1;
            self.status.send_replace(MeetingStatus::Reconnecting);
            let _ = self
                .events
                .send(MeetingEvent::Reconnecting { attempt: attempts });
            let mut stop = self.stop.clone();
            tokio::select! { _=stop.changed()=>break MeetingError::Stopped, _=sleep(Duration::from_millis(200u64 << attempts))=>{} }
        };
        if let Some(ready) = self.ready.take() {
            let _ = ready.send(Err(terminal));
        }
        self.status.send_replace(MeetingStatus::Ended(terminal));
        let _ = self.events.send(MeetingEvent::Ended(terminal));
        self.commands.close();
        while let Some(command) = self.commands.recv().await {
            let _ = command.reply.send(Err(terminal));
        }
    }
    async fn connected(&mut self, wire: &mut Wire, attempts: &mut u8) -> MeetingResult<()> {
        self.verify(wire).await?;
        let signals = wire
            .live("LIVE SELECT * FROM meeting_signal WHERE to=$auth.id;")
            .await?;
        let participants = wire.live("LIVE SELECT * FROM meeting_participant;").await?;
        let meetings = wire.live("LIVE SELECT * FROM meeting;").await?;
        self.refresh(wire).await?;
        *attempts = 0;
        self.status.send_replace(MeetingStatus::Connected);
        if let Some(ready) = self.ready.take() {
            let _ = ready.send(Ok(()));
        }
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
        loop {
            tokio::select! {
                notice=wire.notices.recv()=> {
                    let notice=notice.ok_or(MeetingError::Network)?;
                    let id=notice["id"].as_str().ok_or(MeetingError::Protocol)?;
                    if id==participants {
                        let participant=decode(notice["result"].clone())?;
                        let _=self.events.send(MeetingEvent::Participant(participant));
                    } else if id!=signals && id!=meetings { return Err(MeetingError::Protocol); }
                    self.refresh(wire).await?;
                }
                command=self.commands.recv()=> {
                    let command=command.ok_or(MeetingError::Stopped)?;
                    if command.reply.is_closed() {continue;}
                    let result=self.execute(wire,command.operation).await;
                    let fatal=result.as_ref().err().copied().filter(|e|transient(*e)||matches!(e,MeetingError::Identity|MeetingError::Expired|MeetingError::Authentication));
                    let _=command.reply.send(result);
                    if let Some(error)=fatal {return Err(error);}
                }
                _=tick.tick()=> {self.refresh(wire).await?;}
                _=heartbeat.tick()=> {
                    self.verify(wire).await?;
                    match wire.query("UPDATE meeting_participant SET last_seen=time::now() WHERE user=$auth.id AND left_at=NONE;",json!({})).await {
                        Ok(_)|Err(ChatError::Conflict)=>{}, Err(error)=>return Err(error.into()),
                    }
                }
                _=wire.failure.changed()=>return Err(wire.failure.borrow().unwrap_or(ChatError::Network).into()),
            }
        }
    }
    async fn refresh(&mut self, wire: &Wire) -> MeetingResult<Arc<MeetingSnapshot>> {
        let member_id = self.verify(wire).await?;
        let raw: MeetingSnapshot = decode(
            wire.query(include_str!("../sql/meeting-snapshot.surql"), json!({}))
                .await?,
        )?;
        let MeetingSnapshot {
            meetings,
            participants,
            signals,
            server_ns,
            ..
        } = raw;
        if meetings.len() > 512 || participants.len() > 4096 || signals.len() > 8192 {
            return Err(MeetingError::Overflow);
        }
        let mut ended_meetings: Vec<String> = participants
            .iter()
            .filter(|p| p.user == member_id && !meetings.iter().any(|m| m.id == p.meeting))
            .map(|p| p.meeting.clone())
            .collect();
        ended_meetings.sort();
        ended_meetings.dedup();
        let previous = self.snapshot.borrow().clone();
        let ended: Vec<_> = ended_meetings
            .iter()
            .filter(|id| !previous.ended_meetings.contains(id))
            .cloned()
            .collect();
        self.seen.retain(|_, expiry| *expiry > server_ns);
        let mut incoming = Vec::new();
        for signal in &signals {
            if signal.to != member_id {
                return Err(MeetingError::Protocol);
            }
            if signal.expires_ns > server_ns && !self.seen.contains_key(&signal.id) {
                if self.seen.len() >= 8192 {
                    return Err(MeetingError::Overflow);
                }
                self.seen.insert(signal.id.clone(), signal.expires_ns);
                incoming.push(signal.clone());
            }
        }
        let snapshot = Arc::new(MeetingSnapshot {
            member_id,
            meetings,
            participants,
            signals,
            ended_meetings,
            server_ns,
        });
        self.snapshot.send_replace(snapshot.clone());
        let _ = self.events.send(MeetingEvent::Snapshot(snapshot.clone()));
        for id in ended {
            let _ = self.events.send(MeetingEvent::MeetingEnded(id));
        }
        for signal in incoming {
            let _ = self.events.send(MeetingEvent::Signal(signal));
        }
        Ok(snapshot)
    }
    async fn execute(&mut self, wire: &Wire, operation: Operation) -> MeetingResult<Reply> {
        self.verify(wire).await?;
        let (sql,vars)=match operation {
            Operation::List=>return Ok(Reply::Snapshot(self.refresh(wire).await?)),
            Operation::Create {title,conversation} => ("CREATE meeting CONTENT {title:type::string_lossy(encoding::base64::decode($title64)),conversation:IF $conversation='' {NONE} ELSE {type::record($conversation)}};",json!({"title64":STANDARD.encode(title),"conversation":conversation.unwrap_or_default()})),
            Operation::Join(code)=>("RETURN fn::meeting_join(type::string_lossy(encoding::base64::decode($code64)));",json!({"code64":STANDARD.encode(code)})),
            Operation::Leave {meeting,user}=>("UPDATE meeting_participant SET left_at=time::now() WHERE meeting=type::record($room) AND user=(IF $user='' {$auth.id} ELSE {type::record($user)}) AND left_at=NONE;",json!({"room":meeting,"user":user.unwrap_or_default()})),
            Operation::End(meeting)=>("UPDATE type::record($room) SET status='ended';",json!({"room":meeting})),
            Operation::Heartbeat(meeting)=>("UPDATE meeting_participant SET last_seen=time::now() WHERE meeting=type::record($room) AND user=$auth.id AND left_at=NONE;",json!({"room":meeting})),
            Operation::Media {meeting,state}=>("UPDATE meeting_participant SET mic=$mic,cam=$cam,screen=$screen WHERE meeting=type::record($room) AND user=$auth.id AND left_at=NONE;",json!({"room":meeting,"mic":state.mic,"cam":state.cam,"screen":state.screen})),
            Operation::Signal {meeting,to,kind,payload,session,nonce}=>("LET $sent=CREATE meeting_signal CONTENT {meeting:type::record($room),to:type::record($to),kind:$kind,payload:type::string_lossy(encoding::base64::decode($payload64)),session:$session_key,nonce:$nonce}; SELECT *,time::nano(created_at) AS created_ns,time::nano(expires_at) AS expires_ns FROM $sent;",json!({"room":meeting,"to":to,"kind":kind.name(),"payload64":STANDARD.encode(payload),"session_key":session,"nonce":nonce})),
        };
        let mut attempts = 0;
        let value = loop {
            match wire.query(sql, vars.clone()).await {
                Err(ChatError::Conflict) if attempts < 3 => {
                    attempts += 1;
                    sleep(Duration::from_millis(50 << attempts)).await;
                    self.verify(wire).await?;
                }
                result => break result?,
            }
        };
        let rows = value.as_array().ok_or(MeetingError::Protocol)?;
        let row = rows.first().ok_or(MeetingError::Database)?;
        let reply = if row.get("payload").is_some() {
            Reply::Signal(one(value)?)
        } else if row.get("code").is_some() {
            Reply::Meeting(one(value)?)
        } else {
            Reply::Participant(one(value)?)
        };
        self.refresh(wire).await?;
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys_records_and_redaction() {
        let value = fresh_key().unwrap();
        key(&value).unwrap();
        assert_ne!(value, fresh_key().unwrap());
        for value in ["", "x", &"G".repeat(64)] {
            assert_eq!(key(value), Err(MeetingError::Input));
        }
        assert!(record("meeting:room", "meeting").is_ok());
        assert_eq!(record("user:room", "meeting"), Err(MeetingError::Input));
        assert!(one::<Meeting>(json!([])).is_err());
        assert!(decode::<Meeting>(json!({})).is_err());
    }
}
