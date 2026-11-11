//! 当前连接的人工核对材料，不是成员认证、授权或密码协议。
//!
//! 只读取已生效的 Peer 描述及 DTLS 证书，不接受 UI 粘贴的 SDP。
//! 宿主必须串行处理协商与核对，并在每次协商、重连、关闭前递增 epoch、丢弃旧对象。
//! 本模块不会证明用户真的使用了可信渠道；确认方法只能由明确的用户操作调用。
use crate::Peer;
use sha2::{Digest, Sha256};
use std::{fmt, sync::Weak};
use webrtc::{
    dtls_transport::dtls_transport_state::RTCDtlsTransportState,
    peer_connection::{
        peer_connection_state::RTCPeerConnectionState,
        sdp::{sdp_type::RTCSdpType, session_description::RTCSessionDescription},
        signaling_state::RTCSignalingState,
        RTCPeerConnection,
    },
};

const MAX_SDP_BYTES: usize = 256 * 1024;
type Fingerprint = [u8; 32];
type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("连接尚未完成或正在重新协商，不能核对")]
    NotConnected,
    #[error("当前 SDP 类型、结构或媒体会话不匹配")]
    Description,
    #[error("DTLS 指纹缺失、重复、冲突或格式不受支持")]
    Fingerprint,
    #[error("实际 DTLS 证书与当前 SDP 不匹配")]
    Certificate,
    #[error("连接或协商已变化，请重新核对")]
    Stale,
    #[error("确认材料不匹配，不能标记已核对")]
    Comparison,
}

/// 只是本地人工确认记录，不能用来授予组织身份或业务权限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    AwaitingComparison,
    ComparedViaTrustedChannel,
    Invalidated,
}

/// 全长 SHA-256 材料。不得缩短为数字短码，也不得通过待核对连接自证。
#[derive(Clone, PartialEq, Eq)]
pub struct ComparisonMaterial {
    offer_fingerprint: Fingerprint,
    answer_fingerprint: Fingerprint,
    session_digest: Fingerprint,
}
impl ComparisonMaterial {
    pub fn offer_fingerprint(&self) -> String {
        grouped_hex(&self.offer_fingerprint)
    }
    pub fn answer_fingerprint(&self) -> String {
        grouped_hex(&self.answer_fingerprint)
    }
    pub fn session_digest(&self) -> String {
        grouped_hex(&self.session_digest)
    }
    /// 双方应按发起端/接收端顺序，通过已有可信渠道对照全部字符。
    pub fn comparison_text(&self) -> String {
        format!(
            "连接人工核对 v1\n发起端 SHA-256: {}\n接收端 SHA-256: {}\n会话 SHA-256: {}",
            self.offer_fingerprint(),
            self.answer_fingerprint(),
            self.session_digest(),
        )
    }
}
impl fmt::Debug for ComparisonMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ComparisonMaterial([仅供人工核对])")
    }
}

