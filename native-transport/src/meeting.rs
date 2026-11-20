//! 每条会议边独立协商；不承载房间鉴权或信令 IO。
use crate::{media, Peer, Route};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Instant};
use tokio::sync::mpsc;
use webrtc::{
    api::setting_engine::SettingEngine,
    ice::candidate::{CandidatePairState, CandidateType},
    peer_connection::{
        peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription,
    },
    stats::StatsReportType,
};

#[derive(thiserror::Error)]
pub enum Error {
    #[error("无效的会议标识")]
    InvalidId,
    #[error("无效的边端点")]
    InvalidEndpoint,
    #[error("协商状态或轮次不匹配")]
    InvalidAttempt,
    #[error("协商已过期")]
    Expired,
    #[error("应答未绑定原始 offer")]
    OfferBinding,
    #[error("未配置授权中继")]
    RelayNotConfigured,
    #[error("传输操作失败")]
    Transport(#[from] crate::Error),
}
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
macro_rules! identifier {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, Error> {
                let value = value.into();
                if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
                    return Err(Error::InvalidId);
                }
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}
identifier!(JoinId);
identifier!(RoomId);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct EdgeKey {
    pub room: RoomId,
    low: JoinId,
    high: JoinId,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeRole {
    Offerer,
    Answerer,
}
impl EdgeKey {
    pub fn new(room: RoomId, a: JoinId, b: JoinId) -> Result<Self, Error> {
        if a == b {
            return Err(Error::InvalidEndpoint);
        }
        let (low, high) = if a < b { (a, b) } else { (b, a) };
        Ok(Self { room, low, high })
    }
    pub fn offerer(&self) -> &JoinId {
        &self.low
    }
    pub fn role(&self, local: &JoinId) -> Result<EdgeRole, Error> {
        if local == &self.low {
            Ok(EdgeRole::Offerer)
        } else if local == &self.high {
            Ok(EdgeRole::Answerer)
        } else {
            Err(Error::InvalidEndpoint)
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteKind {
    Direct,
    Relay,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    pub edge: EdgeKey,
    pub attempt_no: u32,
    pub nonce: [u8; 16],
    pub route: RouteKind,
    pub expires_at: Instant,
}
impl Attempt {
    fn validate(&self) -> Result<(), Error> {
        if Instant::now() >= self.expires_at {
            Err(Error::Expired)
        } else {
            Ok(())
        }
    }
}
pub fn offer_hash(offer: &RTCSessionDescription) -> [u8; 32] {
    Sha256::digest(offer.sdp.as_bytes()).into()
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ObservedRoute {
    Direct,
    Relay,
    #[default]
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeState {
    Idle,
    Negotiating,
    Connected(ObservedRoute),
}
pub struct EdgeNegotiator {
    edge: EdgeKey,
    relay_allowed: bool,
    last: Option<u32>,
    active: Option<Attempt>,
    hash: Option<[u8; 32]>,
    answered: bool,
    state: EdgeState,
}
impl EdgeNegotiator {
    pub fn new(edge: EdgeKey, route: &Route) -> Result<Self, Error> {
        route.clone().config()?;
        Ok(Self {
            edge,
            relay_allowed: matches!(route, Route::RelayFallback { .. }),
            last: None,
            active: None,
            hash: None,
            answered: false,
            state: EdgeState::Idle,
        })
    }
    pub fn begin(
        &mut self,
        attempt_no: u32,
        route: RouteKind,
        nonce: [u8; 16],
        expires_at: Instant,
    ) -> Result<Attempt, Error> {
        if self.active.is_some()
            || self.state != EdgeState::Idle
            || self.last.is_some_and(|n| attempt_no <= n)
        {
            return Err(Error::InvalidAttempt);
        }
        if route == RouteKind::Relay && !self.relay_allowed {
            return Err(Error::RelayNotConfigured);
        }
        let attempt = Attempt {
            edge: self.edge.clone(),
            attempt_no,
            nonce,
            route,
            expires_at,
        };
        attempt.validate()?;
        self.last = Some(attempt_no);
        self.active = Some(attempt.clone());
        self.hash = None;
        self.answered = false;
        self.state = EdgeState::Negotiating;
        Ok(attempt)
    }
    fn current(&self, attempt: &Attempt) -> Result<(), Error> {
        if self.active.as_ref() != Some(attempt) {
            return Err(Error::InvalidAttempt);
        }
        attempt.validate()
    }
    pub fn bind_offer(
        &mut self,
        attempt: &Attempt,
        offer: &RTCSessionDescription,
    ) -> Result<(), Error> {
        self.current(attempt)?;
        if self.hash.is_some() {
            return Err(Error::InvalidAttempt);
        }
        self.hash = Some(offer_hash(offer));
        Ok(())
    }
    pub fn accept_answer(
        &mut self,
        attempt: &Attempt,
        bound_offer_hash: [u8; 32],
    ) -> Result<(), Error> {
        self.current(attempt)?;
        if self.answered {
            return Err(Error::InvalidAttempt);
        }
        if self.hash != Some(bound_offer_hash) {
            return Err(Error::OfferBinding);
        }
        self.answered = true;
        Ok(())
    }
    pub fn mark_connected(&mut self, route: ObservedRoute) -> Result<(), Error> {
        let attempt = self.active.as_ref().ok_or(Error::InvalidAttempt)?;
        attempt.validate()?;
        if !self.answered || route == ObservedRoute::Unknown {
            return Err(Error::InvalidAttempt);
        }
        self.active = None;
        self.state = EdgeState::Connected(route);
        Ok(())
    }
    pub fn fail(&mut self) {
        self.active = None;
        self.hash = None;
        self.answered = false;
        self.state = EdgeState::Idle;
    }
    pub fn state(&self) -> EdgeState {
        self.state
    }
}

pub struct MeetingEdge {
    peer: Peer,
    media: Arc<media::Media>,
    events: Option<mpsc::Receiver<media::Event>>,
    attempt: Attempt,
    role: EdgeRole,
    hash: Option<[u8; 32]>,
    answered: bool,
}
impl MeetingEdge {
    pub async fn new(
        attempt: Attempt,
        local_join: JoinId,
        route: Route,
        stun_urls: Vec<String>,
        settings: SettingEngine,
    ) -> Result<Self, Error> {
        attempt.validate()?;
        let role = attempt.edge.role(&local_join)?;
        if (attempt.route == RouteKind::Relay) != matches!(route, Route::RelayFallback { .. }) {
            return Err(Error::RelayNotConfigured);
        }
        let peer = Peer::new_with_settings(route, stun_urls, settings).await?;
        let (media, events) = match media::Media::attach(&peer).await {
            Ok(value) => value,
            Err(error) => {
                let _ = peer.close().await;
                return Err(error.into());
            }
        };
        Ok(Self {
            peer,
            media: Arc::new(media),
            events: Some(events),
            attempt,
            role,
            hash: None,
            answered: false,
        })
    }
    pub async fn offer(&mut self) -> Result<RTCSessionDescription, Error> {
        self.attempt.validate()?;
        if self.role != EdgeRole::Offerer || self.hash.is_some() {
            return Err(Error::InvalidAttempt);
        }
        let offer = self.peer.offer().await?;
        self.hash = Some(offer_hash(&offer));
        Ok(offer)
    }
    pub async fn answer(
        &mut self,
        offer: RTCSessionDescription,
    ) -> Result<RTCSessionDescription, Error> {
        self.attempt.validate()?;
        if self.role != EdgeRole::Answerer || self.hash.is_some() {
            return Err(Error::InvalidAttempt);
        }
        self.hash = Some(offer_hash(&offer));
        let answer = self.peer.answer(offer).await?;
        self.answered = true;
        Ok(answer)
    }
    pub async fn accept_answer(
        &mut self,
        answer: RTCSessionDescription,
        bound_offer_hash: [u8; 32],
    ) -> Result<(), Error> {
        self.attempt.validate()?;
        if self.role != EdgeRole::Offerer || self.answered {
            return Err(Error::InvalidAttempt);
        }
        if self.hash != Some(bound_offer_hash) {
            return Err(Error::OfferBinding);
        }
        self.peer.accept_answer(answer).await?;
        self.answered = true;
        Ok(())
    }
    pub fn media(&self) -> Arc<media::Media> {
        self.media.clone()
    }
    pub fn take_events(&mut self) -> Option<mpsc::Receiver<media::Event>> {
        self.events.take()
    }
    pub fn connection_state(&self) -> RTCPeerConnectionState {
        self.peer.connection().connection_state()
    }
    pub async fn stats(&self) -> EdgeStats {
        observe(&self.peer).await
    }
    pub async fn close(&self) -> Result<(), Error> {
        Ok(self.peer.close().await?)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EdgeStats {
    pub route: ObservedRoute,
    pub rtp_packets_sent: u64,
    pub rtp_packets_received: u64,
    pub rtp_bytes_sent: u64,
    pub rtp_bytes_received: u64,
}
pub async fn observe(peer: &Peer) -> EdgeStats {
    let report = peer.connection().get_stats().await;
    let mut result = EdgeStats::default();
    for entry in report.reports.values() {
        match entry {
            StatsReportType::CandidatePair(pair)
                if pair.nominated && pair.state == CandidatePairState::Succeeded =>
            {
                let local = report.reports.get(&pair.local_candidate_id);
                let remote = report.reports.get(&pair.remote_candidate_id);
                if let (
                    Some(StatsReportType::LocalCandidate(local)),
                    Some(StatsReportType::RemoteCandidate(remote)),
                ) = (local, remote)
                {
                    result.route = if local.candidate_type == CandidateType::Relay
                        || remote.candidate_type == CandidateType::Relay
                    {
                        ObservedRoute::Relay
                    } else {
                        ObservedRoute::Direct
                    };
                }
            }
            StatsReportType::InboundRTP(rtp) => {
                result.rtp_packets_received += rtp.packets_received;
                result.rtp_bytes_received += rtp.bytes_received;
            }
            StatsReportType::OutboundRTP(rtp) => {
                result.rtp_packets_sent += rtp.packets_sent;
                result.rtp_bytes_sent += rtp.bytes_sent;
            }
            _ => {}
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn edge() -> EdgeKey {
        EdgeKey::new(
            RoomId::new("room").unwrap(),
            JoinId::new("b").unwrap(),
            JoinId::new("a").unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn meeting_ids_roles() {
        for value in ["", "a\nb", &"x".repeat(129)] {
            assert!(JoinId::new(value).is_err());
            assert!(RoomId::new(value).is_err());
        }
        let a = JoinId::new("a").unwrap();
        let b = JoinId::new("b").unwrap();
        assert_eq!(
            edge(),
            EdgeKey::new(RoomId::new("room").unwrap(), a.clone(), b.clone()).unwrap()
        );
        assert_eq!(edge().offerer(), &a);
        assert_eq!(edge().role(&a).unwrap(), EdgeRole::Offerer);
        assert_eq!(edge().role(&b).unwrap(), EdgeRole::Answerer);
        assert!(edge().role(&JoinId::new("c").unwrap()).is_err());
        assert!(EdgeKey::new(RoomId::new("room").unwrap(), a.clone(), a).is_err());
    }
    #[test]
    fn meeting_negotiation_binding_replay_expiry() {
        let mut n = EdgeNegotiator::new(edge(), &Route::Direct).unwrap();
        let expiry = Instant::now() + Duration::from_secs(30);
        assert!(matches!(
            n.begin(0, RouteKind::Relay, [0; 16], expiry),
            Err(Error::RelayNotConfigured)
        ));
        assert!(matches!(
            n.begin(0, RouteKind::Direct, [0; 16], Instant::now()),
            Err(Error::Expired)
        ));
        let a = n.begin(0, RouteKind::Direct, [1; 16], expiry).unwrap();
        assert!(n.begin(1, RouteKind::Direct, [2; 16], expiry).is_err());
        let offer = RTCSessionDescription::default();
        assert!(n.accept_answer(&a, offer_hash(&offer)).is_err());
        n.bind_offer(&a, &offer).unwrap();
        assert!(n.bind_offer(&a, &offer).is_err());
        for wrong in [
            Attempt {
                nonce: [2; 16],
                ..a.clone()
            },
            Attempt {
                attempt_no: 1,
                ..a.clone()
            },
            Attempt {
                edge: EdgeKey::new(
                    RoomId::new("other").unwrap(),
                    JoinId::new("a").unwrap(),
                    JoinId::new("b").unwrap(),
                )
                .unwrap(),
                ..a.clone()
            },
        ] {
            assert!(n.accept_answer(&wrong, offer_hash(&offer)).is_err());
        }
        assert!(matches!(
            n.accept_answer(&a, [0; 32]),
            Err(Error::OfferBinding)
        ));
        n.accept_answer(&a, offer_hash(&offer)).unwrap();
        assert!(n.accept_answer(&a, offer_hash(&offer)).is_err());
        assert!(n.mark_connected(ObservedRoute::Unknown).is_err());
        n.mark_connected(ObservedRoute::Direct).unwrap();
        let mut other = EdgeNegotiator::new(edge(), &Route::Direct).unwrap();
        other.begin(1, RouteKind::Direct, [0; 16], expiry).unwrap();
        other.fail();
        assert_eq!(n.state(), EdgeState::Connected(ObservedRoute::Direct));
        n.fail();
        assert!(n.begin(0, RouteKind::Direct, [0; 16], expiry).is_err());
        let current = n.begin(1, RouteKind::Direct, [0; 16], expiry).unwrap();
        assert!(n.accept_answer(&a, offer_hash(&offer)).is_err());
        n.active.as_mut().unwrap().expires_at = Instant::now();
        let expired = n.active.clone().unwrap();
        assert!(matches!(
            n.bind_offer(&expired, &offer),
            Err(Error::Expired)
        ));
        assert!(matches!(
            n.accept_answer(&expired, offer_hash(&offer)),
            Err(Error::Expired)
        ));
        assert!(n.accept_answer(&current, offer_hash(&offer)).is_err());
        n.fail();
        assert!(n.begin(1, RouteKind::Direct, [0; 16], expiry).is_err());
        let mut relay = EdgeNegotiator::new(
            edge(),
            &Route::RelayFallback {
                urls: vec!["turn:example.invalid".into()],
                username: "user".into(),
                credential: "private".into(),
            },
        )
        .unwrap();
        assert!(relay.begin(1, RouteKind::Relay, [0; 16], expiry).is_ok());
        let error = Error::Transport(crate::Error::WebRtc(webrtc::Error::new(
            "private SDP".into(),
        )));
        assert!(!format!("{error:?}").contains("private"));
    }
}
