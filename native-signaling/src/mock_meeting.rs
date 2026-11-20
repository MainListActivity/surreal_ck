//! 内存协议模型，不是生产授权器；时钟由测试显式推进。
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, MutexGuard},
};
use surreal_ck_native_identity::{meeting::*, IdentityError as E, Result};
const LEASE: u64 = 90;
#[derive(Clone, Default)]
pub struct MockMeetingDb {
    state: Arc<Mutex<State>>,
}
#[derive(Default)]
struct State {
    now: u64,
    rooms: BTreeMap<String, MockRoom>,
    offers: Vec<SdpRow>,
}
struct MockRoom {
    workspace: String,
    room: Room,
    invited: BTreeSet<String>,
    members: Vec<MeetingMember>,
    nonces: BTreeSet<(String, String)>,
}
pub struct MockMeetingRpc {
    db: MockMeetingDb,
    workspace: String,
    actor: String,
    #[cfg(test)]
    pub(crate) poll_rows: Option<Vec<SdpRow>>,
}
impl MockMeetingDb {
    pub fn new() -> Self {
        let db = Self::default();
        db.state.lock().expect("mock mutex").now = 1000;
        db
    }
    pub fn actor(&self, workspace: &str, member: &str) -> MockMeetingRpc {
        MockMeetingRpc {
            db: self.clone(),
            workspace: workspace.into(),
            actor: member.into(),
            #[cfg(test)]
            poll_rows: None,
        }
    }
    pub fn advance(&self, seconds: u64) {
        self.state.lock().expect("mock mutex").now += seconds;
    }
    fn lock(&self) -> Result<MutexGuard<'_, State>> {
        self.state.lock().map_err(|_| E::MeetingUnavailable)
    }
}
impl MockRoom {
    fn expire(&mut self, now: u64) {
        let n = self.members.len();
        self.members.retain(|m| m.lease_expires_unix > now);
        if n != self.members.len() {
            self.room.version += 1;
        }
        if self.room.expires_unix <= now && self.room.status == RoomStatus::Open {
            self.room.status = RoomStatus::Ended;
            self.room.version += 1;
        }
    }
    fn snapshot(&self, actor: &str, now: u64) -> Snapshot {
        Snapshot {
            workspace: self.workspace.clone(),
            room: self.room.clone(),
            local_join: self
                .members
                .iter()
                .find(|m| m.member == actor)
                .map(|m| m.join_id.clone()),
            members: self.members.clone(),
            server_unix: now,
        }
    }
    fn active(&self, actor: &str, join: &str) -> Result<()> {
        if self.room.status != RoomStatus::Open {
            return Err(E::MeetingExpired);
        }
        if !self
            .members
            .iter()
            .any(|m| m.member == actor && m.join_id == join)
        {
            return Err(E::MeetingDenied);
        }
        Ok(())
    }
}
impl MockMeetingRpc {
    fn room<'a>(&self, s: &'a mut State, id: &str) -> Result<&'a mut MockRoom> {
        let now = s.now;
        let r = s
            .rooms
            .get_mut(id)
            .filter(|r| r.workspace == self.workspace)
            .ok_or(E::MeetingNotFound)?;
        if r.room.host != self.actor && !r.invited.contains(&self.actor) {
            return Err(E::MeetingNotFound);
        }
        r.expire(now);
        Ok(r)
    }
    fn poll(&self, room: &str, join: &str, answers: bool) -> Result<Vec<SdpRow>> {
        let mut s = self.db.lock()?;
        self.room(&mut s, room)?.active(&self.actor, join)?;
        let now = s.now;
        Ok(s.offers
            .iter()
            .filter(|r| {
                r.workspace == self.workspace
                    && r.room == room
                    && r.expires_unix > now
                    && if answers {
                        r.sender == self.actor && r.sender_join == join && r.answer.is_some()
                    } else {
                        r.recipient == self.actor && r.recipient_join == join && r.answer.is_none()
                    }
            })
            .take(6)
            .cloned()
            .map(|mut r| {
                r.server_unix = now;
                r
            })
            .collect())
    }
}
impl MeetingRpc for MockMeetingRpc {
    fn database(&self) -> &str {
        &self.workspace
    }
    fn member_id(&self) -> &str {
        &self.actor
    }
    async fn capability(&mut self) -> Result<()> {
        Ok(())
    }
    async fn create(&mut self, nonce: &str) -> Result<Snapshot> {
        if !valid_hex(nonce) {
            return Err(E::MeetingInput);
        }
        let mut s = self.db.lock()?;
        let now = s.now;
        if let Some(r) = s.rooms.values().find(|r| {
            r.workspace == self.workspace && r.nonces.contains(&(self.actor.clone(), nonce.into()))
        }) {
            return Ok(r.snapshot(&self.actor, now));
        }
        let id = random_id()?;
        let code = id[..16].to_ascii_uppercase();
        let r = MockRoom {
            workspace: self.workspace.clone(),
            room: Room {
                id: id.clone(),
                code,
                host: self.actor.clone(),
                status: RoomStatus::Open,
                version: 1,
                expires_unix: now + 3600,
            },
            invited: BTreeSet::new(),
            members: vec![MeetingMember {
                member: self.actor.clone(),
                join_id: nonce.into(),
                lease_expires_unix: now + LEASE,
            }],
            nonces: BTreeSet::from([(self.actor.clone(), nonce.into())]),
        };
        let snap = r.snapshot(&self.actor, now);
        s.rooms.insert(id, r);
        Ok(snap)
    }
    async fn invite(&mut self, room: &str, recipients: &[String]) -> Result<InviteResult> {
        let mut s = self.db.lock()?;
        let r = self.room(&mut s, room)?;
        if r.room.host != self.actor {
            return Err(E::MeetingDenied);
        }
        if r.room.status != RoomStatus::Open {
            return Err(E::MeetingExpired);
        }
        let invited = recipients
            .iter()
            .map(|k| format!("user:{k}"))
            .collect::<Vec<_>>();
        for m in &invited {
            member_key(m)?;
            r.invited.insert(m.clone());
        }
        Ok(InviteResult {
            room: room.into(),
            invited,
        })
    }
    async fn invitations(&mut self) -> Result<Vec<Invitation>> {
        let mut s = self.db.lock()?;
        let now = s.now;
        Ok(s.rooms
            .values_mut()
            .filter_map(|r| {
                r.expire(now);
                (r.workspace == self.workspace
                    && r.invited.contains(&self.actor)
                    && r.room.status == RoomStatus::Open)
                    .then(|| Invitation {
                        workspace: r.workspace.clone(),
                        room: r.room.id.clone(),
                        code: r.room.code.clone(),
                        host: r.room.host.clone(),
                        expires_unix: r.room.expires_unix,
                        server_unix: now,
                    })
            })
            .take(20)
            .collect())
    }
    async fn join(&mut self, code: &str, join_id: &str) -> Result<Snapshot> {
        if !valid_code(code) || !valid_hex(join_id) {
            return Err(E::MeetingInput);
        }
        let mut s = self.db.lock()?;
        let now = s.now;
        let id = s
            .rooms
            .iter()
            .find(|(_, r)| r.workspace == self.workspace && r.room.code == code)
            .map(|(id, _)| id.clone())
            .ok_or(E::MeetingNotFound)?;
        let r = self.room(&mut s, &id)?;
        if r.room.status != RoomStatus::Open {
            return Err(E::MeetingExpired);
        }
        if r.members
            .iter()
            .any(|m| m.join_id == join_id && m.member != self.actor)
        {
            return Err(E::MeetingRetry);
        }
        if r.members
            .iter()
            .any(|m| m.member == self.actor && m.join_id == join_id)
        {
            return Ok(r.snapshot(&self.actor, now));
        }
        if !r.members.iter().any(|m| m.member == self.actor) && r.members.len() >= MAX_MEMBERS {
            return Err(E::MeetingFull);
        }
        r.members.retain(|m| m.member != self.actor);
        r.members.push(MeetingMember {
            member: self.actor.clone(),
            join_id: join_id.into(),
            lease_expires_unix: now + LEASE,
        });
        r.room.version += 1;
        Ok(r.snapshot(&self.actor, now))
    }
    async fn snapshot(&mut self, room: &str, join: &str) -> Result<Snapshot> {
        let mut s = self.db.lock()?;
        let now = s.now;
        let r = self.room(&mut s, room)?;
        r.active(&self.actor, join)?;
        Ok(r.snapshot(&self.actor, now))
    }
    async fn renew(&mut self, room: &str, join: &str) -> Result<Snapshot> {
        let mut s = self.db.lock()?;
        let now = s.now;
        let r = self.room(&mut s, room)?;
        r.active(&self.actor, join)?;
        for m in &mut r.members {
            if m.member == self.actor && m.join_id == join {
                m.lease_expires_unix = now + LEASE;
            }
        }
        Ok(r.snapshot(&self.actor, now))
    }
    async fn leave(&mut self, room: &str, join: &str) -> Result<()> {
        let mut s = self.db.lock()?;
        let r = self.room(&mut s, room)?;
        let n = r.members.len();
        r.members
            .retain(|m| !(m.member == self.actor && m.join_id == join));
        if n != r.members.len() {
            r.room.version += 1;
        }
        Ok(())
    }
    async fn end(&mut self, room: &str, join: &str) -> Result<()> {
        let mut s = self.db.lock()?;
        let r = self.room(&mut s, room)?;
        if r.room.host != self.actor {
            return Err(E::MeetingDenied);
        }
        if r.room.status == RoomStatus::Ended {
            return Ok(());
        }
        r.active(&self.actor, join)?;
        r.room.status = RoomStatus::Ended;
        r.room.version += 1;
        Ok(())
    }
    async fn post_offer(&mut self, row: &SdpRow) -> Result<SdpRow> {
        row.validate(&self.workspace)?;
        let mut s = self.db.lock()?;
        let now = s.now;
        let r = self.room(&mut s, &row.room)?;
        r.active(&self.actor, &row.sender_join)?;
        if row.sender != self.actor
            || row.sender_join >= row.recipient_join
            || !r
                .members
                .iter()
                .any(|m| m.member == row.recipient && m.join_id == row.recipient_join)
        {
            return Err(E::MeetingDenied);
        }
        if s.offers.iter().any(|r| {
            r.room == row.room
                && r.sender_join == row.sender_join
                && r.recipient_join == row.recipient_join
                && r.attempt >= row.attempt
        }) {
            return Err(E::MeetingRetry);
        }
        s.offers.retain(|r| {
            !(r.room == row.room
                && r.sender_join == row.sender_join
                && r.recipient_join == row.recipient_join)
        });
        let mut row = row.clone();
        row.server_unix = now;
        row.expires_unix = now + MEETING_SDP_TTL;
        row.id = random_id()?;
        s.offers.push(row.clone());
        Ok(row)
    }
    async fn poll_offers(&mut self, room: &str, join: &str) -> Result<Vec<SdpRow>> {
        #[cfg(test)]
        if let Some(rows) = self.poll_rows.take() {
            return Ok(rows);
        }
        self.poll(room, join, false)
    }
    async fn post_answer(&mut self, row: &SdpRow) -> Result<SdpRow> {
        row.validate(&self.workspace)?;
        let mut s = self.db.lock()?;
        let now = s.now;
        self.room(&mut s, &row.room)?
            .active(&self.actor, &row.recipient_join)?;
        if row.recipient != self.actor || row.answer.is_none() {
            return Err(E::MeetingDenied);
        }
        let old = s
            .offers
            .iter_mut()
            .find(|o| {
                o.workspace == self.workspace
                    && o.room == row.room
                    && o.sender_join == row.sender_join
                    && o.recipient_join == row.recipient_join
                    && o.attempt == row.attempt
                    && o.nonce == row.nonce
                    && o.offer_hash == row.offer_hash
                    && o.route == row.route
                    && o.expires_unix > now
            })
            .ok_or(E::MeetingRetry)?;
        if old.answer.is_some() && old.answer != row.answer {
            return Err(E::MeetingRetry);
        }
        old.answer = row.answer.clone();
        old.answer_hash = row.answer_hash.clone();
        Ok(old.clone())
    }
    async fn poll_answers(&mut self, room: &str, join: &str) -> Result<Vec<SdpRow>> {
        #[cfg(test)]
        if let Some(rows) = self.poll_rows.take() {
            return Ok(rows);
        }
        self.poll(room, join, true)
    }
}