/// 不可反序列化的瞬态记录；即便状态已核对，也要通过 matches_current 检查。
pub struct ManualVerification {
    connection: Weak<RTCPeerConnection>,
    epoch: u64,
    material: ComparisonMaterial,
    status: Status,
}
impl ManualVerification {
    /// epoch 由宿主单调递增，禁止复用；必须与同一后台 actor 的当前连接代次一致。
    pub async fn capture(peer: &Peer, epoch: u64) -> Result<Self> {
        if epoch == 0 {
            return Err(Error::Stale);
        }
        let connection = peer.connection();
        let material = connected_material(&connection).await?;
        Ok(Self {
            connection: std::sync::Arc::downgrade(&connection),
            epoch,
            material,
            status: Status::AwaitingComparison,
        })
    }
    pub fn material(&self) -> &ComparisonMaterial {
        &self.material
    }
    /// 验证同一对象、同一代次、已生效的 SDP 和实际 DTLS 证书。
    /// 不是组织成员认证。此检查不代替宿主的协商串行化和 epoch 撤销。
    pub async fn matches_current(&self, peer: &Peer, epoch: u64) -> bool {
        if self.status == Status::Invalidated || self.epoch != epoch {
            return false;
        }
        let current = peer.connection();
        let Some(original) = self.connection.upgrade() else {
            return false;
        };
        std::sync::Arc::ptr_eq(&current, &original)
            && connected_material(&current)
                .await
                .is_ok_and(|material| material == self.material)
    }
    /// 任何检测到的不一致均永久清除该对象的确认；不可在恢复连接后自动复活。
    pub async fn status(&mut self, peer: &Peer, epoch: u64) -> Status {
        if !self.matches_current(peer, epoch).await {
            self.invalidate();
        }
        self.status
    }
    pub fn invalidate(&mut self) {
        self.status = Status::Invalidated;
    }
    /// 仅在用户通过既有可信渠道对照完整材料后调用。
    /// displayed 必须是用户当时看到的完整材料，不能临时替换成最新材料。
    /// 软件只能记录该人工断言，不能证明对照渠道或对方组织身份。
    pub async fn confirm_after_trusted_channel_comparison(
        &mut self,
        peer: &Peer,
        epoch: u64,
        displayed: &str,
    ) -> Result<()> {
        if !self.matches_current(peer, epoch).await {
            self.invalidate();
            return Err(Error::Stale);
        }
        if displayed != self.material.comparison_text() {
            self.invalidate();
            return Err(Error::Comparison);
        }
        self.status = Status::ComparedViaTrustedChannel;
        Ok(())
    }
}

fn connected(connection: &RTCPeerConnection) -> bool {
    connection.connection_state() == RTCPeerConnectionState::Connected
        && connection.signaling_state() == RTCSignalingState::Stable
        && connection.sctp().transport().state() == RTCDtlsTransportState::Connected
}
async fn descriptions(
    connection: &RTCPeerConnection,
) -> Result<(RTCSessionDescription, RTCSessionDescription)> {
    if !connected(connection)
        || connection.pending_local_description().await.is_some()
        || connection.pending_remote_description().await.is_some()
    {
        return Err(Error::NotConnected);
    }
    let local = connection
        .current_local_description()
        .await
        .ok_or(Error::Description)?;
    let remote = connection
        .current_remote_description()
        .await
        .ok_or(Error::Description)?;
    Ok((local, remote))
}
async fn connected_material(connection: &RTCPeerConnection) -> Result<ComparisonMaterial> {
    let (local, remote) = descriptions(connection).await?;
    let material = material_from_applied_pair(&local, &remote)?;
    let dtls = connection.sctp().transport();
    let parameters = dtls
        .get_local_parameters()
        .map_err(|_| Error::Certificate)?;
    if parameters.fingerprints.len() != 1 {
        return Err(Error::Certificate);
    }
    let local_fp = &parameters.fingerprints[0];
    let actual_local = parse_fingerprint(&format!("{} {}", local_fp.algorithm, local_fp.value))?;
    let actual_remote_certificate = dtls.get_remote_certificate().await;
    if actual_remote_certificate.is_empty() {
        return Err(Error::Certificate);
    }
    let actual_remote: Fingerprint = Sha256::digest(&actual_remote_certificate).into();
    let (expected_local, expected_remote) = if local.sdp_type == RTCSdpType::Offer {
        (material.offer_fingerprint, material.answer_fingerprint)
    } else {
        (material.answer_fingerprint, material.offer_fingerprint)
    };
    if actual_local != expected_local || actual_remote != expected_remote {
        return Err(Error::Certificate);
    }
    // 缩小异步读取窗口；宿主仍须在同一 actor 串行协商，并更新 epoch。
    let (after_local, after_remote) = descriptions(connection).await?;
    if local.sdp_type != after_local.sdp_type
        || remote.sdp_type != after_remote.sdp_type
        || local.sdp != after_local.sdp
        || remote.sdp != after_remote.sdp
    {
        return Err(Error::Stale);
    }
    Ok(material)
}

