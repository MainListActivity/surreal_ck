//! 固定 062 信令接口。没有公开 SQL、bearer、root、任意表或任意数据库入口。
use crate::{
    members::{connect_authenticated, rpc, DatabaseSocket},
    IdentityClient, IdentityError, Result, Session, SurrealConfig,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::time::timeout;

const IDENTITY: &str = include_str!("../sql/signal-identity.surql");
const REVALIDATE: &str = include_str!("../sql/signal-revalidate.surql");
const INVITE: &str = include_str!("../sql/signal-invite.surql");
const INBOX: &str = include_str!("../sql/signal-inbox.surql");
const READ: &str = include_str!("../sql/signal-read.surql");
const ACCEPT: &str = include_str!("../sql/signal-accept.surql");
const REJECT: &str = include_str!("../sql/signal-reject.surql");
const ANSWER: &str = include_str!("../sql/signal-answer.surql");
const END: &str = include_str!("../sql/signal-end.surql");

#[derive(Clone, PartialEq, Eq)]
pub struct SignalBinding {
    pub id: String,
    pub workspace: String,
    pub sender: String,
    pub recipient: String,
    pub nonce: String,
    pub generation: String,
    pub offer_hash: String,
    /// 数据库返回的精确 RFC3339，必须原样用于更新的 compare-and-swap。
    pub expires_at: String,
}
impl fmt::Debug for SignalBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SignalBinding([REDACTED])")
    }
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SignalStatus {
    Pending,
    Accepted,
    Answered,
    Rejected,
    Ended,
}
/// 只表示一次数据库响应，不能当作可从 JSON 生成的 AuthenticatedOffer/Answer。
pub struct SignalRow {
    pub binding: SignalBinding,
    pub status: SignalStatus,
    pub offer: String,
    pub answer: Option<String>,
    pub created_at: String,
    pub server_now: String,
    pub expires_unix: u64,
    pub server_unix: u64,
}
impl fmt::Debug for SignalRow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SignalRow([REDACTED])")
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignalSummary {
    pub id: String,
    pub sender: String,
    pub expires_at: String,
    pub server_now: String,
    pub expires_unix: u64,
    pub server_unix: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRow {
    id: String,
    workspace: String,
    sender: String,
    recipient: String,
    nonce: String,
    generation: String,
    offer_hash: String,
    offer: String,
    answer: Option<String>,
    status: SignalStatus,
    created_at: String,
    expires_at: String,
    server_now: String,
    expires_unix: u64,
    server_unix: u64,
}
/// 每个连接持有一份后台 Session；切换账号/工作区/连接代际时必须丢弃整条连接。
pub struct SignalConnection {
    socket: DatabaseSocket,
    session: Arc<Session>,
    database: String,
    member_id: String,
    request_id: u64,
    closed: bool,
    last_inbox: Option<Instant>,
    last_read: Option<(String, Instant)>,
    last_invite: Option<Instant>,
}
impl fmt::Debug for SignalConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SignalConnection([REDACTED])")
    }
}
impl SignalConnection {
    pub async fn connect(
        client: &IdentityClient,
        session: Arc<Session>,
        config: &SurrealConfig,
        slug: &str,
    ) -> Result<Self> {
        let workspaces = client.list_workspaces_async(&session).await?;
        let workspace = workspaces
            .workspaces
            .iter()
            .find(|workspace| workspace.slug == slug)
            .ok_or(IdentityError::Forbidden)?;
        session.require_collaboration_scope(workspace)?;
        // admin TYPE JWT 没有可冒充的 RECORD $auth.id；绝不从 UI 或 member 列表代填 sender。
        if session.access.as_deref() != Some("participant") {
            return Err(IdentityError::SignalRecordRequired);
        }
        let mut socket = connect_authenticated(&session, config, workspace).await?;
        let result = timeout(
            Duration::from_secs(15),
            rpc(
                &mut socket,
                3,
                "query",
                json!([IDENTITY, {"subject":session.subject()}]),
            ),
        )
        .await
        .map_err(|_| IdentityError::Network)??;
        let rows = statement_rows(result)?;
        if rows.len() != 1 {
            return Err(IdentityError::SignalRecordRequired);
        }
        let member_id = rows[0]
            .get("id")
            .and_then(Value::as_str)
            .ok_or(IdentityError::SignalRecordRequired)?
            .to_owned();
        member_key(&member_id).map_err(|_| IdentityError::SignalRecordRequired)?;
        session.ensure_current()?;
        Ok(Self {
            socket,
            session,
            database: workspace.db_name.clone(),
            member_id,
            request_id: 3,
            closed: false,
            last_inbox: None,
            last_read: None,
            last_invite: None,
        })
    }
    pub fn database(&self) -> &str {
        &self.database
    }
    pub fn member_id(&self) -> &str {
        &self.member_id
    }
    /// 供宿主定时关闭已过期的 P2P 会话；不泄露 bearer。
    pub fn ensure_current(&self) -> Result<()> {
        self.current()
    }
    pub fn session_expires_at(&self) -> u64 {
        self.session.expires_at()
    }
    /// 建立后的通道不依赖邀请 TTL：宿主定期调用；任何失败都应关闭通道。
    /// 这是当前数据库快照中的成员撤销检查，不是即时全局撤销或通话租约。
    pub async fn revalidate_peer(&mut self, peer: &str) -> Result<()> {
        self.current()?;
        if peer == self.member_id {
            return Err(IdentityError::SignalInput);
        }
        let peer_key = member_key(peer)?;
        let rows = self
            .run(
                SignalCommand::Revalidate,
                json!({"subject":self.session.subject(),"peer":peer_key}),
            )
            .await?;
        validate_peer_rows(&rows, &self.member_id, peer)
    }
    pub async fn invite(
        &mut self,
        id: &str,
        nonce: &str,
        generation: &str,
        recipient: &str,
        offer: &str,
        offer_hash: &str,
    ) -> Result<SignalRow> {
        self.current()?;
        if !valid_hex(id)
            || !valid_hex(nonce)
            || !valid_hex(generation)
            || !valid_hex(offer_hash)
            || recipient == self.member_id
            || sdp_hash(offer, "offer")? != offer_hash
        {
            return Err(IdentityError::SignalInput);
        }
        let recipient_key = member_key(recipient)?;
        if self
            .last_invite
            .is_some_and(|last| last.elapsed() < Duration::from_secs(10))
        {
            return Err(IdentityError::SignalRateLimited);
        }
        // 无论服务器结果如何都保留冷却；不对不确定创建自动重试。
        self.last_invite = Some(Instant::now());
        let vars = json!({"id":id,"workspace":self.database,"recipient":recipient_key,"nonce":nonce,"generation":generation,"offer":offer,"offer_hash":offer_hash});
        let rows = self.run(SignalCommand::Invite, vars).await?;
        let row = self.one(rows)?;
        let actual = &row.binding;
        if actual.id != id
            || actual.sender != self.member_id
            || actual.recipient != recipient
            || actual.nonce != nonce
            || actual.generation != generation
            || actual.offer_hash != offer_hash
            || row.offer != offer
            || row.status != SignalStatus::Pending
            || row.answer.is_some()
        {
            return Err(IdentityError::SignalBinding);
        }
        Ok(row)
    }
    /// 空列表只代表没有可见 pending 邀请，不是可用于认证媒体的证明。
    pub async fn inbox(&mut self) -> Result<Vec<SignalSummary>> {
        self.current()?;
        if self
            .last_inbox
            .is_some_and(|last| last.elapsed() < Duration::from_secs(3))
        {
            return Err(IdentityError::SignalRateLimited);
        }
        self.last_inbox = Some(Instant::now());
        let rows = self
            .run(SignalCommand::Inbox, json!({"workspace":self.database}))
            .await?;
        if rows.len() > 50 {
            return Err(IdentityError::SignalBinding);
        }
        rows.into_iter()
            .map(|value| {
                let mut row: SignalSummary =
                    serde_json::from_value(value).map_err(|_| IdentityError::SignalBinding)?;
                row.id = signal_key(&row.id)?.to_owned();
                member_key(&row.sender)?;
                live_times(row.expires_unix, row.server_unix)?;
                datetime(&row.expires_at)?;
                datetime(&row.server_now)?;
                if row.sender == self.member_id {
                    return Err(IdentityError::SignalBinding);
                }
                Ok(row)
            })
            .collect()
    }
    pub async fn read(&mut self, id: &str) -> Result<SignalRow> {
        self.current()?;
        if !valid_hex(id) {
            return Err(IdentityError::SignalInput);
        }
        if self
            .last_read
            .as_ref()
            .is_some_and(|(old, at)| old == id && at.elapsed() < Duration::from_secs(3))
        {
            return Err(IdentityError::SignalRateLimited);
        }
        self.last_read = Some((id.to_owned(), Instant::now()));
        let rows = self
            .run(
                SignalCommand::Read,
                json!({"workspace":self.database,"id":id}),
            )
            .await?;
        let row = self.one(rows)?;
        if row.binding.id != id {
            return Err(IdentityError::SignalBinding);
        }
        Ok(row)
    }
    pub async fn decide(&mut self, binding: &SignalBinding, accept: bool) -> Result<SignalRow> {
        self.binding(binding)?;
        if binding.recipient != self.member_id {
            return Err(IdentityError::SignalBinding);
        }
        let command = if accept {
            SignalCommand::Accept
        } else {
            SignalCommand::Reject
        };
        self.update(command, binding, None).await
    }
    pub async fn answer(&mut self, binding: &SignalBinding, answer: &str) -> Result<SignalRow> {
        self.binding(binding)?;
        if binding.recipient != self.member_id {
            return Err(IdentityError::SignalBinding);
        }
        sdp_hash(answer, "answer")?;
        self.update(SignalCommand::Answer, binding, Some(answer))
            .await
    }
    pub async fn end(&mut self, binding: &SignalBinding) -> Result<SignalRow> {
        self.binding(binding)?;
        self.update(SignalCommand::End, binding, None).await
    }
    fn current(&self) -> Result<()> {
        self.session.ensure_current()?;
        if self.closed {
            return Err(IdentityError::SignalUnavailable);
        }
        if self.session.database() != Some(self.database.as_str()) {
            return Err(IdentityError::SignalBinding);
        }
        Ok(())
    }
    fn binding(&self, binding: &SignalBinding) -> Result<()> {
        self.current()?;
        validate_binding(binding)?;
        if binding.workspace != self.database
            || (binding.sender != self.member_id && binding.recipient != self.member_id)
        {
            return Err(IdentityError::SignalBinding);
        }
        Ok(())
    }
    async fn update(
        &mut self,
        command: SignalCommand,
        binding: &SignalBinding,
        answer: Option<&str>,
    ) -> Result<SignalRow> {
        let mut vars = json!({"id":binding.id,"workspace":binding.workspace,"sender":member_key(&binding.sender)?,"recipient":member_key(&binding.recipient)?,"nonce":binding.nonce,"generation":binding.generation,"offer_hash":binding.offer_hash,"expires_at":binding.expires_at});
        if let Some(answer) = answer {
            vars["answer"] = json!(answer);
        }
        let rows = self.run(command, vars).await?;
        let row = self.one(rows)?;
        if row.binding != *binding
            || row.status
                != command
                    .expected_status()
                    .ok_or(IdentityError::SignalInput)?
            || (answer.is_some() && row.answer.as_deref() != answer)
        {
            return Err(IdentityError::SignalBinding);
        }
        Ok(row)
    }
    async fn run(&mut self, command: SignalCommand, vars: Value) -> Result<Vec<Value>> {
        self.current()?;
        self.request_id = self
            .request_id
            .checked_add(1)
            .ok_or(IdentityError::SignalUnavailable)?;
        let result = timeout(
            Duration::from_secs(15),
            rpc(
                &mut self.socket,
                self.request_id,
                "query",
                json!([command.sql(), vars]),
            ),
        )
        .await;
        self.session.ensure_current()?;
        let value = match result {
            Ok(Ok(value)) => value,
            Ok(Err(IdentityError::Database)) => return Err(IdentityError::SignalUnavailable),
            _ => {
                self.closed = true;
                return Err(if command.mutates() {
                    IdentityError::SignalUncertain
                } else {
                    IdentityError::SignalUnavailable
                });
            }
        };
        statement_rows(value)
    }
    fn one(&self, rows: Vec<Value>) -> Result<SignalRow> {
        self.current()?;
        if rows.len() != 1 {
            return Err(IdentityError::SignalUnavailable);
        }
        let raw: RawRow = serde_json::from_value(
            rows.into_iter()
                .next()
                .ok_or(IdentityError::SignalUnavailable)?,
        )
        .map_err(|_| IdentityError::SignalBinding)?;
        let binding = SignalBinding {
            id: signal_key(&raw.id)?.to_owned(),
            workspace: raw.workspace,
            sender: raw.sender,
            recipient: raw.recipient,
            nonce: raw.nonce,
            generation: raw.generation,
            offer_hash: raw.offer_hash,
            expires_at: raw.expires_at,
        };
        self.binding(&binding)?;
        datetime(&raw.created_at)?;
        datetime(&raw.server_now)?;
        live_times(raw.expires_unix, raw.server_unix)?;
        if sdp_hash(&raw.offer, "offer")? != binding.offer_hash {
            return Err(IdentityError::SignalBinding);
        }
        if let Some(answer) = &raw.answer {
            sdp_hash(answer, "answer")?;
        }
        if (raw.status == SignalStatus::Answered && raw.answer.is_none())
            || (matches!(
                raw.status,
                SignalStatus::Pending | SignalStatus::Accepted | SignalStatus::Rejected
            ) && raw.answer.is_some())
        {
            return Err(IdentityError::SignalBinding);
        }
        Ok(SignalRow {
            binding,
            status: raw.status,
            offer: raw.offer,
            answer: raw.answer,
            created_at: raw.created_at,
            server_now: raw.server_now,
            expires_unix: raw.expires_unix,
            server_unix: raw.server_unix,
        })
    }
}
#[derive(Clone, Copy)]
enum SignalCommand {
    Revalidate,
    Invite,
    Inbox,
    Read,
    Accept,
    Reject,
    Answer,
    End,
}
impl SignalCommand {
    fn sql(self) -> &'static str {
        match self {
            Self::Revalidate => REVALIDATE,
            Self::Invite => INVITE,
            Self::Inbox => INBOX,
            Self::Read => READ,
            Self::Accept => ACCEPT,
            Self::Reject => REJECT,
            Self::Answer => ANSWER,
            Self::End => END,
        }
    }
    fn mutates(self) -> bool {
        !matches!(self, Self::Revalidate | Self::Inbox | Self::Read)
    }
    fn expected_status(self) -> Option<SignalStatus> {
        match self {
            Self::Invite => Some(SignalStatus::Pending),
            Self::Accept => Some(SignalStatus::Accepted),
            Self::Reject => Some(SignalStatus::Rejected),
            Self::Answer => Some(SignalStatus::Answered),
            Self::End => Some(SignalStatus::Ended),
            _ => None,
        }
    }
}
fn validate_peer_rows(rows: &[Value], current: &str, peer: &str) -> Result<()> {
    if rows.len() != 2 || current == peer {
        return Err(IdentityError::SignalUnavailable);
    }
    let ids = rows
        .iter()
        .map(|row| {
            row.as_object()
                .filter(|object| object.len() == 1)
                .and_then(|object| object.get("id"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    if ids.iter().filter(|id| **id == Some(current)).count() != 1
        || ids.iter().filter(|id| **id == Some(peer)).count() != 1
    {
        return Err(IdentityError::SignalUnavailable);
    }
    Ok(())
}
fn statement_rows(value: Value) -> Result<Vec<Value>> {
    let statements = value
        .as_array()
        .filter(|rows| rows.len() == 1)
        .ok_or(IdentityError::SignalUnavailable)?;
    if statements[0].get("status").and_then(Value::as_str) != Some("OK") {
        return Err(IdentityError::SignalUnavailable);
    }
    statements[0]
        .get("result")
        .and_then(Value::as_array)
        .cloned()
        .ok_or(IdentityError::SignalUnavailable)
}
fn valid_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn signal_key(value: &str) -> Result<&str> {
    // 固定查询投影 record::id，避免纯数字字符串 ID 的 record 转义格式歧义。
    if valid_hex(value) {
        Ok(value)
    } else {
        Err(IdentityError::SignalBinding)
    }
}
fn member_key(value: &str) -> Result<&str> {
    let key = value
        .strip_prefix("user:")
        .ok_or(IdentityError::SignalInput)?;
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(IdentityError::SignalInput);
    }
    Ok(key)
}
fn datetime(value: &str) -> Result<()> {
    if value.len() < 20
        || value.len() > 40
        || !value.is_ascii()
        || !value.contains('T')
        || !value.ends_with('Z')
    {
        return Err(IdentityError::SignalBinding);
    }
    Ok(())
}
fn live_times(expires: u64, now: u64) -> Result<()> {
    if expires <= now || expires - now > 121 {
        Err(IdentityError::SignalUnavailable)
    } else {
        Ok(())
    }
}
fn validate_binding(binding: &SignalBinding) -> Result<()> {
    if !valid_hex(&binding.id)
        || !valid_hex(&binding.nonce)
        || !valid_hex(&binding.generation)
        || !valid_hex(&binding.offer_hash)
        || binding.sender == binding.recipient
        || !crate::auth::safe_identifier(&binding.workspace)
    {
        return Err(IdentityError::SignalBinding);
    }
    member_key(&binding.sender)?;
    member_key(&binding.recipient)?;
    datetime(&binding.expires_at)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sdp {
    #[serde(rename = "type")]
    kind: String,
    sdp: String,
}
fn sdp_hash(value: &str, kind: &str) -> Result<String> {
    if value.len() > 49152 || !value.is_ascii() {
        return Err(IdentityError::SignalInput);
    }
    let sdp: Sdp = serde_json::from_str(value).map_err(|_| IdentityError::SignalInput)?;
    if sdp.kind != kind
        || !sdp.sdp.starts_with("v=0\r\n")
        || !sdp.sdp.contains("\r\nm=")
        || !sdp.sdp.contains("\r\na=fingerprint:sha-256 ")
        || !sdp.sdp.contains("\r\na=ice-ufrag:")
        || !sdp.sdp.contains("\r\na=ice-pwd:")
    {
        return Err(IdentityError::SignalInput);
    }
    Ok(Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
#[path = "signaling_tests.rs"]
pub(crate) mod tests;
