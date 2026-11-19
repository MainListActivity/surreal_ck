//! Participant workspace 聊天。事件接收者遇到 broadcast Lagged 必须重新读取 snapshot。
//! Snapshot 替换会话摘要，Message 才是消息追加；历史通过 messages 分页读取。
//! 最多 512 个会话、32 个排队命令、256 个 LIVE 通知；溢出明确结束而不静默丢弃。
//! 重连按上次成功补拉的服务端时间补偿，并重叠 30 秒去重，单次窗口最多 4096 条。
//! Drop 异步清理依赖 Tokio runtime 继续运行；退出 runtime 前应 await stop()。
use crate::{
    members::connect_authenticated, IdentityClient, IdentityError, Session, SurrealConfig,
    Workspace,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::{
    sync::{broadcast, mpsc, oneshot, watch},
    task::JoinHandle,
    time::{sleep, timeout},
};

#[path = "chat_wire.rs"]
pub(crate) mod wire;
use wire::Wire;

pub type ChatResult<T> = std::result::Result<T, ChatError>;
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ChatError {
    #[error("聊天会话已过期，请重新登录")]
    Expired,
    #[error("聊天成员身份失效")]
    Identity,
    #[error("聊天认证被拒绝")]
    Authentication,
    #[error("工作区尚未启用聊天")]
    NotEnabled,
    #[error("聊天连接中断")]
    Network,
    #[error("聊天请求超时；可用同一 client_id 核对或重发")]
    Timeout,
    #[error("聊天数据库拒绝请求")]
    Database,
    #[error("聊天事务冲突，可安全重试")]
    Conflict,
    #[error("聊天输入无效")]
    Input,
    #[error("聊天协议响应无效")]
    Protocol,
    #[error("聊天缓冲区已满，需重新同步")]
    Overflow,
    #[error("聊天已停止")]
    Stopped,
}
impl From<IdentityError> for ChatError {
    fn from(error: IdentityError) -> Self {
        match error {
            IdentityError::SessionExpired => Self::Expired,
            IdentityError::Network => Self::Network,
            IdentityError::Database | IdentityError::Token | IdentityError::Http(401 | 403) => {
                Self::Authentication
            }
            _ => Self::Identity,
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: String,
    pub conversation: String,
    pub sender: String,
    pub body: String,
    pub client_id: String,
    pub created_at: String,
}
impl std::fmt::Debug for ChatMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ChatMessage([REDACTED])")
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConversationKind {
    Direct,
    Group,
}
#[derive(Clone, Debug, Deserialize)]
pub struct ChatPeer {
    pub id: String,
    pub display_name: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub kind: ConversationKind,
    pub title: Option<String>,
    pub peer: Option<ChatPeer>,
    pub last_message: Option<ChatMessage>,
    pub unread_count: u64,
    pub member_count: u64,
}
#[derive(Clone, Debug, Default)]
pub struct ChatSnapshot {
    pub conversations: Vec<Conversation>,
    pub member_id: String,
}
#[derive(Clone, Debug)]
pub enum ChatEvent {
    Snapshot(Arc<ChatSnapshot>),
    Message(ChatMessage),
    Membership { conversation: String, joined: bool },
    Reconnecting { attempt: u8 },
    Ended(ChatError),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatStatus {
    Connecting,
    Connected,
    Reconnecting,
    Ended(ChatError),
}
#[derive(Clone, Debug)]
pub struct MessageCursor {
    pub created_at: String,
    pub id: String,
}

enum Operation {
    List,
    History {
        room: String,
        before: Option<MessageCursor>,
        limit: u16,
    },
    Direct(String),
    Group {
        title: String,
        members: Vec<String>,
    },
    Send {
        room: String,
        body: String,
        client: String,
    },
    Read(String),
}
enum Reply {
    List(Vec<Conversation>),
    Messages(Vec<ChatMessage>),
    Room(String),
    Message(ChatMessage),
    Read,
}
struct Command {
    operation: Operation,
    reply: oneshot::Sender<ChatResult<Reply>>,
}

pub struct ChatClient {
    commands: mpsc::Sender<Command>,
    events: broadcast::Sender<ChatEvent>,
    snapshot: watch::Receiver<Arc<ChatSnapshot>>,
    status: watch::Receiver<ChatStatus>,
    cancel: watch::Sender<bool>,
    worker: Option<JoinHandle<()>>,
}
impl std::fmt::Debug for ChatClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ChatClient([REDACTED])")
    }
}
impl ChatClient {
    pub async fn connect(
        client: &IdentityClient,
        session: Arc<Session>,
        config: &SurrealConfig,
        slug: &str,
    ) -> ChatResult<Self> {
        session.ensure_current()?;
        if session.access() != Some("participant") {
            return Err(ChatError::Identity);
        }
        let workspaces = timeout(
            Duration::from_secs(20),
            client.list_workspaces_async(&session),
        )
        .await
        .map_err(|_| ChatError::Timeout)??;
        let workspace = workspaces
            .workspaces
            .into_iter()
            .find(|v| v.slug == slug)
            .ok_or(ChatError::Identity)?;
        session.require_collaboration_scope(&workspace)?;
        let (tx, commands) = mpsc::channel(32);
        let (events, _) = broadcast::channel(256);
        let (snap, snapshot) = watch::channel(Arc::new(ChatSnapshot::default()));
        let (state, status) = watch::channel(ChatStatus::Connecting);
        let (cancel, stop) = watch::channel(false);
        let (ready, wait) = oneshot::channel();
        let worker = Worker {
            client: client.clone(),
            session,
            config: config.clone(),
            workspace,
            commands,
            events: events.clone(),
            snapshot: snap,
            status: state,
            stop,
            ready: Some(ready),
            seen: HashSet::new(),
            rooms: HashSet::new(),
            since: None,
            member_id: String::new(),
        };
        let handle = Self {
            commands: tx,
            events,
            snapshot,
            status,
            cancel,
            worker: Some(tokio::spawn(worker.run())),
        };
        timeout(Duration::from_secs(60), wait)
            .await
            .map_err(|_| ChatError::Timeout)?
            .map_err(|_| ChatError::Stopped)??;
        Ok(handle)
    }
    pub fn subscribe(&self) -> broadcast::Receiver<ChatEvent> {
        self.events.subscribe()
    }
    pub fn snapshot(&self) -> Arc<ChatSnapshot> {
        self.snapshot.borrow().clone()
    }
    pub fn status(&self) -> watch::Receiver<ChatStatus> {
        self.status.clone()
    }
    async fn request(&self, operation: Operation) -> ChatResult<Reply> {
        if let ChatStatus::Ended(error) = *self.status.borrow() {
            return Err(error);
        }
        let (reply, rx) = oneshot::channel();
        timeout(Duration::from_secs(45), async {
            self.commands
                .send(Command { operation, reply })
                .await
                .map_err(|_| ChatError::Stopped)?;
            rx.await.map_err(|_| ChatError::Stopped)?
        })
        .await
        .map_err(|_| ChatError::Timeout)?
    }
    pub async fn conversations(&self) -> ChatResult<Vec<Conversation>> {
        match self.request(Operation::List).await? {
            Reply::List(v) => Ok(v),
            _ => Err(ChatError::Protocol),
        }
    }
    pub async fn messages(
        &self,
        room: &str,
        before: Option<MessageCursor>,
        limit: u16,
    ) -> ChatResult<Vec<ChatMessage>> {
        record(room, "chat_conversation")?;
        if limit == 0 || limit > 200 {
            return Err(ChatError::Input);
        }
        if let Some(ref c) = before {
            record(&c.id, "chat_message")?;
            if c.created_at.len() > 64 {
                return Err(ChatError::Input);
            }
        }
        match self
            .request(Operation::History {
                room: room.into(),
                before,
                limit,
            })
            .await?
        {
            Reply::Messages(v) => Ok(v),
            _ => Err(ChatError::Protocol),
        }
    }
    pub async fn open_direct(&self, peer: &str) -> ChatResult<String> {
        record(peer, "user")?;
        match self.request(Operation::Direct(peer.into())).await? {
            Reply::Room(v) => Ok(v),
            _ => Err(ChatError::Protocol),
        }
    }
    pub async fn create_group(&self, title: &str, members: &[String]) -> ChatResult<String> {
        if title.trim().is_empty() || title.chars().count() > 200 || members.len() > 100 {
            return Err(ChatError::Input);
        }
        for member in members {
            record(member, "user")?;
        }
        match self
            .request(Operation::Group {
                title: title.into(),
                members: members.to_vec(),
            })
            .await?
        {
            Reply::Room(v) => Ok(v),
            _ => Err(ChatError::Protocol),
        }
    }
    pub async fn send(&self, room: &str, body: &str, client_id: &str) -> ChatResult<ChatMessage> {
        record(room, "chat_conversation")?;
        if body.trim().is_empty()
            || body.chars().count() > 4000
            || client_id.is_empty()
            || client_id.len() > 128
        {
            return Err(ChatError::Input);
        }
        match self
            .request(Operation::Send {
                room: room.into(),
                body: body.into(),
                client: client_id.into(),
            })
            .await?
        {
            Reply::Message(v) => Ok(v),
            _ => Err(ChatError::Protocol),
        }
    }
    pub async fn mark_read(&self, room: &str) -> ChatResult<()> {
        record(room, "chat_conversation")?;
        match self.request(Operation::Read(room.into())).await? {
            Reply::Read => Ok(()),
            _ => Err(ChatError::Protocol),
        }
    }
    pub async fn stop(mut self) -> ChatResult<()> {
        self.cancel.send_replace(true);
        if let Some(worker) = self.worker.take() {
            timeout(Duration::from_secs(5), worker)
                .await
                .map_err(|_| ChatError::Timeout)?
                .map_err(|_| ChatError::Stopped)?;
        }
        Ok(())
    }
}
impl Drop for ChatClient {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}

fn record(value: &str, table: &str) -> ChatResult<()> {
    if value.len() > 512
        || !value.starts_with(&format!("{table}:"))
        || value.len() <= table.len() + 1
    {
        Err(ChatError::Input)
    } else {
        Ok(())
    }
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> ChatResult<T> {
    serde_json::from_value(value).map_err(|_| ChatError::Protocol)
}
fn transient(error: ChatError) -> bool {
    matches!(error, ChatError::Network | ChatError::Timeout)
}

struct Worker {
    client: IdentityClient,
    session: Arc<Session>,
    config: SurrealConfig,
    workspace: Workspace,
    commands: mpsc::Receiver<Command>,
    events: broadcast::Sender<ChatEvent>,
    snapshot: watch::Sender<Arc<ChatSnapshot>>,
    status: watch::Sender<ChatStatus>,
    stop: watch::Receiver<bool>,
    ready: Option<oneshot::Sender<ChatResult<()>>>,
    seen: HashSet<String>,
    rooms: HashSet<String>,
    since: Option<String>,
    member_id: String,
}
impl Worker {
    async fn verify(&mut self, wire: &Wire) -> ChatResult<()> {
        self.session.ensure_current()?;
        let value = wire
            .query(include_str!("../sql/signal-identity.surql"), json!({}))
            .await?;
        let rows = value.as_array().ok_or(ChatError::Protocol)?;
        if rows.len() != 1 || rows[0]["subject"].as_str() != Some(self.session.subject()) {
            return Err(ChatError::Identity);
        }
        self.member_id = rows[0]["id"]
            .as_str()
            .ok_or(ChatError::Protocol)?
            .to_owned();
        Ok(())
    }
    async fn establish(&self) -> ChatResult<Wire> {
        self.session.ensure_current()?;
        let workspaces = timeout(
            Duration::from_secs(20),
            self.client.list_workspaces_async(&self.session),
        )
        .await
        .map_err(|_| ChatError::Timeout)??;
        if !workspaces
            .workspaces
            .iter()
            .any(|v| v.slug == self.workspace.slug && v.db_name == self.workspace.db_name)
        {
            return Err(ChatError::Identity);
        }
        let socket = connect_authenticated(&self.session, &self.config, &self.workspace).await?;
        Ok(Wire::new(socket))
    }
    async fn run(mut self) {
        let mut attempts = 0u8;
        let terminal = loop {
            let mut stop = self.stop.clone();
            let established = tokio::select! { _=stop.changed()=>break ChatError::Stopped, v=self.establish()=>v };
            let result = match established {
                Ok(mut wire) => {
                    let mut stop = self.stop.clone();
                    let result = tokio::select! { _=stop.changed()=>Err(ChatError::Stopped), v=self.connected(&mut wire,&mut attempts)=>v };
                    wire.close().await;
                    result
                }
                Err(error) => Err(error),
            };
            let error = result.err().unwrap_or(ChatError::Stopped);
            if !transient(error) || attempts >= 5 {
                break error;
            }
            attempts += 1;
            self.status.send_replace(ChatStatus::Reconnecting);
            let _ = self
                .events
                .send(ChatEvent::Reconnecting { attempt: attempts });
            let mut stop = self.stop.clone();
            tokio::select! { _=stop.changed()=>break ChatError::Stopped, _=sleep(Duration::from_millis(200u64 << attempts))=>{} }
        };
        if let Some(ready) = self.ready.take() {
            let _ = ready.send(Err(terminal));
        }
        self.status.send_replace(ChatStatus::Ended(terminal));
        let _ = self.events.send(ChatEvent::Ended(terminal));
        self.commands.close();
        while let Some(command) = self.commands.recv().await {
            let _ = command.reply.send(Err(terminal));
        }
    }
    async fn connected(&mut self, wire: &mut Wire, attempts: &mut u8) -> ChatResult<()> {
        self.verify(wire).await?;
        wire.query("RETURN fn::chat_active($auth.id);", json!({}))
            .await?;
        let started = wire.query("RETURN time::now();", json!({})).await?;
        let until: String = decode(started)?;
        let initial = self.since.is_none();
        if initial {
            self.since = Some(until.clone());
        }
        let messages = wire.live("LIVE SELECT * FROM chat_message;").await?;
        let members = wire
            .live("LIVE SELECT * FROM chat_member WHERE user=$auth.id;")
            .await?;
        self.refresh(wire).await?;
        self.catch_up(wire, &until, initial).await?;
        *attempts = 0;
        self.status.send_replace(ChatStatus::Connected);
        if let Some(ready) = self.ready.take() {
            let _ = ready.send(Ok(()));
        }
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                notice=wire.notices.recv()=> {
                    let notice=notice.ok_or(ChatError::Network)?;
                    if notice["id"].as_str()==Some(&messages) {
                        let message:ChatMessage=decode(notice["result"].clone())?;
                        self.deliver(message)?;
                        self.refresh(wire).await?;
                    } else if notice["id"].as_str()==Some(&members) {
                        self.refresh(wire).await?;
                    } else {return Err(ChatError::Protocol);}
                }
                command=self.commands.recv()=> {
                    let command=command.ok_or(ChatError::Stopped)?;
                    if command.reply.is_closed() {continue;}
                    if let Err(error)=self.verify(wire).await {
                        let _=command.reply.send(Err(error));
                        return Err(error);
                    }
                    let result=self.execute(wire,command.operation).await;
                    let fatal=result.as_ref().err().copied().filter(|e|transient(*e)||matches!(e,ChatError::Identity|ChatError::Expired|ChatError::Authentication));
                    let _=command.reply.send(result);
                    if let Some(error)=fatal {return Err(error);}
                }
                _=tick.tick()=> {
                    self.verify(wire).await?;
                    let until: String=decode(wire.query("RETURN time::now();",json!({})).await?)?;
                    self.catch_up(wire,&until,false).await?;
                }
                _=wire.failure.changed()=>return Err(wire.failure.borrow().unwrap_or(ChatError::Network)),
            }
        }
    }
    fn deliver(&mut self, message: ChatMessage) -> ChatResult<()> {
        if self.seen.len() >= 8192 && !self.seen.contains(&message.id) {
            return Err(ChatError::Overflow);
        }
        if self.seen.insert(message.id.clone()) {
            let _ = self.events.send(ChatEvent::Message(message));
        }
        Ok(())
    }
    async fn catch_up(&mut self, wire: &Wire, until: &str, initial: bool) -> ChatResult<()> {
        let since = self.since.clone().ok_or(ChatError::Protocol)?;
        let mut after_time = String::new();
        let mut after_id = String::new();
        let mut retained = HashSet::new();
        loop {
            let value=wire.query(include_str!("../sql/chat-catchup.surql"),json!({"since":since,"until":until,"overlap":if initial {0}else{30},"after_time":if after_time.is_empty(){&since}else{&after_time},"after_id":after_id})).await?;
            let batch: Vec<ChatMessage> = decode(value)?;
            let full = batch.len() == 100;
            for message in batch {
                after_time = message.created_at.clone();
                after_id = message.id.clone();
                retained.insert(message.id.clone());
                if retained.len() > 4096 {
                    return Err(ChatError::Overflow);
                }
                self.deliver(message)?;
            }
            if !full {
                break;
            }
        }
        self.seen = retained;
        self.since = Some(until.to_owned());
        Ok(())
    }
    async fn refresh(&mut self, wire: &Wire) -> ChatResult<Vec<Conversation>> {
        let rooms: Vec<Value> = decode(
            wire.query(
                "SELECT id,kind,title FROM chat_conversation LIMIT 513;",
                json!({}),
            )
            .await?,
        )?;
        if rooms.len() > 512 {
            return Err(ChatError::Overflow);
        }
        let mut conversations = Vec::with_capacity(rooms.len());
        for room in rooms {
            let value = wire
                .query(
                    include_str!("../sql/chat-summary.surql"),
                    json!({"room":room["id"]}),
                )
                .await?;
            let mut conversation: Conversation = decode(value)?;
            if conversation.kind == ConversationKind::Group {
                conversation.peer = None;
            }
            conversations.push(conversation);
        }
        let current: HashSet<String> = conversations.iter().map(|v| v.id.clone()).collect();
        for room in current.difference(&self.rooms) {
            let _ = self.events.send(ChatEvent::Membership {
                conversation: room.clone(),
                joined: true,
            });
        }
        for room in self.rooms.difference(&current) {
            let _ = self.events.send(ChatEvent::Membership {
                conversation: room.clone(),
                joined: false,
            });
        }
        self.rooms = current;
        let snapshot = Arc::new(ChatSnapshot {
            conversations: conversations.clone(),
            member_id: self.member_id.clone(),
        });
        self.snapshot.send_replace(snapshot.clone());
        let _ = self.events.send(ChatEvent::Snapshot(snapshot));
        Ok(conversations)
    }
    async fn execute(&mut self, wire: &Wire, operation: Operation) -> ChatResult<Reply> {
        match operation {
            Operation::List => Ok(Reply::List(self.refresh(wire).await?)),
            Operation::History {
                room,
                before,
                limit,
            } => {
                let (time, id) = before.map(|v| (v.created_at, v.id)).unwrap_or_default();
                let value=wire.query(include_str!("../sql/chat-history.surql"),json!({"room":room,"time":if time.is_empty(){"1970-01-01T00:00:00Z"}else{&time},"id":id,"limit":limit})).await?;
                Ok(Reply::Messages(decode(value)?))
            }
            Operation::Direct(peer) => {
                let mut attempts = 0;
                let value = loop {
                    match wire
                        .query(
                            "RETURN fn::chat_direct(type::record($peer));",
                            json!({"peer":peer}),
                        )
                        .await
                    {
                        Err(ChatError::Conflict) if attempts < 3 => {
                            attempts += 1;
                            sleep(Duration::from_millis(50 << attempts)).await;
                            self.session.ensure_current()?;
                        }
                        result => break result?,
                    }
                };
                self.refresh(wire).await?;
                Ok(Reply::Room(decode(value)?))
            }
            Operation::Group { title, members } => {
                let value = wire
                    .query(
                        include_str!("../sql/chat-group.surql"),
                        json!({"title64":STANDARD.encode(&title),"members":members}),
                    )
                    .await?;
                self.refresh(wire).await?;
                Ok(Reply::Room(decode(value)?))
            }
            Operation::Send { room, body, client } => {
                let value=wire.query(include_str!("../sql/chat-send.surql"),json!({"room":room,"body64":STANDARD.encode(&body),"client64":STANDARD.encode(&client)})).await?;
                let rows: Vec<ChatMessage> = decode(value)?;
                let message = rows.into_iter().next().ok_or(ChatError::Database)?;
                if message.conversation != room || message.body != body {
                    return Err(ChatError::Input);
                }
                self.deliver(message.clone())?;
                self.refresh(wire).await?;
                Ok(Reply::Message(message))
            }
            Operation::Read(room) => {
                let value=wire.query("UPDATE chat_member SET last_read_at=time::now() WHERE conversation=type::record($room) AND user=$auth.id;",json!({"room":room})).await?;
                if value.as_array().is_none_or(Vec::is_empty) {
                    return Err(ChatError::Database);
                }
                self.refresh(wire).await?;
                Ok(Reply::Read)
            }
        }
    }
}
