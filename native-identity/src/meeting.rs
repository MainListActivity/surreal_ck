//! 固定会议 RPC；响应只是数据库行，不构成媒体认证凭据。
use crate::{
    members::{connect_authenticated, rpc_outcome, DatabaseSocket},
    IdentityClient, IdentityError as E, Result, Session, SurrealConfig,
};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fmt,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::time::timeout;

#[cfg(test)]
mod tests {
    use super::*;
    fn hex() -> String {
        "a".repeat(64)
    }
    fn sdp(kind: &str) -> String {
        json!({"type":kind,"sdp":"v=0\r\n\r\nm=audio 9 RTP/AVP 0\r\na=fingerprint:sha-256 AA\r\na=ice-ufrag:u\r\na=ice-pwd:p\r\n"}).to_string()
    }
    fn row() -> Value {
        let offer = sdp("offer");
        json!({"workspace":"ws","room":hex(),"id":hex(),"sender":"user:a","sender_join":"b".repeat(64),"recipient":"user:b","recipient_join":"c".repeat(64),"attempt":1,"nonce":hex(),"route":"direct","offer_hash":sdp_hash(&offer,"offer").unwrap(),"offer":offer,"answer":null,"answer_hash":null,"expires_unix":1060,"server_unix":1000})
    }
    #[test]
    fn parsing_and_integrity() {
        let v = row();
        let r: SdpRow = decode(v.clone()).unwrap();
        r.validate("ws").unwrap();
        assert!(r.validate("other").is_err());
        for (field, value) in [
            ("room", json!("bad")),
            ("attempt", json!(0)),
            ("route", json!("other")),
            ("offer_hash", json!(hex())),
            ("expires_unix", json!(1061)),
            ("sender", json!("user:b")),
            ("answer", json!(sdp("answer"))),
        ] {
            let mut bad = v.clone();
            bad[field] = value;
            assert!(
                decode::<SdpRow>(bad)
                    .and_then(|r| r.validate("ws"))
                    .is_err(),
                "{field}"
            );
        }
        let mut bad = v.clone();
        bad["secret"] = json!(true);
        assert!(decode::<SdpRow>(bad).is_err());
        let mut bad = v;
        bad["answer"] = json!(sdp("answer"));
        bad["answer_hash"] = json!(sdp_hash(&sdp("answer"), "answer").unwrap());
        decode::<SdpRow>(bad).unwrap().validate("ws").unwrap();
        assert!(decode::<SdpRow>(json!({})).is_err());
        assert!(!format!("{r:?}").contains("fingerprint"));
        let mut changed = r.clone();
        changed.route = Route::Relay;
        assert!(validate_post(changed, &r, "ws", false).is_err());
        let mut changed = r.clone();
        changed.id = "d".repeat(64);
        assert!(validate_post(changed.clone(), &r, "ws", false).is_ok());
        assert!(validate_post(changed, &r, "ws", true).is_err());
    }
    #[test]
    fn snapshot_validation() {
        let v = json!({"workspace":"ws","room":{"id":hex(),"code":"ROOM1234","host":"user:a","status":"open","version":1,"expires_unix":2000},"local_join":hex(),"members":[{"member":"user:a","join_id":hex(),"lease_expires_unix":1090}],"server_unix":1000});
        let s: Snapshot = decode(v.clone()).unwrap();
        s.validate("ws", "user:a").unwrap();
        assert!(s.validate("ws", "user:b").is_err());
        let mut bad = v.clone();
        bad["members"] = json!([]);
        assert!(decode::<Snapshot>(bad)
            .unwrap()
            .validate("ws", "user:a")
            .is_err());
        let mut bad = v;
        let duplicate = bad["members"][0].clone();
        bad["members"].as_array_mut().unwrap().push(duplicate);
        assert!(decode::<Snapshot>(bad)
            .unwrap()
            .validate("ws", "user:a")
            .is_err());
    }
    #[test]
    fn throw_mapping_is_exact_and_redacted() {
        for v in [
            json!({"kind":"TransactionConflict"}),
            json!({"message":"Transaction failed: conflict"}),
            json!({"result":"The transaction can be retried"}),
        ] {
            assert_eq!(failure(&v), E::MeetingRetry);
        }
        for (code, expected) in [
            ("not_found", E::MeetingNotFound),
            ("full", E::MeetingFull),
            ("expired", E::MeetingExpired),
            ("conflict", E::MeetingRetry),
            ("rate_limited", E::MeetingRateLimited),
            ("denied", E::MeetingDenied),
        ] {
            assert_eq!(
                result(json!([{"status":"ERR","message":format!("meeting:{code}")}])),
                Err(expected)
            );
        }
        assert_eq!(
            failure(&json!({"status":"ERR","result":"meeting:full"})),
            E::MeetingFull
        );
        let e = failure(&json!({"message":"private secret meeting:full"}));
        assert_eq!(e, E::MeetingUnavailable);
        assert!(!e.to_string().contains("secret"));
        assert_eq!(
            failure(
                &json!({"kind":"NotFound","details":{"kind":"Function","details":{"name":"fn::meeting_capability"}}})
            ),
            E::MeetingSchemaMissing
        );
        assert_eq!(
            failure(
                &json!({"kind":"NotFound","details":{"kind":"Table","details":{"name":"user"}}})
            ),
            E::MeetingUnavailable
        );
        assert!(member_key("user:2026-01-01").is_err());
        assert!(!valid_code("lowercase"));
        assert!(valid_code("ROOM1234"));
    }
}

