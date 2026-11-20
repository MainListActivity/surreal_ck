//! 只在测试构建存在的参考模型。它不能证明数据库实施了同样的权限规则。
use crate::protocol::{self, Binding, Error, Result};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Principal {
    database: String,
    member: String,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Decision {
    Accepted,
    Rejected,
}
struct Invitation {
    binding: Binding,
    offer: String,
    decision: Option<Decision>,
    answer: Option<String>,
    ended: bool,
}
#[derive(Default)]
struct DatabaseModel {
    members: HashSet<Principal>,
    invitations: HashMap<(String, String), Invitation>,
    last_invite: HashMap<Principal, u64>,
}
impl DatabaseModel {
    fn member(&self, who: &Principal) -> Result<()> {
        if self.members.contains(who) {
            Ok(())
        } else {
            Err(Error::Identity)
        }
    }
    fn invite(
        &mut self,
        actor: &Principal,
        recipient: &str,
        raw: &str,
        now: u64,
    ) -> Result<Binding> {
        self.member(actor)?;
        self.member(&Principal {
            database: actor.database.clone(),
            member: recipient.into(),
        })?;
        if actor.member == recipient {
            return Err(Error::Binding);
        }
        let offer_hash = protocol::validate_sdp(raw, "offer")?;
        if self
            .last_invite
            .get(actor)
            .is_some_and(|last| now.saturating_sub(*last) < 10)
        {
            return Err(Error::RateLimited);
        }
        let binding = Binding {
            database: actor.database.clone(),
            id: protocol::random_id()?,
            nonce: protocol::random_id()?,
            sender: actor.member.clone(),
            recipient: recipient.into(),
            offer_hash,
            generation: protocol::random_id()?,
            expires_at: now + protocol::INVITE_TTL_SECONDS,
        };
        self.last_invite.insert(actor.clone(), now);
        self.invitations.insert(
            (actor.database.clone(), binding.id.clone()),
            Invitation {
                binding: binding.clone(),
                offer: raw.into(),
                decision: None,
                answer: None,
                ended: false,
            },
        );
        Ok(binding)
    }
    fn read(&self, actor: &Principal, id: &str) -> Result<&Invitation> {
        self.member(actor)?;
        let item = self
            .invitations
            .get(&(actor.database.clone(), id.to_owned()))
            .ok_or(Error::Expired)?;
        if actor.member != item.binding.sender && actor.member != item.binding.recipient {
            return Err(Error::Binding);
        }
        Ok(item)
    }
    fn decide(
        &mut self,
        actor: &Principal,
        expected: &Binding,
        decision: Decision,
        now: u64,
    ) -> Result<()> {
        let item = self.read(actor, &expected.id)?;
        protocol::ensure_binding(&item.binding, expected, now)?;
        if actor.member != expected.recipient || item.ended || item.decision.is_some() {
            return Err(Error::Binding);
        }
        self.invitations
            .get_mut(&(actor.database.clone(), expected.id.clone()))
            .unwrap()
            .decision = Some(decision);
        Ok(())
    }
    fn answer(&mut self, actor: &Principal, expected: &Binding, raw: &str, now: u64) -> Result<()> {
        protocol::validate_sdp(raw, "answer")?;
        let item = self.read(actor, &expected.id)?;
        protocol::ensure_binding(&item.binding, expected, now)?;
        if actor.member != expected.recipient
            || item.ended
            || item.decision != Some(Decision::Accepted)
            || item.answer.is_some()
        {
            return Err(Error::Binding);
        }
        self.invitations
            .get_mut(&(actor.database.clone(), expected.id.clone()))
            .unwrap()
            .answer = Some(raw.into());
        Ok(())
    }
    fn end(&mut self, actor: &Principal, expected: &Binding) -> Result<()> {
        let item = self.read(actor, &expected.id)?;
        // 会话可以超过邀请TTL；结束仍要求完整绑定且不复活任何邀请。
        if item.binding != *expected || item.ended {
            return Err(Error::Binding);
        }
        self.invitations
            .get_mut(&(actor.database.clone(), expected.id.clone()))
            .unwrap()
            .ended = true;
        Ok(())
    }
}

/// 单一客户端在任何时刻只认一个邀请；消费 answer 后不能再次接受同一 answer。
#[derive(Default)]
struct ClientModel {
    current: Option<Binding>,
    answer_consumed: bool,
    last_poll: Option<u64>,
}
impl ClientModel {
    fn begin(&mut self, binding: Binding) -> Result<()> {
        if self.current.is_some() {
            return Err(Error::Busy);
        }
        self.current = Some(binding);
        self.answer_consumed = false;
        self.last_poll = None;
        Ok(())
    }
    fn poll(&mut self, now: u64) -> Result<()> {
        if self
            .last_poll
            .is_some_and(|last| now.saturating_sub(last) < 3)
        {
            return Err(Error::RateLimited);
        }
        self.last_poll = Some(now);
        Ok(())
    }
    fn consume(&mut self, binding: &Binding, now: u64) -> Result<()> {
        protocol::ensure_binding(binding, self.current.as_ref().ok_or(Error::Binding)?, now)?;
        if self.answer_consumed {
            return Err(Error::Binding);
        }
        self.answer_consumed = true;
        Ok(())
    }
    fn reset(&mut self) {
        self.current = None;
        self.answer_consumed = false;
        self.last_poll = None;
    }
}
fn principal(database: &str, member: &str) -> Principal {
    Principal {
        database: database.into(),
        member: member.into(),
    }
}
fn setup() -> (DatabaseModel, Principal, Principal, Principal) {
    let alice = principal("ws_a", "user:alice");
    let bob = principal("ws_a", "user:bob");
    let mallory = principal("ws_a", "user:mallory");
    let mut db = DatabaseModel::default();
    db.members.extend([
        alice.clone(),
        bob.clone(),
        mallory.clone(),
        principal("ws_b", "user:bob"),
    ]);
    (db, alice, bob, mallory)
}
fn offer() -> String {
    protocol::tests::fixture("offer")
}
fn answer() -> String {
    protocol::tests::fixture("answer")
}
#[test]
fn explicit_accept_required_before_answer_and_sender_cannot_accept() {
    let (mut db, a, b, _) = setup();
    let binding = db.invite(&a, &b.member, &offer(), 100).unwrap();
    assert_eq!(db.read(&a, &binding.id).unwrap().offer, offer());
    assert_eq!(db.answer(&b, &binding, &answer(), 101), Err(Error::Binding));
    assert_eq!(
        db.decide(&a, &binding, Decision::Accepted, 101),
        Err(Error::Binding)
    );
    db.decide(&b, &binding, Decision::Accepted, 101).unwrap();
    db.answer(&b, &binding, &answer(), 102).unwrap();
    assert!(db.read(&a, &binding.id).unwrap().answer.is_some());
    assert_eq!(db.answer(&b, &binding, &answer(), 103), Err(Error::Binding));
}
#[test]
fn rejects_nonmember_cross_workspace_third_party_and_removed_member() {
    let (mut db, a, b, m) = setup();
    let binding = db.invite(&a, &b.member, &offer(), 100).unwrap();
    assert!(db.read(&m, &binding.id).is_err());
    assert!(db
        .read(&principal("ws_b", "user:bob"), &binding.id)
        .is_err());
    assert!(db.invite(&a, "user:nonmember", &offer(), 110).is_err());
    assert!(db
        .invite(&principal("ws_a", "user:unknown"), &b.member, &offer(), 110)
        .is_err());
    assert!(db.decide(&m, &binding, Decision::Accepted, 101).is_err());
    db.members.remove(&b);
    assert_eq!(
        db.decide(&b, &binding, Decision::Accepted, 101),
        Err(Error::Identity)
    );
}
#[test]
fn rejects_decision_replay_rejection_overwrite_end_and_expiry() {
    let (mut db, a, b, _) = setup();
    let binding = db.invite(&a, &b.member, &offer(), 100).unwrap();
    db.decide(&b, &binding, Decision::Rejected, 101).unwrap();
    assert_eq!(
        db.decide(&b, &binding, Decision::Accepted, 102),
        Err(Error::Binding)
    );
    assert_eq!(db.answer(&b, &binding, &answer(), 102), Err(Error::Binding));
    let other = db.invite(&a, &b.member, &offer(), 110).unwrap();
    db.end(&a, &other).unwrap();
    assert_eq!(
        db.decide(&b, &other, Decision::Accepted, 111),
        Err(Error::Binding)
    );
    assert_eq!(db.end(&a, &other), Err(Error::Binding));
    let expired = db.invite(&a, &b.member, &offer(), 120).unwrap();
    assert_eq!(
        db.decide(&b, &expired, Decision::Accepted, 240),
        Err(Error::Expired)
    );
}
#[test]
fn limits_sending_and_polling_and_rejects_stale_client_generation() {
    let (mut db, a, b, _) = setup();
    let first = db.invite(&a, &b.member, &offer(), 100).unwrap();
    assert!(matches!(
        db.invite(&a, &b.member, &offer(), 109),
        Err(Error::RateLimited)
    ));
    let second = db.invite(&a, &b.member, &offer(), 110).unwrap();
    let mut client = ClientModel::default();
    client.begin(first.clone()).unwrap();
    assert_eq!(client.begin(second.clone()), Err(Error::Busy));
    client.poll(100).unwrap();
    assert_eq!(client.poll(102), Err(Error::RateLimited));
    client.poll(103).unwrap();
    client.consume(&first, 104).unwrap();
    assert_eq!(client.consume(&first, 105), Err(Error::Binding));
    client.reset();
    client.begin(second.clone()).unwrap();
    assert_eq!(client.consume(&first, 111), Err(Error::Binding));
    client.consume(&second, 111).unwrap();
}
#[test]
fn never_claims_mock_model_enables_production() {
    assert_eq!(
        crate::availability(),
        crate::Availability::BlockedPendingDatabaseRulesAndForkVerification
    );
}
