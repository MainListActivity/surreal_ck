//! 单工作区、单邀请 actor。只有数据库已认证连接可进入；手工 SDP 不构成身份。
use crate::protocol::{self, AuthenticatedAnswer, AuthenticatedOffer, Binding, Error, Result};
use std::time::{Duration, Instant};
use surreal_ck_native_identity::{
    SignalBinding, SignalConnection, SignalRow, SignalStatus, SignalSummary,
};

struct Active {
    binding: SignalBinding,
    deadline: Instant,
    expires_unix: u64,
    offer: String,
    incoming: bool,
    answer_consumed: bool,
}
/// 交给后台 actor 独占；不实现 Clone/Debug，也不把数据库连接传给 UI。
pub struct Signaling {
    connection: SignalConnection,
    active: Option<Active>,
    last_poll: Option<Instant>,
}
impl Signaling {
    pub fn new(connection: SignalConnection) -> Self {
        Self {
            connection,
            active: None,
            last_poll: None,
        }
    }
    pub fn ensure_current(&self) -> Result<()> {
        self.connection.ensure_current()?;
        Ok(())
    }
    pub fn database(&self) -> &str {
        self.connection.database()
    }
    pub fn member_id(&self) -> &str {
        self.connection.member_id()
    }
    /// 已建立会话超过邀请TTL后仍必须验证双方成员资格；不把过期邀请当健康证明。
    pub async fn revalidate_peer(&mut self) -> Result<()> {
        let state = self.active.as_ref().ok_or(Error::Expired)?;
        let peer = if state.incoming {
            state.binding.sender.clone()
        } else {
            state.binding.recipient.clone()
        };
        self.connection.revalidate_peer(&peer).await?;
        Ok(())
    }
    pub async fn inbox(&mut self) -> Result<Vec<SignalSummary>> {
        self.poll_guard()?;
        Ok(self.connection.inbox().await?)
    }
    /// 只能传 WebRTC 本次生成的 offer；接收者由已认证成员目录显式选择。
    pub async fn invite(&mut self, recipient: &str, offer: &str) -> Result<String> {
        if self.active.is_some() {
            return Err(Error::Busy);
        }
        if recipient == self.member_id() {
            return Err(Error::Binding);
        }
        let hash = protocol::validate_sdp(offer, "offer")?;
        let id = protocol::random_id()?;
        let nonce = protocol::random_id()?;
        let generation = protocol::random_id()?;
        let started = Instant::now();
        let row = self
            .connection
            .invite(&id, &nonce, &generation, recipient, offer, &hash)
            .await?;
        self.validate_row(&row)?;
        if row.status != SignalStatus::Pending
            || row.binding.id != id
            || row.binding.nonce != nonce
            || row.binding.generation != generation
            || row.binding.recipient != recipient
            || row.binding.sender != self.member_id()
            || row.offer != offer
            || row.binding.offer_hash != hash
        {
            return Err(Error::Binding);
        }
        self.active = Some(active(row, false, started)?);
        Ok(id)
    }
    /// 仅在用户明确接受具体邀请后调用。列表摘要本身不是媒体认证证明。
    pub async fn accept(&mut self, id: &str) -> Result<AuthenticatedOffer> {
        if self.active.is_some() {
            return Err(Error::Busy);
        }
        if !protocol::valid_id(id) {
            return Err(Error::Binding);
        }
        let started = Instant::now();
        let row = self.connection.read(id).await?;
        self.validate_row(&row)?;
        if row.binding.id != id
            || row.binding.recipient != self.member_id()
            || row.status != SignalStatus::Pending
        {
            return Err(Error::Binding);
        }
        let accepted = self.connection.decide(&row.binding, true).await?;
        self.validate_row(&accepted)?;
        if accepted.binding != row.binding
            || accepted.offer != row.offer
            || accepted.status != SignalStatus::Accepted
        {
            return Err(Error::Binding);
        }
        let state = active(accepted, true, started)?;
        let result = AuthenticatedOffer {
            binding: proof(&state),
            sdp: state.offer.clone(),
        };
        self.active = Some(state);
        Ok(result)
    }
    pub async fn reject(&mut self, id: &str) -> Result<()> {
        if self.active.is_some() {
            return Err(Error::Busy);
        }
        let row = self.connection.read(id).await?;
        self.validate_row(&row)?;
        if row.binding.recipient != self.member_id() || row.status != SignalStatus::Pending {
            return Err(Error::Binding);
        }
        let rejected = self.connection.decide(&row.binding, false).await?;
        if rejected.binding != row.binding || rejected.status != SignalStatus::Rejected {
            return Err(Error::Binding);
        }
        Ok(())
    }
    pub async fn answer(&mut self, answer: &str) -> Result<()> {
        protocol::validate_sdp(answer, "answer")?;
        let state = self.live()?;
        if !state.incoming || state.answer_consumed {
            return Err(Error::Binding);
        }
        let binding = state.binding.clone();
        // 一次提交，即使响应丢失也不自动重发；用户须结束并新建邀请。
        self.active.as_mut().ok_or(Error::Expired)?.answer_consumed = true;
        let row = self.connection.answer(&binding, answer).await?;
        self.validate_row(&row)?;
        if row.binding != binding
            || row.status != SignalStatus::Answered
            || row.answer.as_deref() != Some(answer)
        {
            return Err(Error::Binding);
        }
        Ok(())
    }
    pub async fn poll_answer(&mut self) -> Result<Option<AuthenticatedAnswer>> {
        self.poll_guard()?;
        let state = self.live()?;
        if state.incoming || state.answer_consumed {
            return Err(Error::Binding);
        }
        let binding = state.binding.clone();
        let row = self.connection.read(&binding.id).await?;
        self.validate_row(&row)?;
        if row.binding != binding {
            return Err(Error::Binding);
        }
        match row.status {
            SignalStatus::Pending | SignalStatus::Accepted => Ok(None),
            SignalStatus::Answered => {
                let answer = row.answer.ok_or(Error::Binding)?;
                protocol::validate_sdp(&answer, "answer")?;
                let state = self.active.as_mut().ok_or(Error::Expired)?;
                if Instant::now() >= state.deadline {
                    return Err(Error::Expired);
                }
                state.answer_consumed = true;
                Ok(Some(AuthenticatedAnswer {
                    binding: proof(state),
                    sdp: answer,
                }))
            }
            _ => Err(Error::Expired),
        }
    }
    /// 先在本地停止媒体。数据库过期/离线可能拒绝 end，绝不能因此保留硬件采集。
    pub async fn end(&mut self) -> Result<()> {
        let state = self.active.take().ok_or(Error::Expired)?;
        let row = self.connection.end(&state.binding).await?;
        if row.binding != state.binding || row.status != SignalStatus::Ended {
            return Err(Error::Binding);
        }
        Ok(())
    }
    fn live(&self) -> Result<&Active> {
        self.active
            .as_ref()
            .filter(|s| Instant::now() < s.deadline)
            .ok_or(Error::Expired)
    }
    fn poll_guard(&mut self) -> Result<()> {
        let now = Instant::now();
        if self
            .last_poll
            .is_some_and(|t| now.duration_since(t) < Duration::from_secs(3))
        {
            return Err(Error::RateLimited);
        }
        self.last_poll = Some(now);
        Ok(())
    }
    fn validate_row(&self, row: &SignalRow) -> Result<()> {
        validate(row, self.database(), self.member_id())
    }
}
fn validate(row: &SignalRow, database: &str, member: &str) -> Result<()> {
    let b = &row.binding;
    if !b.sender.starts_with("user:")
        || !b.recipient.starts_with("user:")
        || b.sender.len() <= 5
        || b.recipient.len() <= 5
        || b.workspace != database
        || (b.sender != member && b.recipient != member)
        || b.sender == b.recipient
        || !protocol::valid_id(&b.id)
        || !protocol::valid_id(&b.nonce)
        || !protocol::valid_id(&b.generation)
        || protocol::validate_sdp(&row.offer, "offer")? != b.offer_hash
    {
        return Err(Error::Binding);
    }
    match row.status {
        SignalStatus::Pending | SignalStatus::Accepted | SignalStatus::Rejected
            if row.answer.is_some() =>
        {
            return Err(Error::Binding)
        }
        SignalStatus::Answered if row.answer.is_none() => return Err(Error::Binding),
        _ => {}
    }
    if let Some(answer) = &row.answer {
        protocol::validate_sdp(answer, "answer")?;
    }
    if row.expires_unix <= row.server_unix
        || row.expires_unix - row.server_unix > protocol::INVITE_TTL_SECONDS + 1
    {
        return Err(Error::Expired);
    }
    Ok(())
}
fn active(row: SignalRow, incoming: bool, started: Instant) -> Result<Active> {
    // 从请求开始计时并截去一秒，保守扣除网络耗时与秒取整；数据库仍是最终权威。
    let remaining = row
        .expires_unix
        .checked_sub(row.server_unix)
        .ok_or(Error::Expired)?
        .saturating_sub(1);
    let deadline = started + Duration::from_secs(remaining);
    if remaining == 0 || Instant::now() >= deadline {
        return Err(Error::Expired);
    }
    Ok(Active {
        binding: row.binding,
        deadline,
        expires_unix: row.expires_unix,
        offer: row.offer,
        incoming,
        answer_consumed: false,
    })
}
fn proof(state: &Active) -> Binding {
    let b = &state.binding;
    Binding {
        database: b.workspace.clone(),
        id: b.id.clone(),
        nonce: b.nonce.clone(),
        sender: b.sender.clone(),
        recipient: b.recipient.clone(),
        offer_hash: b.offer_hash.clone(),
        generation: b.generation.clone(),
        expires_at: state.expires_unix,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row() -> SignalRow {
        let offer = protocol::tests::fixture("offer");
        SignalRow {
            binding: SignalBinding {
                id: "a".repeat(64),
                workspace: "ws_a".into(),
                sender: "user:a".into(),
                recipient: "user:b".into(),
                nonce: "b".repeat(64),
                generation: "c".repeat(64),
                offer_hash: protocol::hash(&offer),
                expires_at: "2026-11-10T23:02:00Z".into(),
            },
            status: SignalStatus::Pending,
            offer,
            answer: None,
            created_at: "2026-11-10T23:00:00Z".into(),
            server_now: "2026-11-10T23:00:00Z".into(),
            expires_unix: 120,
            server_unix: 0,
        }
    }
    #[test]
    fn validated_row_rejects_cross_workspace_third_party_and_tamper() {
        let mut r = row();
        assert!(validate(&r, "ws_a", "user:a").is_ok());
        assert_eq!(validate(&r, "ws_b", "user:a"), Err(Error::Binding));
        assert_eq!(validate(&r, "ws_a", "user:c"), Err(Error::Binding));
        r.offer.push(' ');
        assert_eq!(validate(&r, "ws_a", "user:a"), Err(Error::Binding));
    }
    #[test]
    fn expiry_does_not_trust_local_wall_clock_or_delayed_response() {
        let mut r = row();
        r.server_unix = 120;
        assert_eq!(validate(&r, "ws_a", "user:a"), Err(Error::Expired));
        let started = Instant::now() - Duration::from_secs(125);
        assert!(matches!(active(row(), false, started), Err(Error::Expired)));
        let mut r = row();
        r.expires_unix = 122;
        assert_eq!(validate(&r, "ws_a", "user:a"), Err(Error::Expired));
    }
    #[test]
    fn authenticated_proof_keeps_complete_binding_and_redacts_sdp() {
        let state = active(row(), true, Instant::now()).unwrap();
        let p = AuthenticatedOffer {
            binding: proof(&state),
            sdp: state.offer.clone(),
        };
        assert_eq!(p.workspace_database(), "ws_a");
        assert_eq!(p.sender_member_id(), "user:a");
        assert_eq!(p.recipient_member_id(), "user:b");
        assert_eq!(p.invitation_id(), "a".repeat(64));
        assert!(!format!("{p:?}").contains("fingerprint"));
    }
}
