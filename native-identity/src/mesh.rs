//! 纯状态机，不创建 PeerConnection。字典序较小的 user 主动 offer；每次重建使用新 session。
//! 调用者在重连时先 reset，再同步快照；Apply 产生的 payload 只交给相应 generation 的 peer。
use crate::meeting::{
    key, record, MeetingError, MeetingResult, MeetingSignal, Participant, SignalKind,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeshAction {
    Offer {
        peer: String,
        generation: u64,
        session: String,
    },
    Close {
        peer: String,
        generation: u64,
    },
    Apply {
        signal: MeetingSignal,
        generation: u64,
        rollback: bool,
    },
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Waiting,
    Offering,
    Answering,
    Stable,
    Closed,
}
struct Peer {
    generation: u64,
    session: Option<String>,
    phase: Phase,
    latest_offer_ns: u64,
    nonces: HashSet<String>,
}
pub struct MeshCoordinator {
    meeting: String,
    local: String,
    epoch: String,
    generation: u64,
    present: BTreeSet<String>,
    peers: BTreeMap<String, Peer>,
    retired: HashSet<String>,
}
impl MeshCoordinator {
    /// epoch 须由 fresh_key 生成，每次新建协调器使用新值。
    pub fn new(meeting: &str, local: &str, epoch: &str) -> MeetingResult<Self> {
        record(meeting, "meeting")?;
        record(local, "user")?;
        key(epoch)?;
        Ok(Self {
            meeting: meeting.into(),
            local: local.into(),
            epoch: epoch.into(),
            generation: 0,
            present: BTreeSet::new(),
            peers: BTreeMap::new(),
            retired: HashSet::new(),
        })
    }
    pub fn sync(&mut self, participants: &[Participant]) -> MeetingResult<Vec<MeshAction>> {
        let present = participants
            .iter()
            .filter(|p| p.meeting == self.meeting && p.left_at.is_none())
            .map(|p| p.user.clone())
            .collect();
        self.reconcile(present)
    }
    /// 用 LIVE 行保留快照之间短暂的离开/重新加入转换。
    pub fn participant(&mut self, participant: &Participant) -> MeetingResult<Vec<MeshAction>> {
        if participant.meeting != self.meeting {
            return Ok(Vec::new());
        }
        let mut present = self.present.clone();
        if participant.left_at.is_none() {
            present.insert(participant.user.clone());
        } else {
            present.remove(&participant.user);
        }
        self.reconcile(present)
    }
    fn retire(&mut self, session: Option<String>) -> MeetingResult<()> {
        if let Some(session) = session {
            if self.retired.len() >= 1024 && !self.retired.contains(&session) {
                return Err(MeetingError::Overflow);
            }
            self.retired.insert(session);
        }
        Ok(())
    }
    fn reconcile(&mut self, present: BTreeSet<String>) -> MeetingResult<Vec<MeshAction>> {
        if present.len() > 6 {
            return Err(MeetingError::Overflow);
        }
        for user in &present {
            record(user, "user")?;
        }
        let mut actions = Vec::new();
        let removed: Vec<String> = self
            .peers
            .keys()
            .filter(|p| !present.contains(*p) || !present.contains(&self.local))
            .cloned()
            .collect();
        for user in removed {
            let peer = self.peers.remove(&user).ok_or(MeetingError::Protocol)?;
            self.retire(peer.session)?;
            actions.push(MeshAction::Close {
                peer: user,
                generation: peer.generation,
            });
        }
        if present.contains(&self.local) {
            for user in &present {
                if user == &self.local || self.peers.contains_key(user) {
                    continue;
                }
                self.generation = self
                    .generation
                    .checked_add(1)
                    .ok_or(MeetingError::Overflow)?;
                let session = if self.local < *user {
                    Some(format!(
                        "{:x}",
                        Sha256::digest(
                            serde_json::to_vec(&(
                                &self.epoch,
                                &self.meeting,
                                &self.local,
                                user,
                                self.generation
                            ))
                            .map_err(|_| MeetingError::Protocol)?
                        )
                    ))
                } else {
                    None
                };
                if let Some(session) = &session {
                    actions.push(MeshAction::Offer {
                        peer: user.clone(),
                        generation: self.generation,
                        session: session.clone(),
                    });
                }
                let phase = if session.is_some() {
                    Phase::Offering
                } else {
                    Phase::Waiting
                };
                self.peers.insert(
                    user.clone(),
                    Peer {
                        generation: self.generation,
                        session,
                        phase,
                        latest_offer_ns: 0,
                        nonces: HashSet::new(),
                    },
                );
            }
        }
        self.present = present;
        Ok(actions)
    }
    /// 连接断开/成员快照丢失时立即关闭旧 peer；随后 sync 会创建新 generation。
    pub fn reset(&mut self) -> MeetingResult<Vec<MeshAction>> {
        self.reconcile(BTreeSet::new())
    }
    /// 媒体后端失败后显式重建。只有确定的 offer 方会主动发送新 offer。
    pub fn restart(&mut self, user: &str) -> MeetingResult<Vec<MeshAction>> {
        if !self.present.contains(user) || user == self.local {
            return Err(MeetingError::Input);
        }
        let present = self.present.clone();
        let mut reduced = present.clone();
        reduced.remove(user);
        let mut actions = self.reconcile(reduced)?;
        actions.extend(self.reconcile(present)?);
        Ok(actions)
    }
    /// 成功发送 answer 后调用；不会把仅收到 offer 当作连接成功。
    pub fn answered(&mut self, user: &str, session: &str) -> MeetingResult<()> {
        let peer = self.peers.get_mut(user).ok_or(MeetingError::Input)?;
        if peer.phase != Phase::Answering || peer.session.as_deref() != Some(session) {
            return Err(MeetingError::Input);
        }
        peer.phase = Phase::Stable;
        Ok(())
    }
    pub fn receive(
        &mut self,
        signal: &MeetingSignal,
        server_ns: u64,
    ) -> MeetingResult<Vec<MeshAction>> {
        if signal.meeting != self.meeting
            || signal.to != self.local
            || signal.from == self.local
            || signal.expires_ns <= server_ns
            || signal.created_ns > server_ns
            || signal.created_ns >= signal.expires_ns
            || !self.present.contains(&self.local)
            || !self.present.contains(&signal.from)
        {
            return Ok(Vec::new());
        }
        key(&signal.session)?;
        key(&signal.nonce)?;
        if self.retired.contains(&signal.session) {
            return Ok(Vec::new());
        }
        let Some(peer) = self.peers.get_mut(&signal.from) else {
            return Ok(Vec::new());
        };
        if peer.nonces.contains(&signal.nonce) {
            return Ok(Vec::new());
        }
        let mut rollback = false;
        match signal.kind {
            SignalKind::Offer => {
                if self.local < signal.from
                    || signal.created_ns < peer.latest_offer_ns
                    || peer.session.as_deref() == Some(&signal.session)
                {
                    return Ok(Vec::new());
                }
                if self.retired.len() >= 1024 {
                    return Err(MeetingError::Overflow);
                }
                if let Some(old) = peer.session.replace(signal.session.clone()) {
                    self.retired.insert(old);
                }
                rollback = peer.phase == Phase::Offering;
                peer.phase = Phase::Answering;
                peer.latest_offer_ns = signal.created_ns;
                peer.nonces.clear();
            }
            SignalKind::Answer => {
                if peer.phase != Phase::Offering || peer.session.as_deref() != Some(&signal.session)
                {
                    return Ok(Vec::new());
                }
                peer.phase = Phase::Stable;
            }
            SignalKind::Ice => {
                if peer.session.as_deref() != Some(&signal.session)
                    || matches!(peer.phase, Phase::Waiting | Phase::Closed)
                {
                    return Ok(Vec::new());
                }
            }
            SignalKind::Bye => {
                if peer.session.as_deref() != Some(&signal.session) || peer.phase == Phase::Closed {
                    return Ok(Vec::new());
                }
                peer.phase = Phase::Closed;
                return Ok(vec![MeshAction::Close {
                    peer: signal.from.clone(),
                    generation: peer.generation,
                }]);
            }
        }
        if peer.nonces.len() >= 2048 {
            return Err(MeetingError::Overflow);
        }
        peer.nonces.insert(signal.nonce.clone());
        Ok(vec![MeshAction::Apply {
            signal: signal.clone(),
            generation: peer.generation,
            rollback,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn member(user: &str) -> Participant {
        Participant {
            id: format!("meeting_participant:{user}"),
            meeting: "meeting:m".into(),
            user: format!("user:{user}"),
            role: "member".into(),
            joined_at: "now".into(),
            left_at: None,
            last_seen: "now".into(),
            mic: false,
            cam: false,
            screen: false,
        }
    }
    fn coordinator(user: &str) -> MeshCoordinator {
        MeshCoordinator::new("meeting:m", &format!("user:{user}"), &"a".repeat(64)).unwrap()
    }
    fn signal(from: &str, to: &str, kind: SignalKind, session: &str) -> MeetingSignal {
        MeetingSignal {
            id: "meeting_signal:test".into(),
            meeting: "meeting:m".into(),
            from: format!("user:{from}"),
            to: format!("user:{to}"),
            kind,
            payload: "private-sdp".into(),
            session: session.into(),
            nonce: "b".repeat(64),
            created_ns: 100,
            expires_ns: 200,
        }
    }
    #[test]
    fn three_members_have_exactly_one_offerer_per_pair_and_empty_is_safe() {
        let members = vec![member("a"), member("b"), member("c")];
        let counts: Vec<_> = ["a", "b", "c"]
            .iter()
            .map(|user| coordinator(user).sync(&members).unwrap().len())
            .collect();
        assert_eq!(counts, vec![2, 1, 0]);
        let mut mesh = coordinator("a");
        assert!(mesh.sync(&[]).unwrap().is_empty());
        assert_eq!(mesh.sync(&members).unwrap().len(), 2);
        assert!(mesh.sync(&members).unwrap().is_empty());
        assert_eq!(mesh.reset().unwrap().len(), 2);
        assert!(mesh.sync(&[member("b")]).unwrap().is_empty());
        assert!(MeshCoordinator::new("bad", "user:a", &"a".repeat(64)).is_err());
        assert!(mesh
            .sync(&(0..7).map(|n| member(&n.to_string())).collect::<Vec<_>>())
            .is_err());
    }
    #[test]
    fn leave_rejoin_reconnect_rebuild_and_stale_sessions_are_rejected() {
        let mut mesh = coordinator("a");
        let members = vec![member("a"), member("b")];
        let old = mesh.sync(&members).unwrap();
        let MeshAction::Offer {
            session: old_session,
            generation: old_generation,
            ..
        } = &old[0]
        else {
            panic!()
        };
        let mut departed = member("b");
        departed.left_at = Some("later".into());
        assert!(matches!(
            &mesh.participant(&departed).unwrap()[0],
            MeshAction::Close { .. }
        ));
        assert!(mesh
            .receive(&signal("b", "a", SignalKind::Answer, old_session), 110)
            .unwrap()
            .is_empty());
        let new = mesh.participant(&member("b")).unwrap();
        let MeshAction::Offer {
            session,
            generation,
            ..
        } = &new[0]
        else {
            panic!()
        };
        assert_ne!(session, old_session);
        assert!(generation > old_generation);
        assert!(mesh
            .receive(&signal("b", "a", SignalKind::Answer, old_session), 110)
            .unwrap()
            .is_empty());
        assert_eq!(
            mesh.receive(&signal("b", "a", SignalKind::Answer, session), 110)
                .unwrap()
                .len(),
            1
        );
        assert!(
            !format!("{:?}", signal("b", "a", SignalKind::Answer, session)).contains("private-sdp")
        );
        mesh.reset().unwrap();
        assert!(
            matches!(&mesh.sync(&members).unwrap()[0],MeshAction::Offer {session:new,..} if new!=session)
        );
    }
    #[test]
    fn glare_expiry_replay_ice_and_bye() {
        let members = vec![member("a"), member("b")];
        let mut impolite = coordinator("a");
        impolite.sync(&members).unwrap();
        assert!(impolite
            .receive(&signal("b", "a", SignalKind::Offer, &"c".repeat(64)), 110)
            .unwrap()
            .is_empty());
        let mut polite = coordinator("b");
        polite.sync(&members).unwrap();
        polite.peers.get_mut("user:a").unwrap().phase = Phase::Offering;
        let offer = signal("a", "b", SignalKind::Offer, &"c".repeat(64));
        assert!(polite.receive(&offer, 200).unwrap().is_empty());
        assert!(polite.receive(&offer, 99).unwrap().is_empty());
        assert!(matches!(
            &polite.receive(&offer, 110).unwrap()[0],
            MeshAction::Apply { rollback: true, .. }
        ));
        assert!(polite.receive(&offer, 110).unwrap().is_empty());
        polite.answered("user:a", &offer.session).unwrap();
        let mut ice = signal("a", "b", SignalKind::Ice, &offer.session);
        ice.nonce = "d".repeat(64);
        assert_eq!(polite.receive(&ice, 110).unwrap().len(), 1);
        assert!(polite.receive(&ice, 110).unwrap().is_empty());
        let mut bye = signal("a", "b", SignalKind::Bye, &offer.session);
        bye.nonce = "e".repeat(64);
        assert!(matches!(
            &polite.receive(&bye, 110).unwrap()[0],
            MeshAction::Close { .. }
        ));
        assert!(polite.receive(&ice, 110).unwrap().is_empty());
        assert!(polite.answered("user:a", &offer.session).is_err());
        assert!(polite.restart("user:outsider").is_err());
    }
}
