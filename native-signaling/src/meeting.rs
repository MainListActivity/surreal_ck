//! 多方 mesh 的会议绑定及逐边重试状态。
use crate::{Error, Result};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    time::{Duration, Instant},
};
pub use surreal_ck_native_identity::meeting::Route as MeetingRoute;
use surreal_ck_native_identity::meeting::{
    self as rpc, Invitation, InviteResult, MeetingRpc, RoomStatus, Route, SdpRow, Snapshot,
};

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct EdgeKey {
    pub room: String,
    pub low_join: String,
    pub high_join: String,
}
impl EdgeKey {
    fn new(room: &str, a: &str, b: &str) -> Self {
        let (low, high) = if a < b { (a, b) } else { (b, a) };
        Self {
            room: room.into(),
            low_join: low.into(),
            high_join: high.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_meeting::{MockMeetingDb, MockMeetingRpc};
    fn sdp(kind: &str) -> String {
        serde_json::json!({"type":kind,"sdp":"v=0\r\n\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 AA\r\na=ice-ufrag:u\r\na=ice-pwd:p\r\n"}).to_string()
    }
    async fn group(n: usize) -> (MockMeetingDb, Vec<Meeting<MockMeetingRpc>>) {
        let db = MockMeetingDb::new();
        let mut host = Meeting::new(db.actor("ws", "user:a")).unwrap();
        host.create().await.unwrap();
        let code = host.current_snapshot().unwrap().room.code.clone();
        host.invite(&["b".into(), "c".into(), "d".into(), "e".into()])
            .await
            .unwrap();
        let mut actors = vec![host];
        for name in ["b", "c", "d", "e"].iter().take(n - 1) {
            let mut m = Meeting::new(db.actor("ws", &format!("user:{name}"))).unwrap();
            m.join(&code).await.unwrap();
            actors.push(m);
        }
        for a in &mut actors {
            a.snapshot().await.unwrap();
        }
        (db, actors)
    }
    async fn pair(a: &mut Meeting<MockMeetingRpc>, b: &mut Meeting<MockMeetingRpc>) {
        let peer = b.local_join().unwrap().to_owned();
        a.start_edge(&peer, Route::Direct, &sdp("offer"))
            .await
            .unwrap();
        let offers = b.poll_offers().await.unwrap();
        assert_eq!(offers.len(), 1);
        assert!(b.poll_offers().await.unwrap().is_empty());
        b.answer(&offers[0], &sdp("answer")).await.unwrap();
        assert!(b.answer(&offers[0], &sdp("answer")).await.is_err());
        assert_eq!(a.poll_answers().await.unwrap().len(), 1);
        assert!(a.poll_answers().await.unwrap().is_empty());
    }
    #[tokio::test]
    async fn mesh_and_member_departure() {
        let (_, mut actors) = group(3).await;
        actors.sort_by_key(|a| a.local_join().unwrap().to_owned());
        for i in 0..3 {
            for j in i + 1..3 {
                let (left, right) = actors.split_at_mut(j);
                assert!(right[0]
                    .start_edge(left[i].local_join().unwrap(), Route::Direct, &sdp("offer"))
                    .await
                    .is_err());
                pair(&mut left[i], &mut right[0]).await;
            }
        }
        let departed = actors[2].local_join().unwrap().to_owned();
        let survivor = actors[1].local_join().unwrap().to_owned();
        actors[2].leave().await.unwrap();
        let removed = actors[0].snapshot().await.unwrap();
        assert_eq!(removed.len(), 1);
        assert!(removed[0].high_join == departed);
        assert!(actors[0].edge_completed(&survivor));
    }
    #[tokio::test]
    async fn newer_authenticated_relay_offer_can_replace_answered_direct_round() {
        let (_, mut actors) = group(2).await;
        actors.sort_by_key(|actor| actor.local_join().unwrap().to_owned());
        let (left, right) = actors.split_at_mut(1);
        let (a, b) = (&mut left[0], &mut right[0]);
        let peer = b.local_join().unwrap().to_owned();
        pair(a, b).await;
        assert!(b.edge_completed(a.local_join().unwrap()));
        assert!(a.next_edge_attempt(&peer).is_err());
        a.fail_edge(&peer).unwrap();
        assert_eq!(a.next_edge_attempt(&peer).unwrap(), 2);
        a.start_edge(&peer, Route::Relay, &sdp("offer"))
            .await
            .unwrap();
        let offer = b.poll_offers().await.unwrap().remove(0);
        assert_eq!(offer.attempt(), 2);
        assert_eq!(offer.route(), Route::Relay);
        b.answer(&offer, &sdp("answer")).await.unwrap();
        assert_eq!(a.poll_answers().await.unwrap().len(), 1);
        assert!(b.poll_offers().await.unwrap().is_empty());
    }
    #[tokio::test]
    async fn retry_and_wrong_bindings() {
        let (_, mut actors) = group(3).await;
        actors.sort_by_key(|a| a.local_join().unwrap().to_owned());
        let (left, right) = actors.split_at_mut(1);
        let a = &mut left[0];
        let b = &mut right[0];
        let peer = b.local_join().unwrap().to_owned();
        a.start_edge(&peer, Route::Direct, &sdp("offer"))
            .await
            .unwrap();
        let old = b.poll_offers().await.unwrap().remove(0);
        a.fail_edge(&peer).unwrap();
        let next = a
            .start_edge(&peer, Route::Relay, &sdp("offer"))
            .await
            .unwrap();
        assert_eq!(next.attempt_no, 2);
        assert!(b.answer(&old, &sdp("answer")).await.is_err());
        assert!(a.poll_answers().await.unwrap().is_empty());
        b.fail_edge(a.local_join().unwrap()).unwrap();
        let new = b.poll_offers().await.unwrap().remove(0);
        let mut bad = new.row.clone();
        bad.answer = Some(sdp("answer"));
        bad.answer_hash = Some(rpc::sdp_hash(bad.answer.as_ref().unwrap(), "answer").unwrap());
        for field in 0..4 {
            let mut row = bad.clone();
            match field {
                0 => row.offer_hash = "a".repeat(64),
                1 => row.room = "a".repeat(64),
                2 => row.attempt += 1,
                _ => row.route = Route::Direct,
            }
            assert!(b.rpc.post_answer(&row).await.is_err());
        }
        b.answer(&new, &sdp("answer")).await.unwrap();
        assert_eq!(a.poll_answers().await.unwrap().len(), 1);
    }
    #[tokio::test]
    async fn membership_capacity_expiry_and_rejoin() {
        let (db, mut actors) = group(4).await;
        let s = actors[0].current_snapshot().unwrap().clone();
        let mut outsider = db.actor("ws", "user:x");
        assert_eq!(
            outsider
                .join(&s.room.code, &"a".repeat(64))
                .await
                .unwrap_err(),
            surreal_ck_native_identity::IdentityError::MeetingNotFound
        );
        assert_eq!(
            outsider
                .join("INVALIDCODE", &"a".repeat(64))
                .await
                .unwrap_err(),
            surreal_ck_native_identity::IdentityError::MeetingNotFound
        );
        let mut fifth = db.actor("ws", "user:e");
        assert_eq!(
            fifth.join(&s.room.code, &"a".repeat(64)).await.unwrap_err(),
            surreal_ck_native_identity::IdentityError::MeetingFull
        );
        let old = actors[1].local_join().unwrap().to_owned();
        let actor = actors[1].rpc.member_id().to_owned();
        let mut replacement = db.actor("ws", &actor);
        let new = "f".repeat(64);
        replacement.join(&s.room.code, &new).await.unwrap();
        assert!(actors[1].rpc.renew(&s.room.id, &old).await.is_err());
        actors[1].rpc.leave(&s.room.id, &old).await.unwrap();
        assert_eq!(
            replacement
                .renew(&s.room.id, &new)
                .await
                .unwrap()
                .local_join,
            Some(new.clone())
        );
        assert!(replacement.end(&s.room.id, &new).await.is_err());
        db.advance(91);
        assert!(replacement.renew(&s.room.id, &new).await.is_err());
        actors[1].leave().await.unwrap();
        assert!(actors[1].local_join().is_none());
    }
    #[tokio::test]
    async fn snapshot_and_offer_binding_validation() {
        let (_, mut actors) = group(2).await;
        actors.sort_by_key(|a| a.local_join().unwrap().to_owned());
        let (a, b) = actors.split_at_mut(1);
        let a = &mut a[0];
        let b = &mut b[0];
        let mut snapshot = a.current_snapshot().unwrap().clone();
        snapshot.room.version -= 1;
        assert!(a.apply(snapshot, None).is_err());
        a.start_edge(b.local_join().unwrap(), Route::Direct, &sdp("offer"))
            .await
            .unwrap();
        let local = b.local_join().unwrap().to_owned();
        let row = b
            .rpc
            .poll_offers(&b.current_snapshot().unwrap().room.id.clone(), &local)
            .await
            .unwrap()
            .remove(0);
        for i in 0..3 {
            let mut bad = row.clone();
            match i {
                0 => bad.workspace = "other".into(),
                1 => bad.room = "a".repeat(64),
                _ => bad.sender_join = "a".repeat(64),
            }
            assert!(!b.incoming_valid(&bad, &row.room, &row.recipient_join));
        }
        let mut bad = a.current_snapshot().unwrap().clone();
        bad.room.id = "a".repeat(64);
        assert!(a.apply(bad, None).is_err());
    }
    #[tokio::test]
    async fn simultaneous_join_and_injected_replays() {
        let db = MockMeetingDb::new();
        let mut host = Meeting::new(db.actor("ws", "user:a")).unwrap();
        host.create().await.unwrap();
        host.invite(&["b".into(), "c".into()]).await.unwrap();
        let code = host.current_snapshot().unwrap().room.code.clone();
        let mut b = Meeting::new(db.actor("ws", "user:b")).unwrap();
        let mut c = Meeting::new(db.actor("ws", "user:c")).unwrap();
        let (bj, cj) = tokio::join!(b.join(&code), c.join(&code));
        bj.unwrap();
        cj.unwrap();
        let mut actors = vec![host, b, c];
        for a in &mut actors {
            a.snapshot().await.unwrap();
        }
        actors.sort_by_key(|a| a.local_join().unwrap().to_owned());
        let (a, b) = actors.split_at_mut(1);
        let a = &mut a[0];
        let b = &mut b[0];
        let peer = b.local_join().unwrap().to_owned();
        assert!(a
            .start_edge(&peer, Route::Relay, &sdp("offer"))
            .await
            .is_err());
        a.start_edge(&peer, Route::Direct, &sdp("offer"))
            .await
            .unwrap();
        let room = b.current_snapshot().unwrap().room.id.clone();
        let row = b.rpc.poll_offers(&room, &peer).await.unwrap().remove(0);
        for field in 0..3 {
            let mut bad = row.clone();
            match field {
                0 => bad.workspace = "other".into(),
                1 => bad.room = "f".repeat(64),
                _ => bad.sender_join = "f".repeat(64),
            }
            b.rpc.poll_rows = Some(vec![bad]);
            assert!(b.poll_offers().await.unwrap().is_empty());
        }
        b.rpc.poll_rows = Some(vec![row.clone(), row.clone()]);
        let offer = b.poll_offers().await.unwrap().remove(0);
        b.rpc.poll_rows = Some(vec![row]);
        assert!(b.poll_offers().await.unwrap().is_empty());
        b.answer(&offer, &sdp("answer")).await.unwrap();
        let local = a.local_join().unwrap().to_owned();
        let answer = a.rpc.poll_answers(&room, &local).await.unwrap().remove(0);
        for field in 0..6 {
            let mut bad = answer.clone();
            match field {
                0 => bad.offer_hash = "f".repeat(64),
                1 => bad.room = "f".repeat(64),
                2 => bad.attempt += 1,
                3 => bad.route = Route::Relay,
                4 => bad.nonce = "f".repeat(64),
                _ => bad.recipient_join = "f".repeat(64),
            }
            a.rpc.poll_rows = Some(vec![bad]);
            assert!(a.poll_answers().await.unwrap().is_empty());
        }
        a.rpc.poll_rows = Some(vec![answer.clone()]);
        assert_eq!(a.poll_answers().await.unwrap().len(), 1);
        a.rpc.poll_rows = Some(vec![answer]);
        assert!(a.poll_answers().await.unwrap().is_empty());
        a.fail_edge(&peer).unwrap();
        let attempt = a
            .start_edge(&peer, Route::Relay, &sdp("offer"))
            .await
            .unwrap();
        assert_eq!(attempt.attempt_no, 2);
        b.fail_edge(&local).unwrap();
        db.advance(61);
        assert!(b.poll_offers().await.unwrap().is_empty());
    }
}

#[derive(Clone)]
pub struct Attempt {
    pub edge: EdgeKey,
    pub attempt_no: u32,
    pub nonce: String,
    pub route: Route,
    pub expires: Instant,
}
struct Edge {
    last: u32,
    seen: u32,
    nonces: BTreeSet<String>,
    inflight: Option<(Attempt, SdpRow)>,
    incoming: Option<SdpRow>,
    incoming_expires: Option<Instant>,
    completed: bool,
}
impl Edge {
    fn new() -> Self {
        Self {
            last: 0,
            seen: 0,
            nonces: BTreeSet::new(),
            inflight: None,
            incoming: None,
            incoming_expires: None,
            completed: false,
        }
    }
}
/// 只能由会议状态机认证；不能从 JSON 构造。
/// ```compile_fail
/// use surreal_ck_native_signaling::meeting::AuthenticatedMeetingOffer;
/// let forged: AuthenticatedMeetingOffer = serde_json::from_str("{}").unwrap();
/// ```
pub struct AuthenticatedMeetingOffer {
    pub(crate) edge: EdgeKey,
    pub(crate) row: SdpRow,
    pub(crate) owner: String,
}
/// 只能由在途尝试的精确匹配构造。
/// ```compile_fail
/// use surreal_ck_native_signaling::meeting::AuthenticatedMeetingAnswer;
/// let forged: AuthenticatedMeetingAnswer = serde_json::from_str("{}").unwrap();
/// ```
pub struct AuthenticatedMeetingAnswer {
    pub(crate) edge: EdgeKey,
    pub(crate) row: SdpRow,
}
macro_rules! redacted { ($($t:ty),*)=>{$(
    impl fmt::Debug for $t {fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {f.write_str(concat!(stringify!($t),"([REDACTED])"))}}
)*}; }
redacted!(
    EdgeKey,
    Attempt,
    AuthenticatedMeetingOffer,
    AuthenticatedMeetingAnswer
);
macro_rules! accessors {
    ($t:ty,$peer:ident,$join:ident,$sdp:ident) => {
        impl $t {
            pub fn edge(&self) -> &EdgeKey {
                &self.edge
            }
            pub fn attempt(&self) -> u32 {
                self.row.attempt
            }
            pub fn route(&self) -> Route {
                self.row.route
            }
            pub fn peer_member(&self) -> &str {
                &self.row.$peer
            }
            pub fn peer_join(&self) -> &str {
                &self.row.$join
            }
            pub fn sdp_json(&self) -> &str {
                self.row.$sdp.as_deref().unwrap_or("")
            }
        }
    };
}
impl AuthenticatedMeetingOffer {
    pub fn edge(&self) -> &EdgeKey {
        &self.edge
    }
    pub fn attempt(&self) -> u32 {
        self.row.attempt
    }
    pub fn route(&self) -> Route {
        self.row.route
    }
    pub fn peer_member(&self) -> &str {
        &self.row.sender
    }
    pub fn peer_join(&self) -> &str {
        &self.row.sender_join
    }
    pub fn sdp_json(&self) -> &str {
        &self.row.offer
    }
}
accessors!(
    AuthenticatedMeetingAnswer,
    recipient,
    recipient_join,
    answer
);

pub struct Meeting<R: MeetingRpc> {
    rpc: R,
    snapshot: Option<Snapshot>,
    local: Option<String>,
    owner: String,
    edges: BTreeMap<EdgeKey, Edge>,
}
impl<R: MeetingRpc> fmt::Debug for Meeting<R> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Meeting([REDACTED])")
    }
}
impl<R: MeetingRpc> Meeting<R> {
    pub fn new(rpc: R) -> Result<Self> {
        Ok(Self {
            rpc,
            snapshot: None,
            local: None,
            owner: rpc::random_id()?,
            edges: BTreeMap::new(),
        })
    }
    pub fn current_snapshot(&self) -> Option<&Snapshot> {
        self.snapshot.as_ref()
    }
    pub fn local_join(&self) -> Option<&str> {
        self.local.as_deref()
    }
    pub fn edge_completed(&self, peer: &str) -> bool {
        self.local
            .as_ref()
            .zip(self.snapshot.as_ref())
            .and_then(|(j, s)| self.edges.get(&EdgeKey::new(&s.room.id, j, peer)))
            .is_some_and(|e| e.completed)
    }
    fn binding(&self) -> Result<(String, String)> {
        let s = self.snapshot.as_ref().ok_or(Error::Binding)?;
        if s.room.status != RoomStatus::Open {
            return Err(Error::Expired);
        }
        Ok((s.room.id.clone(), self.local.clone().ok_or(Error::Binding)?))
    }
    fn apply(&mut self, s: Snapshot, expected_join: Option<&str>) -> Result<Vec<EdgeKey>> {
        s.validate_protocol(self.rpc.database(), self.rpc.member_id(), self.rpc.is_v2())?;
        if let Some(old) = &self.snapshot {
            if old.workspace != s.workspace
                || old.room.id != s.room.id
                || old.room.code != s.room.code
                || old.room.host != s.room.host
                || old.room.version > s.room.version
            {
                return Err(Error::Binding);
            }
        }
        if expected_join.is_some() && s.local_join.as_deref() != expected_join {
            return Err(Error::Binding);
        }
        let active: BTreeSet<_> = s.members.iter().map(|m| m.join_id.as_str()).collect();
        let removed = self
            .edges
            .keys()
            .filter(|e| {
                s.room.status == RoomStatus::Ended
                    || !active.contains(e.low_join.as_str())
                    || !active.contains(e.high_join.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        for e in &removed {
            self.edges.remove(e);
        }
        self.local = if s.room.status == RoomStatus::Open {
            s.local_join.clone()
        } else {
            None
        };
        self.snapshot = Some(s);
        Ok(removed)
    }
    pub async fn create(&mut self) -> Result<()> {
        if self.snapshot.is_some() {
            return Err(Error::Busy);
        }
        let nonce = rpc::random_id()?;
        let s = self.rpc.create(&nonce).await?;
        self.apply(s, Some(&nonce))?;
        Ok(())
    }
    pub async fn invite(&mut self, recipients: &[String]) -> Result<InviteResult> {
        let s = self.snapshot.as_ref().ok_or(Error::Binding)?;
        Ok(self.rpc.invite(&s.room.id, recipients).await?)
    }
    pub async fn invitations(&mut self) -> Result<Vec<Invitation>> {
        Ok(self.rpc.invitations().await?)
    }
    pub async fn join(&mut self, code: &str) -> Result<()> {
        if !rpc::valid_code(code) && !rpc::valid_v2_code(code) {
            return Err(Error::Binding);
        }
        if self.local.is_some() {
            return Err(Error::Busy);
        }
        let join = rpc::random_id()?;
        let s = self.rpc.join(code, &join).await?;
        self.apply(s, Some(&join))?;
        Ok(())
    }
    pub async fn snapshot(&mut self) -> Result<Vec<EdgeKey>> {
        let (r, j) = self.binding()?;
        let s = self.rpc.snapshot(&r, &j).await?;
        self.apply(s, None)
    }
    pub async fn renew(&mut self) -> Result<Vec<EdgeKey>> {
        let (r, j) = self.binding()?;
        let s = self.rpc.renew(&r, &j).await?;
        self.apply(s, Some(&j))
    }
    /// 本机会话状态清零（不发 RPC）。用于观察到房间已结束/绑定失效等
    /// 不可自愈错误后：snapshot 可能仍停留在 ended 快照或陈旧快照，
    /// 不清掉会让下一次 create/join 命中 Busy。
    pub fn clear(&mut self) {
        self.local = None;
        self.snapshot = None;
        self.edges.clear();
    }
    pub async fn leave(&mut self) -> Result<()> {
        if self.local.is_none() && self.snapshot.is_none() {
            return Ok(());
        }
        let binding = self.binding();
        self.local = None;
        self.snapshot = None;
        self.edges.clear();
        let (r, j) = binding?;
        Ok(self.rpc.leave(&r, &j).await?)
    }
    pub async fn end(&mut self) -> Result<()> {
        if self.local.is_none() && self.snapshot.is_none() {
            return Ok(());
        }
        let binding = self.binding();
        self.local = None;
        self.snapshot = None;
        self.edges.clear();
        let (r, j) = binding?;
        Ok(self.rpc.end(&r, &j).await?)
    }
    fn peer(&self, join: &str) -> Result<String> {
        self.snapshot
            .as_ref()
            .and_then(|s| s.members.iter().find(|m| m.join_id == join))
            .map(|m| m.member.clone())
            .ok_or(Error::Binding)
    }
    pub fn next_edge_attempt(&self, peer: &str) -> Result<u32> {
        let (room, local) = self.binding()?;
        if local.as_str() >= peer {
            return Err(Error::Binding);
        }
        self.peer(peer)?;
        match self.edges.get(&EdgeKey::new(&room, &local, peer)) {
            Some(state) if state.inflight.is_some() || state.completed => Err(Error::Busy),
            Some(state) => state.last.checked_add(1).ok_or(Error::Busy),
            None => Ok(1),
        }
    }
    pub async fn start_edge(&mut self, peer: &str, route: Route, offer: &str) -> Result<Attempt> {
        let number = self.next_edge_attempt(peer)?;
        let (room, local) = self.binding()?;
        let member = self.peer(peer)?;
        let edge = EdgeKey::new(&room, &local, peer);
        let state = self.edges.entry(edge.clone()).or_insert_with(Edge::new);
        if number == 1 && route != Route::Direct {
            return Err(Error::Binding);
        }
        let offer_hash = rpc::sdp_hash(offer, "offer")?;
        let s = self.snapshot.as_ref().ok_or(Error::Binding)?;
        let row = SdpRow {
            workspace: self.rpc.database().into(),
            room,
            id: rpc::random_id()?,
            sender: self.rpc.member_id().into(),
            sender_join: local,
            recipient: member,
            recipient_join: peer.into(),
            attempt: number,
            nonce: rpc::random_id()?,
            route,
            offer: offer.into(),
            offer_hash,
            answer: None,
            answer_hash: None,
            expires_unix: s.server_unix + rpc::MEETING_SDP_TTL,
            server_unix: s.server_unix,
        };
        let attempt = Attempt {
            edge,
            attempt_no: number,
            nonce: row.nonce.clone(),
            route,
            expires: Instant::now() + Duration::from_secs(rpc::MEETING_SDP_TTL),
        };
        state.last = number;
        state.inflight = Some((attempt.clone(), row.clone()));
        let posted = self.rpc.post_offer(&row).await?;
        let posted = rpc::validate_post_protocol(
            posted,
            &row,
            self.rpc.database(),
            false,
            self.rpc.is_v2(),
        )?;
        state.inflight = Some((attempt.clone(), posted));
        Ok(attempt)
    }
    pub fn fail_edge(&mut self, peer: &str) -> Result<()> {
        let (r, j) = self.binding()?;
        if let Some(e) = self.edges.get_mut(&EdgeKey::new(&r, &j, peer)) {
            e.inflight = None;
            e.incoming = None;
            e.completed = false;
        }
        Ok(())
    }
    fn incoming_valid(&self, r: &SdpRow, room: &str, local: &str) -> bool {
        r.validate_protocol(self.rpc.database(), self.rpc.is_v2())
            .is_ok()
            && r.room == room
            && r.recipient == self.rpc.member_id()
            && r.recipient_join == local
            && r.sender_join.as_str() < local
            && self.peer(&r.sender_join).is_ok_and(|m| m == r.sender)
    }
    pub async fn poll_offers(&mut self) -> Result<Vec<AuthenticatedMeetingOffer>> {
        let (room, local) = self.binding()?;
        let rows = self.rpc.poll_offers(&room, &local).await?;
        if rows.len() > 6 {
            return Err(Error::Binding);
        }
        let mut out = Vec::new();
        for row in rows {
            if !self.incoming_valid(&row, &room, &local) || row.answer.is_some() {
                continue;
            }
            let key = EdgeKey::new(&room, &local, &row.sender_join);
            let e = self.edges.entry(key.clone()).or_insert_with(Edge::new);
            if (e.completed && row.route != Route::Relay)
                || row.attempt <= e.seen
                || e.nonces.contains(&row.nonce)
                || e.nonces.len() >= 64
            {
                continue;
            }
            e.seen = row.attempt;
            e.nonces.insert(row.nonce.clone());
            e.incoming_expires =
                Some(Instant::now() + Duration::from_secs(row.expires_unix - row.server_unix));
            e.incoming = Some(row.clone());
            out.push(AuthenticatedMeetingOffer {
                edge: key,
                row,
                owner: self.owner.clone(),
            });
        }
        Ok(out)
    }
    pub async fn answer(&mut self, offer: &AuthenticatedMeetingOffer, answer: &str) -> Result<()> {
        let (room, local) = self.binding()?;
        if offer.owner != self.owner || !self.incoming_valid(&offer.row, &room, &local) {
            return Err(Error::Binding);
        }
        let hash = rpc::sdp_hash(answer, "answer")?;
        let e = self.edges.get_mut(&offer.edge).ok_or(Error::Binding)?;
        if !e.incoming_expires.is_some_and(|t| t > Instant::now()) {
            return Err(Error::Expired);
        }
        let pending = e.incoming.as_ref().ok_or(Error::Binding)?;
        if pending.id != offer.row.id
            || pending.attempt != offer.row.attempt
            || pending.nonce != offer.row.nonce
            || pending.offer_hash != offer.row.offer_hash
            || pending.route != offer.row.route
        {
            return Err(Error::Binding);
        }
        let mut row = e.incoming.take().ok_or(Error::Binding)?;
        row.answer = Some(answer.into());
        row.answer_hash = Some(hash);
        e.completed = true;
        let posted = self.rpc.post_answer(&row).await?;
        rpc::validate_post_protocol(posted, &row, self.rpc.database(), true, self.rpc.is_v2())?;
        Ok(())
    }
    pub async fn poll_answers(&mut self) -> Result<Vec<AuthenticatedMeetingAnswer>> {
        let (room, local) = self.binding()?;
        let rows = self.rpc.poll_answers(&room, &local).await?;
        if rows.len() > 6 {
            return Err(Error::Binding);
        }
        let mut out = Vec::new();
        for row in rows {
            if row
                .validate_protocol(self.rpc.database(), self.rpc.is_v2())
                .is_err()
                || row.room != room
                || row.sender != self.rpc.member_id()
                || row.sender_join != local
                || row.answer.is_none()
                || !self
                    .peer(&row.recipient_join)
                    .is_ok_and(|m| m == row.recipient)
            {
                continue;
            }
            let key = EdgeKey::new(&room, &local, &row.recipient_join);
            let Some(e) = self.edges.get_mut(&key) else {
                continue;
            };
            let Some((a, original)) = &e.inflight else {
                continue;
            };
            if a.expires <= Instant::now()
                || row.attempt != a.attempt_no
                || row.nonce != a.nonce
                || row.route != a.route
                || row.offer_hash != original.offer_hash
                || row.offer != original.offer
            {
                continue;
            }
            e.inflight = None;
            e.completed = true;
            out.push(AuthenticatedMeetingAnswer { edge: key, row });
        }
        Ok(out)
    }
}