#[derive(Default)]
struct Attributes {
    fingerprint: Option<Fingerprint>,
    ufrag: Option<String>,
    password: Option<String>,
    setup: Option<String>,
}
struct Media {
    kind: String,
    protocol: String,
    mid: Option<String>,
    attributes: Attributes,
}
struct Parsed {
    fingerprint: Fingerprint,
    media: Vec<Media>,
    canonical: String,
}
fn set_once<T>(slot: &mut Option<T>, value: T, error: Error) -> Result<()> {
    if slot.is_some() {
        return Err(error);
    }
    *slot = Some(value);
    Ok(())
}
fn parse_fingerprint(value: &str) -> Result<Fingerprint> {
    let (algorithm, fingerprint) = value.split_once(' ').ok_or(Error::Fingerprint)?;
    if algorithm != "sha-256" || fingerprint.len() != 95 {
        return Err(Error::Fingerprint);
    }
    let octets: Vec<_> = fingerprint.split(':').collect();
    if octets.len() != 32 {
        return Err(Error::Fingerprint);
    }
    let mut bytes = [0; 32];
    for (byte, octet) in bytes.iter_mut().zip(octets) {
        if octet.len() != 2 || !octet.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Fingerprint);
        }
        *byte = u8::from_str_radix(octet, 16).map_err(|_| Error::Fingerprint)?;
    }
    Ok(bytes)
}
fn token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.bytes().all(|b| b.is_ascii_graphic())
}
fn parse_description(description: &RTCSessionDescription) -> Result<Parsed> {
    let raw = &description.sdp;
    if raw.is_empty() || raw.len() > MAX_SDP_BYTES || !raw.is_ascii() {
        return Err(Error::Description);
    }
    let canonical = raw.replace("\r\n", "\n");
    if !canonical.starts_with("v=0\n")
        || canonical
            .bytes()
            .any(|b| b != b'\n' && !(32..=126).contains(&b))
    {
        return Err(Error::Description);
    }
    let mut session = Attributes::default();
    let mut media: Vec<Media> = Vec::new();
    let mut origin = None;
    let mut name = None;
    let mut timing = None;
    let mut bundle = None;
    for (index, line) in canonical.lines().enumerate() {
        if line.len() < 2 || line.as_bytes()[1] != b'=' {
            return Err(Error::Description);
        }
        if line.starts_with("v=") {
            if index != 0 || line != "v=0" {
                return Err(Error::Description);
            }
        } else if let Some(value) = line.strip_prefix("o=") {
            let parts: Vec<_> = value.split(' ').collect();
            if !media.is_empty()
                || parts.len() != 6
                || !parts.iter().all(|value| token(value))
                || !parts[1].bytes().all(|b| b.is_ascii_digit())
                || !parts[2].bytes().all(|b| b.is_ascii_digit())
                || parts[1].parse::<u64>().is_err()
                || parts[2].parse::<u64>().is_err()
                || parts[3] != "IN"
                || !matches!(parts[4], "IP4" | "IP6")
            {
                return Err(Error::Description);
            }
            set_once(&mut origin, value, Error::Description)?;
        } else if let Some(value) = line.strip_prefix("s=") {
            if !media.is_empty() {
                return Err(Error::Description);
            }
            set_once(&mut name, value, Error::Description)?;
        } else if let Some(value) = line.strip_prefix("t=") {
            if !media.is_empty() || value != "0 0" {
                return Err(Error::Description);
            }
            set_once(&mut timing, value, Error::Description)?;
        } else if let Some(value) = line.strip_prefix("a=group:BUNDLE ") {
            if !media.is_empty() {
                return Err(Error::Description);
            }
            set_once(&mut bundle, value, Error::Description)?;
        } else if let Some(value) = line.strip_prefix("m=") {
            let parts: Vec<_> = value.split(' ').collect();
            if parts.len() < 4
                || parts.iter().any(|value| !token(value))
                || !matches!(parts[0], "application" | "audio" | "video")
                || !parts[1].parse::<u16>().is_ok_and(|port| port > 0)
                || !matches!(parts[2], "UDP/DTLS/SCTP" | "UDP/TLS/RTP/SAVPF")
                || (parts[0] == "application"
                    && (parts[2] != "UDP/DTLS/SCTP" || parts[3] != "webrtc-datachannel"))
                || (parts[0] != "application" && parts[2] != "UDP/TLS/RTP/SAVPF")
            {
                return Err(Error::Description);
            }
            media.push(Media {
                kind: parts[0].to_owned(),
                protocol: parts[2].to_owned(),
                mid: None,
                attributes: Attributes::default(),
            });
        } else if let Some(value) = line.strip_prefix("a=mid:") {
            if !token(value) {
                return Err(Error::Description);
            }
            let section = media.last_mut().ok_or(Error::Description)?;
            set_once(&mut section.mid, value.to_owned(), Error::Description)?;
        } else {
            let attributes = media
                .last_mut()
                .map(|section| &mut section.attributes)
                .unwrap_or(&mut session);
            if let Some(value) = line.strip_prefix("a=fingerprint:") {
                set_once(
                    &mut attributes.fingerprint,
                    parse_fingerprint(value)?,
                    Error::Fingerprint,
                )?;
            } else if line.starts_with("a=fingerprint") {
                return Err(Error::Fingerprint);
            } else if let Some(value) = line.strip_prefix("a=ice-ufrag:") {
                if !token(value) {
                    return Err(Error::Description);
                }
                set_once(&mut attributes.ufrag, value.to_owned(), Error::Description)?;
            } else if let Some(value) = line.strip_prefix("a=ice-pwd:") {
                if !token(value) {
                    return Err(Error::Description);
                }
                set_once(
                    &mut attributes.password,
                    value.to_owned(),
                    Error::Description,
                )?;
            } else if let Some(value) = line.strip_prefix("a=setup:") {
                set_once(&mut attributes.setup, value.to_owned(), Error::Description)?;
            }
        }
    }
    if origin.is_none() || name.is_none() || timing.is_none() || media.is_empty() {
        return Err(Error::Description);
    }
    let mut fingerprint = session.fingerprint;
    let mut mids = Vec::new();
    let mut bundle_transport = None;
    for section in &media {
        let mid = section.mid.as_deref().ok_or(Error::Description)?;
        if mids.contains(&mid) {
            return Err(Error::Description);
        }
        mids.push(mid);
        let fp = section
            .attributes
            .fingerprint
            .or(session.fingerprint)
            .ok_or(Error::Fingerprint)?;
        if fingerprint.is_some_and(|expected| expected != fp) {
            return Err(Error::Fingerprint);
        }
        fingerprint = Some(fp);
        let ufrag = section
            .attributes
            .ufrag
            .as_deref()
            .or(session.ufrag.as_deref())
            .ok_or(Error::Description)?;
        let password = section
            .attributes
            .password
            .as_deref()
            .or(session.password.as_deref())
            .ok_or(Error::Description)?;
        let setup = section
            .attributes
            .setup
            .as_deref()
            .or(session.setup.as_deref());
        let valid_setup = match description.sdp_type {
            RTCSdpType::Offer => setup == Some("actpass"),
            RTCSdpType::Answer => matches!(setup, Some("active" | "passive")),
            _ => false,
        };
        if !valid_setup {
            return Err(Error::Description);
        }
        let transport = (ufrag, password, setup);
        if bundle_transport.is_some_and(|previous| previous != transport) {
            return Err(Error::Description);
        }
        bundle_transport = Some(transport);
    }
    if bundle.map(|value| value.split(' ').collect::<Vec<_>>()) != Some(mids) {
        return Err(Error::Description);
    }
    Ok(Parsed {
        fingerprint: fingerprint.ok_or(Error::Fingerprint)?,
        media,
        canonical,
    })
}
fn material_from_applied_pair(
    local: &RTCSessionDescription,
    remote: &RTCSessionDescription,
) -> Result<ComparisonMaterial> {
    let (offer, answer) = match (local.sdp_type, remote.sdp_type) {
        (RTCSdpType::Offer, RTCSdpType::Answer) => (local, remote),
        (RTCSdpType::Answer, RTCSdpType::Offer) => (remote, local),
        _ => return Err(Error::Description),
    };
    let offer = parse_description(offer)?;
    let answer = parse_description(answer)?;
    if offer.media.len() != answer.media.len()
        || offer
            .media
            .iter()
            .zip(&answer.media)
            .any(|(a, b)| a.mid != b.mid || a.kind != b.kind || a.protocol != b.protocol)
    {
        return Err(Error::Description);
    }
    // 只是完整描述快照的标准 SHA-256 校验值，不是短认证串或新密钥协议。
    // 固定角色顺序和长度前缀避免拼接歧义；不输出 SDP/ICE 地址或密码。
    let mut hash = Sha256::new();
    hash.update(b"surreal-ck/manual-connection-comparison/v1\0");
    for sdp in [&offer.canonical, &answer.canonical] {
        hash.update((sdp.len() as u64).to_be_bytes());
        hash.update(sdp.as_bytes());
    }
    Ok(ComparisonMaterial {
        offer_fingerprint: offer.fingerprint,
        answer_fingerprint: answer.fingerprint,
        session_digest: hash.finalize().into(),
    })
}
fn grouped_hex(bytes: &Fingerprint) -> String {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| format!("{:02X}{:02X}", pair[0], pair[1]))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(kind: RTCSdpType, byte: u8) -> RTCSessionDescription {
        let fingerprint = std::iter::repeat_n(format!("{byte:02X}"), 32)
            .collect::<Vec<_>>()
            .join(":");
        let setup = if kind == RTCSdpType::Offer {
            "actpass"
        } else {
            "active"
        };
        let sdp = format!("v=0\r\no=- {byte} 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=fingerprint:sha-256 {fingerprint}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=ice-ufrag:fixture\r\na=ice-pwd:fixture-only-not-secret\r\na=setup:{setup}\r\na=sctp-port:5000\r\n");
        let mut result = RTCSessionDescription::offer(sdp).unwrap();
        result.sdp_type = kind;
        result
    }
    #[test]
    fn role_order_and_line_endings_are_stable() {
        let a = fixture(RTCSdpType::Offer, 0xAB);
        let mut b = fixture(RTCSdpType::Answer, 0xCD);
        let first = material_from_applied_pair(&a, &b).unwrap();
        assert_eq!(first, material_from_applied_pair(&b, &a).unwrap());
        b.sdp = b.sdp.replace("\r\n", "\n");
        assert_eq!(first, material_from_applied_pair(&a, &b).unwrap());
        assert_eq!(first.offer_fingerprint(), "ABAB ".repeat(16).trim_end());
        assert_eq!(first.session_digest().replace(' ', "").len(), 64);
    }
    #[test]
    fn fingerprints_require_exact_sha256_octets() {
        for invalid in ["sha-1 00:11", "sha-256 00:11", "sha-256", "SHA-256 00:11"] {
            assert_eq!(parse_fingerprint(invalid), Err(Error::Fingerprint));
        }
        let valid = std::iter::repeat_n("aB", 32).collect::<Vec<_>>().join(":");
        assert_eq!(
            parse_fingerprint(&format!("sha-256 {valid}")),
            Ok([0xAB; 32])
        );
        for bad in [
            valid.replace(':', ""),
            valid.replacen("aB", "GG", 1),
            format!(" {valid}"),
            format!("{valid} "),
        ] {
            assert_eq!(
                parse_fingerprint(&format!("sha-256 {bad}")),
                Err(Error::Fingerprint)
            );
        }
    }
    #[test]
    fn rejects_missing_duplicate_conflicting_and_ambiguous_fingerprints() {
        let valid = fixture(RTCSdpType::Offer, 0xAB);
        let fp_line = valid
            .sdp
            .lines()
            .find(|line| line.starts_with("a=fingerprint:"))
            .unwrap()
            .to_owned();
        for sdp in [
            valid.sdp.replace(&format!("{fp_line}\r\n"), ""),
            valid
                .sdp
                .replace(&fp_line, &format!("{fp_line}\r\n{fp_line}")),
            format!(
                "{}{fp_line}\r\n{}\r\n",
                valid.sdp,
                fp_line.replace("AB", "CD")
            ),
            format!("{}{}\r\n", valid.sdp, fp_line.replace("AB", "CD")),
            valid.sdp.replace("a=fingerprint:", "a=fingerprint "),
        ] {
            let mut candidate = valid.clone();
            candidate.sdp = sdp;
            assert!(matches!(
                parse_description(&candidate),
                Err(Error::Fingerprint)
            ));
        }
        let mut same_media_and_session = valid;
        same_media_and_session
            .sdp
            .push_str(&format!("{fp_line}\r\n"));
        assert!(parse_description(&same_media_and_session).is_ok());
    }
    #[test]
    fn rejects_wrong_type_media_pairing_and_session_structure() {
        let a = fixture(RTCSdpType::Offer, 1);
        let b = fixture(RTCSdpType::Answer, 2);
        assert_eq!(material_from_applied_pair(&a, &a), Err(Error::Description));
        for replacement in [
            RTCSdpType::Pranswer,
            RTCSdpType::Rollback,
            RTCSdpType::Unspecified,
        ] {
            let mut wrong = b.clone();
            wrong.sdp_type = replacement;
            assert_eq!(
                material_from_applied_pair(&a, &wrong),
                Err(Error::Description)
            );
        }
        for sdp in [
            b.sdp
                .replace("a=mid:0", "a=mid:1")
                .replace("BUNDLE 0", "BUNDLE 1"),
            b.sdp.replace("o=- 2 0", "o=- malformed 0"),
            b.sdp.replace("a=mid:0", "a=mid:0\r\na=mid:0"),
            b.sdp.replace("a=setup:active", "a=setup:actpass"),
            b.sdp.replace("m=application 9", "m=application 0"),
            b.sdp.replace("a=ice-ufrag:fixture\r\n", ""),
            b.sdp.replace("\r\n", "\r"),
            "x".repeat(MAX_SDP_BYTES + 1),
        ] {
            let mut wrong = b.clone();
            wrong.sdp = sdp;
            assert_eq!(
                material_from_applied_pair(&a, &wrong),
                Err(Error::Description)
            );
        }
    }
    #[test]
    fn changes_in_certificate_origin_ice_and_payload_invalidate_material() {
        let a = fixture(RTCSdpType::Offer, 1);
        let b = fixture(RTCSdpType::Answer, 2);
        let original = material_from_applied_pair(&a, &b).unwrap();
        for sdp in [
            b.sdp.replace("02:", "03:"),
            b.sdp.replace("o=- 2 0", "o=- 3 0"),
            b.sdp.replace("o=- 2 0", "o=- 2 1"),
            b.sdp
                .replace("a=ice-ufrag:fixture", "a=ice-ufrag:new-connection"),
            b.sdp.replace("a=sctp-port:5000", "a=sctp-port:5001"),
        ] {
            let mut changed = b.clone();
            changed.sdp = sdp;
            assert_ne!(original, material_from_applied_pair(&a, &changed).unwrap());
        }
    }
}
