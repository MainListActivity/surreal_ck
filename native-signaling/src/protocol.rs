use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fmt;

pub const MAX_SDP_BYTES: usize = 48 * 1024;
pub const INVITE_TTL_SECONDS: u64 = 120;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("身份或工作区已变化，请重新连接")]
    Identity,
    #[error("信令暂不可用或数据库拒绝操作")]
    Database,
    #[error("邀请已过期、已处理或不存在")]
    Expired,
    #[error("信令身份、会话或完整性不匹配")]
    Binding,
    #[error("SDP 格式或大小不符合限制")]
    Sdp,
    #[error("请稍后重试；信令请求过于频繁")]
    RateLimited,
    #[error("请先结束当前邀请或会话")]
    Busy,
    #[error("无法生成安全随机数")]
    Random,
}
impl From<surreal_ck_native_identity::IdentityError> for Error {
    fn from(_: surreal_ck_native_identity::IdentityError) -> Self {
        Self::Identity
    }
}

/// 仅供列表显示，不构成认证证明，也不能直接用于建立媒体。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvitationSummary {
    pub invitation_id: String,
    pub sender_member_id: String,
    pub expires_at: u64,
}

/// 仅由已认证数据库路径通过完整绑定校验后构造。不可反序列化、不可克隆。
/// 手工 JSON 不能伪造企业认证证明：
/// ```compile_fail
/// use surreal_ck_native_signaling::AuthenticatedOffer;
/// let fake: AuthenticatedOffer = serde_json::from_str("{}").unwrap();
/// ```
pub struct AuthenticatedOffer {
    pub(crate) binding: Binding,
    pub(crate) sdp: String,
}
/// 仅由已认证数据库路径通过完整绑定校验后构造。不可反序列化、不可克隆。
/// ```compile_fail
/// use surreal_ck_native_signaling::AuthenticatedAnswer;
/// let fake: AuthenticatedAnswer = serde_json::from_str("{}").unwrap();
/// ```
pub struct AuthenticatedAnswer {
    pub(crate) binding: Binding,
    pub(crate) sdp: String,
}
macro_rules! authenticated_description {
    ($ty:ty) => {
        impl $ty {
            pub fn workspace_database(&self) -> &str {
                &self.binding.database
            }
            pub fn invitation_id(&self) -> &str {
                &self.binding.id
            }
            pub fn sender_member_id(&self) -> &str {
                &self.binding.sender
            }
            pub fn recipient_member_id(&self) -> &str {
                &self.binding.recipient
            }
            /// 仅在所属 Signaling 的操作成功后交给 WebRTC；不要缓存或显示为手工码。
            pub fn sdp_json(&self) -> &str {
                &self.sdp
            }
        }
        impl fmt::Debug for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($ty), "([REDACTED])"))
            }
        }
    };
}
authenticated_description!(AuthenticatedOffer);
authenticated_description!(AuthenticatedAnswer);

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Binding {
    pub database: String,
    pub id: String,
    pub nonce: String,
    pub sender: String,
    pub recipient: String,
    pub offer_hash: String,
    pub generation: String,
    pub expires_at: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sdp {
    #[serde(rename = "type")]
    kind: String,
    sdp: String,
}
pub(crate) fn validate_sdp(raw: &str, kind: &str) -> Result<String> {
    if raw.len() > MAX_SDP_BYTES || !raw.is_ascii() {
        return Err(Error::Sdp);
    }
    let description: Sdp = serde_json::from_str(raw).map_err(|_| Error::Sdp)?;
    if description.kind != kind
        || !description.sdp.starts_with("v=0\r\n")
        || !description.sdp.contains("\r\na=fingerprint:sha-256 ")
        || !description.sdp.contains("\r\na=ice-ufrag:")
        || !description.sdp.contains("\r\na=ice-pwd:")
        || !description.sdp.contains("\r\nm=")
    {
        return Err(Error::Sdp);
    }
    Ok(hash(raw))
}
pub(crate) fn hash(raw: &str) -> String {
    Sha256::digest(raw.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(crate) fn random_id() -> Result<String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::Random)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[cfg(test)]
pub(crate) fn ensure_live(expires_at: u64, now: u64) -> Result<()> {
    if expires_at <= now || expires_at.saturating_sub(now) > INVITE_TTL_SECONDS {
        Err(Error::Expired)
    } else {
        Ok(())
    }
}
/// 比较全绑定而不是只比较用户 ID 或 SDP。generation 阻止旧连接事件覆盖新连接。
#[cfg(test)]
pub(crate) fn ensure_binding(actual: &Binding, expected: &Binding, now: u64) -> Result<()> {
    if actual != expected {
        return Err(Error::Binding);
    }
    ensure_live(actual.expires_at, now)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn fixture(kind: &str) -> String {
        serde_json::json!({"type":kind,"sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 00:11\r\na=ice-ufrag:test\r\na=ice-pwd:fixture-only-not-credential\r\n"}).to_string()
    }
    fn binding() -> Binding {
        Binding {
            database: "ws_a".into(),
            id: "a".repeat(64),
            nonce: "b".repeat(64),
            sender: "user:a".into(),
            recipient: "user:b".into(),
            offer_hash: hash(&fixture("offer")),
            generation: "c".repeat(64),
            expires_at: 200,
        }
    }
    #[test]
    fn rejects_cross_workspace_sender_recipient_nonce_hash_and_generation() {
        let original = binding();
        for n in 0..8 {
            let mut tampered = original.clone();
            match n {
                0 => tampered.database = "ws_other".into(),
                1 => tampered.sender = "user:mallory".into(),
                2 => tampered.recipient = "user:mallory".into(),
                3 => tampered.id = "d".repeat(64),
                4 => tampered.nonce = "e".repeat(64),
                5 => tampered.offer_hash = "f".repeat(64),
                6 => tampered.generation = "0".repeat(64),
                _ => tampered.expires_at += 1,
            }
            assert_eq!(
                ensure_binding(&tampered, &original, 100),
                Err(Error::Binding)
            );
        }
        assert_eq!(
            ensure_binding(&original, &original, 200),
            Err(Error::Expired)
        );
        assert!(ensure_binding(&original, &original, 100).is_ok());
    }
    #[test]
    fn rejects_wrong_sdp_type_oversize_and_no_fingerprint() {
        assert!(validate_sdp(&fixture("offer"), "offer").is_ok());
        assert_eq!(validate_sdp(&fixture("answer"), "offer"), Err(Error::Sdp));
        assert_eq!(
            validate_sdp(&"a".repeat(MAX_SDP_BYTES + 1), "offer"),
            Err(Error::Sdp)
        );
        assert_eq!(
            validate_sdp(
                &fixture("offer").replace("fingerprint", "untrusted"),
                "offer"
            ),
            Err(Error::Sdp)
        );
        assert_ne!(hash(&fixture("offer")), hash(&fixture("answer")));
    }
    #[test]
    fn secure_identifiers_and_ttl_bounds() {
        let a = random_id().unwrap();
        let b = random_id().unwrap();
        assert!(valid_id(&a));
        assert_ne!(a, b);
        assert!(!valid_id("user:a; DELETE user"));
        assert_eq!(ensure_live(221, 100), Err(Error::Expired));
        assert_eq!(ensure_live(99, 100), Err(Error::Expired));
    }
}
