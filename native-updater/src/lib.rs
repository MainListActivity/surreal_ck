//! 强制更新信任核心。默认拒绝；只有新鲜、有效签名策略允许当前版本才放行。
use ring::{digest, signature};
use semver::Version;
use serde::{Deserialize, Serialize};

/// 签发工具默认 7 天；30 天是协议硬上限，不是离线使用许可。
pub const MAX_POLICY_LIFETIME_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustConfig {
    pub public_key: [u8; 32],
    pub app_id: String,
    pub channel: String,
    pub download_hosts: Vec<String>,
}
#[derive(Debug, Clone)]
pub struct CheckContext {
    pub installed_version: String,
    pub platform: String,
    pub arch: String,
    pub now_unix: u64,
    pub highest_sequence: u64,
    /// 上次已接受策略的 SHA-256。序号相同却内容不同一律拒绝。
    pub previous_policy_hash: Option<String>,
    pub last_seen_unix: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub payload: String,
    pub signature_hex: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub schema: u32,
    pub app_id: String,
    pub channel: String,
    pub sequence: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub releases: Vec<Release>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Release {
    pub platform: String,
    pub arch: String,
    pub version: String,
    pub url: String,
    #[serde(default)]
    pub mirror_urls: Vec<String>,
    pub sha256: String,
    pub size: u64,
    /// OS 平台签名身份，不能代替平台原生验签。
    pub publisher: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
    NotConfigured,
    NetworkUnavailable,
    InvalidEnvelope,
    InvalidSignature,
    InvalidPolicy,
    WrongApplication,
    Expired,
    ClockRollback,
    PolicyRollback,
    UnsupportedTarget,
    InvalidVersion,
    Downgrade,
    UnsafeDownload,
    ArtifactMismatch,
    NativeInstallationRequired,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateStatus {
    Blocked(UpdateError),
    UpdateRequired(Release),
    Ready,
}
#[derive(Debug, Clone)]
pub struct Acceptance {
    pub sequence: u64,
    pub policy_hash: String,
    pub checked_at: u64,
}
#[derive(Debug, Clone)]
pub struct Gate {
    status: GateStatus,
    acceptance: Option<Acceptance>,
}
impl Default for Gate {
    fn default() -> Self {
        Self {
            status: GateStatus::Blocked(UpdateError::NotConfigured),
            acceptance: None,
        }
    }
}
impl Gate {
    pub fn can_enter(&self) -> bool {
        matches!(self.status, GateStatus::Ready)
    }
    pub fn status(&self) -> &GateStatus {
        &self.status
    }
    /// 必须持久化成功后才挂载业务界面；保存失败调用 block。
    pub fn acceptance(&self) -> Option<&Acceptance> {
        self.acceptance.as_ref()
    }
    pub fn block(&mut self, reason: UpdateError) {
        self.status = GateStatus::Blocked(reason);
        self.acceptance = None;
    }
    pub fn message(&self) -> &'static str {
        match &self.status {
            GateStatus::Ready => "版本验证通过",
            GateStatus::UpdateRequired(_) => "必须完成更新并重启后才能使用。系统可能要求确认安装。",
            GateStatus::Blocked(UpdateError::NotConfigured) => {
                "尚未配置可信更新服务，暂不能打开应用。"
            }
            GateStatus::Blocked(UpdateError::NetworkUnavailable) => {
                "无法验证最新版本，请连接网络后重试。应用保持锁定。"
            }
            GateStatus::Blocked(UpdateError::Expired) => "更新策略已过期，请连接网络获取最新策略。",
            GateStatus::Blocked(UpdateError::NativeInstallationRequired) => {
                "更新尚未完成平台签名验证及安装，请重试或联系管理员。"
            }
            GateStatus::Blocked(_) => "更新安全验证失败，已阻止进入。请重试或联系管理员。",
        }
    }
    pub fn check(
        &mut self,
        envelope: &[u8],
        config: &TrustConfig,
        context: &CheckContext,
    ) -> Result<(), UpdateError> {
        self.block(UpdateError::InvalidPolicy);
        match verify_policy(envelope, config, context) {
            Ok((release, acceptance)) => {
                let installed = Version::parse(&context.installed_version)
                    .map_err(|_| UpdateError::InvalidVersion)?;
                let required =
                    Version::parse(&release.version).map_err(|_| UpdateError::InvalidVersion)?;
                if installed > required {
                    self.block(UpdateError::Downgrade);
                    return Err(UpdateError::Downgrade);
                }
                self.status = if installed == required {
                    GateStatus::Ready
                } else {
                    GateStatus::UpdateRequired(release)
                };
                self.acceptance = Some(acceptance);
                Ok(())
            }
            Err(e) => {
                self.block(e.clone());
                Err(e)
            }
        }
    }
}
pub fn verify_policy(
    bytes: &[u8],
    config: &TrustConfig,
    context: &CheckContext,
) -> Result<(Release, Acceptance), UpdateError> {
    if config.public_key == [0; 32]
        || config.app_id.is_empty()
        || config.channel.is_empty()
        || config.download_hosts.is_empty()
    {
        return Err(UpdateError::NotConfigured);
    }
    if bytes.len() > 128 * 1024 {
        return Err(UpdateError::InvalidEnvelope);
    }
    let envelope: Envelope =
        serde_json::from_slice(bytes).map_err(|_| UpdateError::InvalidEnvelope)?;
    let sig = hex::decode(&envelope.signature_hex).map_err(|_| UpdateError::InvalidSignature)?;
    signature::UnparsedPublicKey::new(&signature::ED25519, config.public_key)
        .verify(envelope.payload.as_bytes(), &sig)
        .map_err(|_| UpdateError::InvalidSignature)?;
    let policy: Policy =
        serde_json::from_str(&envelope.payload).map_err(|_| UpdateError::InvalidPolicy)?;
    if policy.schema != 1
        || policy.sequence == 0
        || policy.expires_at <= policy.issued_at
        || policy.expires_at - policy.issued_at > MAX_POLICY_LIFETIME_SECS
    {
        return Err(UpdateError::InvalidPolicy);
    }
    if policy.app_id != config.app_id || policy.channel != config.channel {
        return Err(UpdateError::WrongApplication);
    }
    if context.now_unix < context.last_seen_unix || context.now_unix < policy.issued_at {
        return Err(UpdateError::ClockRollback);
    }
    if context.now_unix >= policy.expires_at {
        return Err(UpdateError::Expired);
    }
    let hash = hex::encode(digest::digest(&digest::SHA256, envelope.payload.as_bytes()));
    if policy.sequence < context.highest_sequence
        || (policy.sequence == context.highest_sequence
            && context.previous_policy_hash.as_ref() != Some(&hash))
    {
        return Err(UpdateError::PolicyRollback);
    }
    let matches: Vec<_> = policy
        .releases
        .iter()
        .filter(|r| r.platform == context.platform && r.arch == context.arch)
        .collect();
    if matches.len() != 1 {
        return Err(UpdateError::UnsupportedTarget);
    }
    let release = matches[0].clone();
    let version = Version::parse(&release.version).map_err(|_| UpdateError::InvalidVersion)?;
    let installed =
        Version::parse(&context.installed_version).map_err(|_| UpdateError::InvalidVersion)?;
    // 发布通道禁止 prerelease 与 build metadata，避免相同版本排序产生歧义。
    if !version.pre.is_empty()
        || !version.build.is_empty()
        || !installed.pre.is_empty()
        || !installed.build.is_empty()
    {
        return Err(UpdateError::InvalidVersion);
    }
    for candidate in std::iter::once(&release.url).chain(release.mirror_urls.iter()) {
        let url = url::Url::parse(candidate).map_err(|_| UpdateError::UnsafeDownload)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.port_or_known_default() != Some(443)
            || !config
                .download_hosts
                .iter()
                .any(|h| Some(h.as_str()) == url.host_str())
        {
            return Err(UpdateError::UnsafeDownload);
        }
    }
    if release.size == 0
        || release.size > 2 * 1024 * 1024 * 1024
        || release.publisher.trim().is_empty()
        || hex::decode(&release.sha256).map_or(true, |h| h.len() != 32)
    {
        return Err(UpdateError::InvalidPolicy);
    }
    Ok((
        release,
        Acceptance {
            sequence: policy.sequence,
            policy_hash: hash,
            checked_at: context.now_unix,
        },
    ))
}
/// 下载流须额外限制最大字节数，并拒绝跨域/降级重定向。
/// 返回成功仅表示内容与签名清单一致，并不表示系统代码签名或安装成功。
pub fn verify_artifact(release: &Release, bytes: &[u8]) -> Result<(), UpdateError> {
    if bytes.len() as u64 != release.size
        || hex::encode(digest::digest(&digest::SHA256, bytes)) != release.sha256.to_lowercase()
    {
        return Err(UpdateError::ArtifactMismatch);
    }
    Ok(())
}

/// 只能传入 verify_policy 返回的 Release；fetch 必须设超时、字节限制，
/// 禁止重定向（GitHub 官方 asset 跳转需由适配器验证可信主机）。
/// 主源下载/校验失败后按已签名镜像列表尝试；所有失败均保持门禁关闭。
pub fn download_verified<F>(release: &Release, mut fetch: F) -> Result<Vec<u8>, UpdateError>
where
    F: FnMut(&str, u64) -> Result<Vec<u8>, UpdateError>,
{
    let mut error = UpdateError::NetworkUnavailable;
    for url in std::iter::once(&release.url).chain(release.mirror_urls.iter()) {
        match fetch(url, release.size) {
            Ok(bytes) => match verify_artifact(release, &bytes) {
                Ok(()) => return Ok(bytes),
                Err(e) => error = e,
            },
            Err(e) => error = e,
        }
    }
    Err(error)
}

pub mod runtime;