pub const MAX_MEMBERS: usize = 4;
pub const MEETING_SDP_TTL: u64 = 60;
pub const MIN_CODE_LEN: usize = 8;
pub const MAX_CODE_LEN: usize = 32;

macro_rules! redacted {
    ($($t:ty),*) => {$(
        impl fmt::Debug for $t {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(concat!(stringify!($t), "([REDACTED])")) }
        }
    )*};
}
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Room {
    pub id: String,
    pub code: String,
    pub host: String,
    pub status: RoomStatus,
    pub version: u64,
    pub expires_unix: u64,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RoomStatus {
    Open,
    Ended,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MeetingMember {
    pub member: String,
    pub join_id: String,
    pub lease_expires_unix: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub workspace: String,
    pub room: Room,
    pub local_join: Option<String>,
    pub members: Vec<MeetingMember>,
    pub server_unix: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invitation {
    pub workspace: String,
    pub room: String,
    pub code: String,
    pub host: String,
    pub expires_unix: u64,
    pub server_unix: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InviteResult {
    pub room: String,
    pub invited: Vec<String>,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Direct,
    Relay,
}
impl Route {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Relay => "relay",
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SdpRow {
    pub workspace: String,
    pub room: String,
    pub id: String,
    pub sender: String,
    pub sender_join: String,
    pub recipient: String,
    pub recipient_join: String,
    pub attempt: u32,
    pub nonce: String,
    pub route: Route,
    pub offer: String,
    pub offer_hash: String,
    pub answer: Option<String>,
    pub answer_hash: Option<String>,
    pub expires_unix: u64,
    pub server_unix: u64,
}
redacted!(
    Room,
    MeetingMember,
    Snapshot,
    Invitation,
    InviteResult,
    SdpRow
);
pub fn valid_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn valid_code(s: &str) -> bool {
    (MIN_CODE_LEN..=MAX_CODE_LEN).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}
pub fn member_key(s: &str) -> Result<&str> {
    let key = s.strip_prefix("user:").ok_or(E::MeetingInput)?;
    if key.is_empty()
        || key.len() > 128
        || crate::signaling::json_rpc_coerces(key)
        || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(E::MeetingInput);
    }
    Ok(key)
}
pub fn random_id() -> Result<String> {
    let mut bytes = [0; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| E::Random)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn sdp_hash(s: &str, kind: &str) -> Result<String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Sdp {
        #[serde(rename = "type")]
        kind: String,
        sdp: String,
    }
    if s.len() > 49152 || !s.is_ascii() {
        return Err(E::MeetingInput);
    }
    let v: Sdp = serde_json::from_str(s).map_err(|_| E::MeetingInput)?;
    if v.kind != kind
        || !v.sdp.starts_with("v=0\r\n")
        || ![
            "\r\nm=",
            "\r\na=fingerprint:sha-256 ",
            "\r\na=ice-ufrag:",
            "\r\na=ice-pwd:",
        ]
        .iter()
        .all(|p| v.sdp.contains(p))
    {
        return Err(E::MeetingInput);
    }
    Ok(Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
impl Snapshot {
    pub fn validate(&self, db: &str, me: &str) -> Result<()> {
        let mut members = HashSet::new();
        let mut joins = HashSet::new();
        if self.workspace != db
            || !valid_hex(&self.room.id)
            || !valid_code(&self.room.code)
            || member_key(&self.room.host).is_err()
            || self.members.len() > MAX_MEMBERS
            || (self.room.status == RoomStatus::Open && self.room.expires_unix <= self.server_unix)
        {
            return Err(E::MeetingBinding);
        }
        for m in &self.members {
            if member_key(&m.member).is_err()
                || !valid_hex(&m.join_id)
                || m.lease_expires_unix <= self.server_unix
                || !members.insert(&m.member)
                || !joins.insert(&m.join_id)
            {
                return Err(E::MeetingBinding);
            }
        }
        if let Some(j) = &self.local_join {
            if !self
                .members
                .iter()
                .any(|m| m.join_id == *j && m.member == me)
            {
                return Err(E::MeetingBinding);
            }
        }
        Ok(())
    }
}
impl SdpRow {
    pub fn validate(&self, db: &str) -> Result<()> {
        if self.workspace != db
            || ![
                &self.room,
                &self.id,
                &self.sender_join,
                &self.recipient_join,
                &self.nonce,
                &self.offer_hash,
            ]
            .iter()
            .all(|s| valid_hex(s))
            || self.sender == self.recipient
            || self.sender_join == self.recipient_join
            || self.attempt == 0
            || member_key(&self.sender).is_err()
            || member_key(&self.recipient).is_err()
            || self.expires_unix <= self.server_unix
            || self.expires_unix - self.server_unix > MEETING_SDP_TTL
            || sdp_hash(&self.offer, "offer")? != self.offer_hash
        {
            return Err(E::MeetingBinding);
        }
        match (&self.answer, &self.answer_hash) {
            (None, None) => Ok(()),
            (Some(a), Some(h)) if valid_hex(h) && sdp_hash(a, "answer")? == *h => Ok(()),
            _ => Err(E::MeetingBinding),
        }
    }
}
/// 仅公开固定协议；实现方必须使用已认证调用者身份，而非参数中的 sender。
#[allow(async_fn_in_trait)]
pub trait MeetingRpc {
    fn database(&self) -> &str;
    fn member_id(&self) -> &str;
    async fn capability(&mut self) -> Result<()>;
    async fn create(&mut self, nonce: &str) -> Result<Snapshot>;
    async fn invite(&mut self, room: &str, recipients: &[String]) -> Result<InviteResult>;
    async fn invitations(&mut self) -> Result<Vec<Invitation>>;
    async fn join(&mut self, code: &str, join_id: &str) -> Result<Snapshot>;
    async fn snapshot(&mut self, room: &str, join_id: &str) -> Result<Snapshot>;
    async fn renew(&mut self, room: &str, join_id: &str) -> Result<Snapshot>;
    async fn leave(&mut self, room: &str, join_id: &str) -> Result<()>;
    async fn end(&mut self, room: &str, join_id: &str) -> Result<()>;
    async fn post_offer(&mut self, row: &SdpRow) -> Result<SdpRow>;
    async fn poll_offers(&mut self, room: &str, join_id: &str) -> Result<Vec<SdpRow>>;
    async fn post_answer(&mut self, row: &SdpRow) -> Result<SdpRow>;
    async fn poll_answers(&mut self, room: &str, join_id: &str) -> Result<Vec<SdpRow>>;
}
pub struct MeetingConnection {
    socket: DatabaseSocket,
    session: Arc<Session>,
    database: String,
    member_id: String,
    request_id: u64,
    closed: bool,
    polls: [Option<Instant>; 4],
}
redacted!(MeetingConnection);
fn failure(s: &Value) -> E {
    let retry = ["kind", "message", "result"]
        .iter()
        .filter_map(|key| s.get(key).and_then(Value::as_str))
        .map(str::to_ascii_lowercase)
        .any(|s| {
            (s.contains("transaction") && s.contains("conflict")) || s.contains("can be retried")
        });
    if retry {
        return E::MeetingRetry;
    }
    if s.get("kind").and_then(Value::as_str) == Some("NotFound")
        && s.get("details").is_some_and(|d| {
            d.to_string().contains("fn::meeting")
                || d.get("kind").and_then(Value::as_str) == Some("Function")
        })
    {
        return E::MeetingSchemaMissing;
    }
    let msg = s
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| s.get("result").and_then(Value::as_str));
    // 真实 SurrealDB 的 THROW 会被包装（如 `An error occurred: meeting:<code>`，
    // 可能再被外层文本包裹）。只在包装文本含 "error occurred" 时取最后的
    // meeting: 代码做完全匹配；避免把用户内容里内嵌的 meeting: 串误判。
    let code = msg.and_then(|m| {
        let lower = m.to_ascii_lowercase();
        if lower.starts_with("meeting:") {
            Some(lower)
        } else if lower.contains("error occurred") {
            lower.rsplit_once("meeting:").map(|(_, tail)| format!("meeting:{tail}"))
        } else {
            None
        }
    });
    match code.as_deref() {
        Some("meeting:not_found") => E::MeetingNotFound,
        Some("meeting:full") => E::MeetingFull,
        Some("meeting:expired") => E::MeetingExpired,
        Some("meeting:conflict") => E::MeetingRetry,
        Some("meeting:rate_limited") => E::MeetingRateLimited,
        Some("meeting:denied") => E::MeetingDenied,
        _ => E::MeetingUnavailable,
    }
}
fn result(value: Value) -> Result<Value> {
    let a = value
        .as_array()
        .filter(|a| a.len() == 1)
        .ok_or(E::MeetingUnavailable)?;
    if a[0].get("status").and_then(Value::as_str) != Some("OK") {
        return Err(failure(&a[0]));
    }
    a[0].get("result").cloned().ok_or(E::MeetingUnavailable)
}
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(v).map_err(|_| E::MeetingBinding)
}
pub fn validate_post(got: SdpRow, sent: &SdpRow, db: &str, answer: bool) -> Result<SdpRow> {
    got.validate(db)?;
    if got.workspace != sent.workspace
        || got.room != sent.room
        || got.sender != sent.sender
        || got.sender_join != sent.sender_join
        || got.recipient != sent.recipient
        || got.recipient_join != sent.recipient_join
        || got.attempt != sent.attempt
        || got.nonce != sent.nonce
        || got.route != sent.route
        || got.offer != sent.offer
        || got.offer_hash != sent.offer_hash
        || got.answer != sent.answer
        || got.answer_hash != sent.answer_hash
        || (answer && got.id != sent.id)
    {
        return Err(E::MeetingBinding);
    }
    Ok(got)
}
impl MeetingConnection {
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
            .find(|w| w.slug == slug)
            .ok_or(E::Forbidden)?;
        session.require_collaboration_scope(workspace)?;
        if session.access.as_deref() != Some("participant") {
            return Err(E::MeetingRecordRequired);
        }
        let socket = connect_authenticated(&session, config, workspace).await?;
        let database = workspace.db_name.clone();
        let mut c = Self {
            socket,
            session,
            database,
            member_id: String::new(),
            request_id: 2,
            closed: false,
            polls: [None; 4],
        };
        let identity = c
            .run(
                include_str!("../sql/signal-identity.surql"),
                json!({}),
                false,
            )
            .await?;
        let rows = identity
            .as_array()
            .filter(|a| a.len() == 1)
            .ok_or(E::MeetingBinding)?;
        if rows[0].get("subject").and_then(Value::as_str) != Some(c.session.subject()) {
            return Err(E::MeetingBinding);
        }
        c.member_id = rows[0]
            .get("id")
            .and_then(Value::as_str)
            .ok_or(E::MeetingBinding)?
            .to_owned();
        member_key(&c.member_id)?;
        c.capability().await?;
        Ok(c)
    }
    pub fn database(&self) -> &str {
        &self.database
    }
    pub fn member_id(&self) -> &str {
        &self.member_id
    }
    pub fn ensure_current(&self) -> Result<()> {
        self.session.ensure_current()?;
        if self.closed {
            return Err(E::MeetingUnavailable);
        }
        if self.session.database() != Some(self.database.as_str()) {
            return Err(E::MeetingBinding);
        }
        Ok(())
    }
    async fn run(&mut self, sql: &'static str, vars: Value, mutates: bool) -> Result<Value> {
        self.ensure_current()?;
        self.request_id = self
            .request_id
            .checked_add(1)
            .ok_or(E::MeetingUnavailable)?;
        let response = timeout(
            Duration::from_secs(15),
            rpc_outcome(
                &mut self.socket,
                self.request_id,
                "query",
                json!([sql, vars]),
            ),
        )
        .await;
        self.session.ensure_current()?;
        match response {
            Ok(Ok(Ok(v))) => result(v),
            Ok(Ok(Err(e))) => Err(failure(&e)),
            _ => {
                self.closed = true;
                Err(if mutates {
                    E::MeetingUncertain
                } else {
                    E::MeetingUnavailable
                })
            }
        }
    }
    fn guard(&mut self, i: usize, secs: u64) -> Result<()> {
        self.ensure_current()?;
        if self.polls[i].is_some_and(|t| t.elapsed() < Duration::from_secs(secs)) {
            return Err(E::MeetingRateLimited);
        }
        self.polls[i] = Some(Instant::now());
        Ok(())
    }
    fn bound(&self, room: &str, join: &str) -> Result<()> {
        self.ensure_current()?;
        if !valid_hex(room) || !valid_hex(join) {
            return Err(E::MeetingInput);
        }
        Ok(())
    }
    fn snap(&self, v: Value) -> Result<Snapshot> {
        let s: Snapshot = decode(v)?;
        s.validate(&self.database, &self.member_id)?;
        Ok(s)
    }
    fn rows(&self, v: Value) -> Result<Vec<SdpRow>> {
        let rows: Vec<SdpRow> = decode(v)?;
        if rows.len() > 6 {
            return Err(E::MeetingBinding);
        }
        for r in &rows {
            r.validate(&self.database)?;
        }
        Ok(rows)
    }
}
impl MeetingRpc for MeetingConnection {
    fn database(&self) -> &str {
        &self.database
    }
    fn member_id(&self) -> &str {
        &self.member_id
    }
    async fn capability(&mut self) -> Result<()> {
        let v = self
            .run(
                include_str!("../sql/meeting-capability.surql"),
                json!({}),
                false,
            )
            .await?;
        if v.as_str() != Some("meeting_v1") {
            return Err(E::MeetingUnavailable);
        }
        Ok(())
    }
    async fn create(&mut self, nonce: &str) -> Result<Snapshot> {
        if !valid_hex(nonce) {
            return Err(E::MeetingInput);
        }
        let v = self
            .run(
                include_str!("../sql/meeting-create.surql"),
                json!({"nonce":nonce}),
                true,
            )
            .await?;
        let s = self.snap(v)?;
        if s.local_join.as_deref() != Some(nonce) {
            return Err(E::MeetingBinding);
        }
        Ok(s)
    }
    async fn invite(&mut self, room: &str, recipients: &[String]) -> Result<InviteResult> {
        if !valid_hex(room)
            || recipients.len() > 20
            || recipients.iter().collect::<HashSet<_>>().len() != recipients.len()
        {
            return Err(E::MeetingInput);
        }
        // Contact/member_id 已带 `user:` 前缀；两种形式都接受并归一化。
        let recipients: Vec<String> = recipients
            .iter()
            .map(|r| r.strip_prefix("user:").unwrap_or(r.as_str()).to_string())
            .collect();
        if recipients.iter().collect::<HashSet<_>>().len() != recipients.len() {
            return Err(E::MeetingInput);
        }
        for r in &recipients {
            member_key(&format!("user:{r}"))?;
        }
        let v = self
            .run(
                include_str!("../sql/meeting-invite.surql"),
                json!({"room":room,"recipients":recipients}),
                true,
            )
            .await?;
        let r: InviteResult = decode(v)?;
        if r.room != room
            || r.invited.len() > 20
            || r.invited.iter().any(|m| {
                member_key(m).is_err() || !recipients.iter().any(|r| m == &format!("user:{r}"))
            })
        {
            return Err(E::MeetingBinding);
        }
        Ok(r)
    }
    async fn invitations(&mut self) -> Result<Vec<Invitation>> {
        self.guard(0, 3)?;
        let v = self
            .run(
                include_str!("../sql/meeting-invitations.surql"),
                json!({}),
                false,
            )
            .await?;
        let rows: Vec<Invitation> = decode(v)?;
        if rows.len() > 20
            || rows.iter().any(|r| {
                r.workspace != self.database
                    || !valid_hex(&r.room)
                    || !valid_code(&r.code)
                    || member_key(&r.host).is_err()
                    || r.expires_unix <= r.server_unix
            })
        {
            return Err(E::MeetingBinding);
        }
        Ok(rows)
    }
    async fn join(&mut self, code: &str, join_id: &str) -> Result<Snapshot> {
        if !valid_code(code) || !valid_hex(join_id) {
            return Err(E::MeetingInput);
        }
        let v = self
            .run(
                include_str!("../sql/meeting-join.surql"),
                json!({"code":code,"join_id":join_id}),
                true,
            )
            .await?;
        let s = self.snap(v)?;
        if s.local_join.as_deref() != Some(join_id) || s.room.code != code {
            return Err(E::MeetingBinding);
        }
        Ok(s)
    }
    async fn snapshot(&mut self, room: &str, join_id: &str) -> Result<Snapshot> {
        self.bound(room, join_id)?;
        self.guard(1, 1)?;
        let v = self
            .run(
                include_str!("../sql/meeting-snapshot.surql"),
                json!({"room":room,"join_id":join_id}),
                false,
            )
            .await?;
        self.snap(v)
    }
    async fn renew(&mut self, room: &str, join_id: &str) -> Result<Snapshot> {
        self.bound(room, join_id)?;

        let v = self
            .run(
                include_str!("../sql/meeting-renew.surql"),
                json!({"room":room,"join_id":join_id}),
                true,
            )
            .await?;
        self.snap(v)
    }
    async fn leave(&mut self, room: &str, join_id: &str) -> Result<()> {
        self.bound(room, join_id)?;

        let v = self
            .run(
                include_str!("../sql/meeting-leave.surql"),
                json!({"room":room,"join_id":join_id}),
                true,
            )
            .await?;
        if !v.is_null() {
            return Err(E::MeetingBinding);
        }
        Ok(())
    }
    async fn end(&mut self, room: &str, join_id: &str) -> Result<()> {
        self.bound(room, join_id)?;

        let v = self
            .run(
                include_str!("../sql/meeting-end.surql"),
                json!({"room":room,"join_id":join_id}),
                true,
            )
            .await?;
        if !v.is_null() {
            return Err(E::MeetingBinding);
        }
        Ok(())
    }
    async fn poll_offers(&mut self, room: &str, join_id: &str) -> Result<Vec<SdpRow>> {
        self.bound(room, join_id)?;
        self.guard(2, 1)?;
        let v = self
            .run(
                include_str!("../sql/meeting-poll-offers.surql"),
                json!({"room":room,"join_id":join_id}),
                false,
            )
            .await?;
        self.rows(v)
    }
    async fn poll_answers(&mut self, room: &str, join_id: &str) -> Result<Vec<SdpRow>> {
        self.bound(room, join_id)?;
        self.guard(3, 1)?;
        let v = self
            .run(
                include_str!("../sql/meeting-poll-answers.surql"),
                json!({"room":room,"join_id":join_id}),
                false,
            )
            .await?;
        self.rows(v)
    }
    async fn post_offer(&mut self, row: &SdpRow) -> Result<SdpRow> {
        row.validate(&self.database)?;
        if row.sender != self.member_id {
            return Err(E::MeetingBinding);
        }
        let vars = json!({"room":row.room,"join_id":row.sender_join,"peer_join_id":row.recipient_join,"attempt":row.attempt,"nonce":row.nonce,"route":row.route.as_str(),"offer":row.offer,"offer_hash":row.offer_hash});
        let v = self
            .run(include_str!("../sql/meeting-post-offer.surql"), vars, true)
            .await?;
        validate_post(decode(v)?, row, &self.database, false)
    }
    async fn post_answer(&mut self, row: &SdpRow) -> Result<SdpRow> {
        row.validate(&self.database)?;
        if row.recipient != self.member_id || row.answer.is_none() {
            return Err(E::MeetingBinding);
        }
        let vars = json!({"room":row.room,"join_id":row.recipient_join,"peer_join_id":row.sender_join,"attempt":row.attempt,"nonce":row.nonce,"offer_hash":row.offer_hash,"answer":row.answer,"answer_hash":row.answer_hash});
        let v = self
            .run(include_str!("../sql/meeting-post-answer.surql"), vars, true)
            .await?;
        validate_post(decode(v)?, row, &self.database, true)
    }
}
