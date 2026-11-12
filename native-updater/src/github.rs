//! Manual GitHub Releases checks for the separately configured preview channel.
//!
//! Trust model (unchanged by the download source):
//! - Version, asset identity and SHA-256 always come directly from the GitHub API over TLS.
//! - The optional third-party proxy only carries asset bytes; they must match GitHub's
//!   size and SHA-256 before anything is written. A proxy never supplies versions or hashes.
//! - Preview builds only download; installing is a manual user step. A verified download is
//!   never reported as an upgrade. Official auto-update stays on the signed native installer path.
use crate::runtime::{self, FetchError};
use ring::digest;
use serde::Deserialize;
use std::{
    fmt,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

const API: &str = "https://api.github.com/repos/MainListActivity/surreal_ck/releases?per_page=30";
const PREFIX: &str = "https://github.com/MainListActivity/surreal_ck/releases/download/";
const MIRROR: &str = "https://ghfast.top/";
pub const ASSET: &str = "Jiji-macos-arm64.dmg";
const MAX_SIZE: u64 = 512 * 1024 * 1024;

/// 下载来源（单选）。元数据始终来自 GitHub API。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Github,
    Proxy,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Github => "GitHub",
            Source::Proxy => "第三方代理",
        }
    }
    fn host(self) -> &'static str {
        match self {
            Source::Github => "github.com",
            Source::Proxy => "ghfast.top",
        }
    }
}

/// 可区分、可读的更新失败原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateCheckError {
    ApiStatus(u16),
    RateLimited(u16),
    Timeout(&'static str),
    Tls(&'static str),
    Connect(&'static str, String),
    UnsafeUrl,
    MetadataInvalid,
    NoReleases,
    NoCompatibleAsset(String),
    DigestMissing,
    DigestInvalid,
    AssetInvalid,
    VersionInvalid,
    DownloadFailed(Source, String),
    SizeMismatch,
    HashMismatch,
    DestinationExists(PathBuf),
    NoDownloadDir,
    SaveFailed(String),
}

impl fmt::Display for UpdateCheckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use UpdateCheckError::*;
        match self {
            ApiStatus(code) => write!(f, "GitHub API 返回 HTTP {code}，未能读取发布信息。"),
            RateLimited(code) => write!(
                f,
                "GitHub API 拒绝访问（HTTP {code}，触发速率限制），请稍后再检查。"
            ),
            Timeout(host) => write!(f, "连接 {host} 超时（60 秒无响应）。"),
            Tls(host) => write!(
                f,
                "与 {host} 的 TLS 安全连接失败（证书或握手错误），已停止，不会降级为不安全连接。"
            ),
            Connect(host, detail) => write!(f, "无法连接 {host}：{detail}。"),
            UnsafeUrl => write!(f, "地址不是允许的官方 HTTPS 主机，已拒绝。"),
            MetadataInvalid => write!(f, "GitHub 返回的发布信息格式无效。"),
            NoReleases => write!(f, "GitHub 上尚无已发布的正式版本。"),
            NoCompatibleAsset(version) => write!(
                f,
                "远端版本 {version} 没有兼容的 Apple 芯片安装包（{ASSET}）。"
            ),
            DigestMissing => write!(f, "GitHub 未提供安装包 SHA-256 摘要，不能安全下载。"),
            DigestInvalid => write!(f, "安装包 SHA-256 摘要格式无效，不能安全下载。"),
            AssetInvalid => write!(f, "安装包不是官方 GitHub Release 资产或大小无效，已拒绝。"),
            VersionInvalid => write!(f, "发布版本号无效。"),
            DownloadFailed(source, detail) => write!(
                f,
                "通过{}下载安装包失败：{detail}。可切换下载来源后重试。",
                source.label()
            ),
            SizeMismatch => write!(f, "下载大小与 GitHub 官方记录不一致，文件未保存。"),
            HashMismatch => write!(
                f,
                "下载内容的 SHA-256 与 GitHub 官方摘要不一致，文件未保存。"
            ),
            DestinationExists(path) => write!(
                f,
                "目标文件已存在且内容不同：{}。未覆盖，请移走或删除后重试。",
                path.display()
            ),
            NoDownloadDir => write!(f, "找不到下载目录。"),
            SaveFailed(detail) => write!(f, "保存下载文件失败：{detail}。"),
        }
    }
}

impl std::error::Error for UpdateCheckError {}

fn from_fetch(error: FetchError, host: &'static str) -> UpdateCheckError {
    match error {
        FetchError::Timeout => UpdateCheckError::Timeout(host),
        FetchError::Tls(_) => UpdateCheckError::Tls(host),
        FetchError::Connect(detail) => UpdateCheckError::Connect(host, detail),
        FetchError::UnsafeUrl => UpdateCheckError::UnsafeUrl,
        FetchError::Status {
            code,
            rate_limited: true,
        } => UpdateCheckError::RateLimited(code),
        FetchError::Status { code, .. } => UpdateCheckError::ApiStatus(code),
        FetchError::TooLarge => UpdateCheckError::MetadataInvalid,
        other => UpdateCheckError::Connect(host, other.to_string()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubAsset {
    pub version: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub prerelease: bool,
}
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

fn release_version(tag: &str) -> Result<semver::Version, UpdateCheckError> {
    if tag.is_empty()
        || !tag
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
    {
        return Err(UpdateCheckError::VersionInvalid);
    }
    let version = tag
        .strip_prefix('v')
        .ok_or(UpdateCheckError::VersionInvalid)?;
    let parsed = semver::Version::parse(version).map_err(|_| UpdateCheckError::VersionInvalid)?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        return Err(UpdateCheckError::VersionInvalid);
    }
    Ok(parsed)
}

pub fn parse_release(bytes: &[u8]) -> Result<GithubAsset, UpdateCheckError> {
    let release: GithubRelease =
        serde_json::from_slice(bytes).map_err(|_| UpdateCheckError::MetadataInvalid)?;
    if release.draft {
        return Err(UpdateCheckError::VersionInvalid);
    }
    let version = release_version(&release.tag_name)?.to_string();
    let mut assets = release.assets.into_iter().filter(|a| a.name == ASSET);
    let asset = assets
        .next()
        .ok_or_else(|| UpdateCheckError::NoCompatibleAsset(version.clone()))?;
    if assets.next().is_some() || asset.size == 0 || asset.size > MAX_SIZE {
        return Err(UpdateCheckError::AssetInvalid);
    }
    let digest = asset
        .digest
        .as_deref()
        .ok_or(UpdateCheckError::DigestMissing)?;
    let sha = digest
        .strip_prefix("sha256:")
        .ok_or(UpdateCheckError::DigestInvalid)?;
    if sha.len() != 64 || hex::decode(sha).map_or(true, |v| v.len() != 32) {
        return Err(UpdateCheckError::DigestInvalid);
    }
    let expected = format!("{PREFIX}{}/{ASSET}", release.tag_name);
    if asset.browser_download_url != expected {
        return Err(UpdateCheckError::AssetInvalid);
    }
    Ok(GithubAsset {
        version,
        url: expected,
        size: asset.size,
        sha256: sha.to_ascii_lowercase(),
        prerelease: release.prerelease,
    })
}

/// 从 GitHub releases 列表选最高的有效版本；没有有效版本时报告最新一条发布的具体原因。
pub fn select_latest(bytes: &[u8]) -> Result<GithubAsset, UpdateCheckError> {
    let releases: Vec<serde_json::Value> =
        serde_json::from_slice(bytes).map_err(|_| UpdateCheckError::MetadataInvalid)?;
    let mut best: Option<(semver::Version, GithubAsset)> = None;
    let mut newest_error: Option<(Option<semver::Version>, UpdateCheckError)> = None;
    for release in releases {
        if release.get("draft").and_then(|d| d.as_bool()) == Some(true) {
            continue;
        }
        let bytes = serde_json::to_vec(&release).map_err(|_| UpdateCheckError::MetadataInvalid)?;
        let tag_version = release
            .get("tag_name")
            .and_then(|t| t.as_str())
            .and_then(|t| release_version(t).ok());
        match parse_release(&bytes) {
            Ok(asset) => {
                let version = semver::Version::parse(&asset.version)
                    .map_err(|_| UpdateCheckError::VersionInvalid)?;
                if best.as_ref().is_none_or(|(v, _)| version > *v) {
                    best = Some((version, asset));
                }
            }
            Err(error) => {
                if newest_error
                    .as_ref()
                    .is_none_or(|(v, _)| tag_version > *v)
                {
                    newest_error = Some((tag_version, error));
                }
            }
        }
    }
    match (best, newest_error) {
        (Some((_, asset)), _) => Ok(asset),
        (None, Some((_, error))) => Err(error),
        (None, None) => Err(UpdateCheckError::NoReleases),
    }
}

pub fn latest() -> Result<GithubAsset, UpdateCheckError> {
    latest_with(|url| {
        let hosts = vec!["api.github.com".to_owned()];
        runtime::fetch_https_detailed(
            url,
            1024 * 1024,
            &hosts,
            &[
                ("Accept", "application/vnd.github+json"),
                ("X-GitHub-Api-Version", "2022-11-28"),
            ],
        )
    })
}

pub fn latest_with(
    fetch: impl FnOnce(&str) -> Result<Vec<u8>, FetchError>,
) -> Result<GithubAsset, UpdateCheckError> {
    let bytes = fetch(API).map_err(|e| from_fetch(e, "api.github.com"))?;
    select_latest(&bytes)
}

pub fn newer(asset: &GithubAsset, current: &str) -> Result<bool, UpdateCheckError> {
    let next =
        semver::Version::parse(&asset.version).map_err(|_| UpdateCheckError::VersionInvalid)?;
    let installed =
        semver::Version::parse(current).map_err(|_| UpdateCheckError::VersionInvalid)?;
    Ok(next > installed)
}

/// 一次“检查更新”的完整结果：本地版本、远端版本与是否可下载。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckReport {
    pub local: String,
    pub remote: String,
    pub available: Option<GithubAsset>,
}

impl CheckReport {
    pub fn summary(&self) -> String {
        match &self.available {
            Some(asset) => format!(
                "发现新版本 {}{}，可下载并校验。",
                asset.version,
                if asset.prerelease {
                    "（预发布）"
                } else {
                    ""
                }
            ),
            None => format!(
                "当前已是最新版本（本地 {}，远端 {}）。",
                self.local, self.remote
            ),
        }
    }
}

pub fn check(current: &str) -> Result<CheckReport, UpdateCheckError> {
    check_with(current, latest())
}

pub fn check_with(
    current: &str,
    latest: Result<GithubAsset, UpdateCheckError>,
) -> Result<CheckReport, UpdateCheckError> {
    let asset = latest?;
    let is_newer = newer(&asset, current)?;
    Ok(CheckReport {
        local: current.to_owned(),
        remote: asset.version.clone(),
        available: is_newer.then_some(asset),
    })
}

/// 下载结果：预览渠道只下载，不安装，也不宣称已升级。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Downloaded {
    pub path: PathBuf,
    pub version: String,
    /// 目标位置已有同一 SHA-256 的文件，直接复用而非覆盖。
    pub reused: bool,
}

impl Downloaded {
    pub fn manual_install_notice(&self) -> String {
        format!(
            "{}：{}（SHA-256 已校验）。预览版不会自动安装或升级：请手动打开 DMG，将「吉吉」拖入“应用程序”替换旧版，重新启动后在设置中确认版本为 {}。",
            if self.reused { "已存在相同的已校验安装包" } else { "下载完成" },
            self.path.display(),
            self.version
        )
    }
}

pub fn download(
    asset: &GithubAsset,
    source: Source,
    directory: &Path,
) -> Result<Downloaded, UpdateCheckError> {
    download_with(asset, source, directory, |url, size| {
        let hosts = [
            "github.com",
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
            "ghfast.top",
        ]
        .map(str::to_owned)
        .to_vec();
        runtime::fetch_https_detailed(url, size, &hosts, &[])
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(digest::digest(&digest::SHA256, bytes))
}

pub fn download_with(
    asset: &GithubAsset,
    source: Source,
    directory: &Path,
    fetch: impl FnOnce(&str, u64) -> Result<Vec<u8>, FetchError>,
) -> Result<Downloaded, UpdateCheckError> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(UpdateCheckError::NoDownloadDir);
    }
    // Revalidate even if a caller constructs an asset directly.
    let fake = serde_json::json!({"tag_name":format!("v{}", asset.version),"draft":false,"prerelease":asset.prerelease,"assets":[{"name":ASSET,"browser_download_url":asset.url,"size":asset.size,"digest":format!("sha256:{}",asset.sha256)}]});
    let verified =
        parse_release(&serde_json::to_vec(&fake).map_err(|_| UpdateCheckError::AssetInvalid)?)?;
    if &verified != asset {
        return Err(UpdateCheckError::AssetInvalid);
    }
    let path = directory.join(format!("Jiji-{}.dmg", asset.version));
    // 已有文件：同 hash 则复用；不同内容不覆盖，给出明确错误（在联网前判断，避免白下载）。
    if let Ok(existing) = std::fs::symlink_metadata(&path) {
        if existing.is_file()
            && existing.len() == asset.size
            && std::fs::read(&path)
                .map(|b| sha256_hex(&b) == asset.sha256)
                .unwrap_or(false)
        {
            return Ok(Downloaded {
                path,
                version: asset.version.clone(),
                reused: true,
            });
        }
        return Err(UpdateCheckError::DestinationExists(path));
    }
    let url = match source {
        Source::Github => asset.url.clone(),
        Source::Proxy => format!("{MIRROR}{}", asset.url),
    };
    let bytes = fetch(&url, asset.size).map_err(|e| {
        UpdateCheckError::DownloadFailed(source, from_fetch(e, source.host()).to_string())
    })?;
    if bytes.len() as u64 != asset.size {
        return Err(UpdateCheckError::SizeMismatch);
    }
    if sha256_hex(&bytes) != asset.sha256 {
        return Err(UpdateCheckError::HashMismatch);
    }
    // 先写入唯一临时文件，再以 hard link 原子发布：目标若在此期间出现也绝不覆盖。
    let temp = directory.join(format!(
        ".Jiji-{}.dmg.part-{}",
        asset.version,
        std::process::id()
    ));
    let _ = std::fs::remove_file(&temp);
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .and_then(|mut file| file.write_all(&bytes).and_then(|_| file.sync_all()));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(UpdateCheckError::SaveFailed(error.to_string()));
    }
    let linked = std::fs::hard_link(&temp, &path);
    let _ = std::fs::remove_file(&temp);
    match linked {
        Ok(()) => Ok(Downloaded {
            path,
            version: asset.version.clone(),
            reused: false,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(UpdateCheckError::DestinationExists(path))
        }
        Err(error) => Err(UpdateCheckError::SaveFailed(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str, url: &str, hash: Option<&str>, name: &str) -> serde_json::Value {
        serde_json::json!({"tag_name": tag, "draft": false, "prerelease": false,
            "assets": [{"name": name, "browser_download_url": url, "size": 4, "digest": hash}]})
    }
    fn record(tag: &str, url: &str, hash: &str) -> Vec<u8> {
        serde_json::to_vec(&release(tag, url, Some(hash), ASSET)).unwrap()
    }
    fn temp_dir(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("jiji-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    fn fixture_asset(data: &[u8]) -> GithubAsset {
        // 受控候选版本，仅用于测试 newer/下载路径；不是已发布承诺。
        GithubAsset {
            version: "0.1.1".into(),
            url: format!("{PREFIX}v0.1.1/{ASSET}"),
            size: data.len() as u64,
            sha256: sha256_hex(data),
            prerelease: true,
        }
    }

    #[test]
    fn accepts_only_official_versioned_asset_with_digest() {
        let sha = format!("sha256:{}", "ab".repeat(32));
        let url = format!("{PREFIX}v1.2.3/{ASSET}");
        let asset = parse_release(&record("v1.2.3", &url, &sha)).unwrap();
        assert_eq!(asset.version, "1.2.3");
        assert!(newer(&asset, "1.0.0").unwrap());
        assert!(!newer(&asset, "1.2.3").unwrap());
        assert_eq!(
            parse_release(&record("v1.2.3", "https://evil.example/file", &sha)),
            Err(UpdateCheckError::AssetInvalid)
        );
        assert_eq!(
            parse_release(&record("v1.2.3", &url, "sha256:bad")),
            Err(UpdateCheckError::DigestInvalid)
        );
        assert_eq!(
            parse_release(&record("v1.2.3", &url, &format!("md5:{}", "ab".repeat(16)))),
            Err(UpdateCheckError::DigestInvalid)
        );
        assert_eq!(
            parse_release(&serde_json::to_vec(&release("v1.2.3", &url, None, ASSET)).unwrap()),
            Err(UpdateCheckError::DigestMissing)
        );
        assert_eq!(
            parse_release(&record("v1.2.3/other", &url, &sha)),
            Err(UpdateCheckError::VersionInvalid)
        );
    }

    #[test]
    fn release_without_compatible_asset_is_reported_specifically() {
        let sha = format!("sha256:{}", "ab".repeat(32));
        let body = serde_json::to_vec(&vec![release(
            "v0.1.0",
            &format!("{PREFIX}v0.1.0/Jiji-windows.exe"),
            Some(&sha),
            "Jiji-windows.exe",
        )])
        .unwrap();
        let error = select_latest(&body).unwrap_err();
        assert_eq!(error, UpdateCheckError::NoCompatibleAsset("0.1.0".into()));
        assert!(error.to_string().contains(ASSET));
        assert_eq!(select_latest(b"[]"), Err(UpdateCheckError::NoReleases));
        assert_eq!(select_latest(b"{}"), Err(UpdateCheckError::MetadataInvalid));
    }

    #[test]
    fn select_latest_picks_highest_valid_release() {
        let sha = format!("sha256:{}", "ab".repeat(32));
        let body = serde_json::to_vec(&vec![
            release(
                "v0.1.0",
                &format!("{PREFIX}v0.1.0/{ASSET}"),
                Some(&sha),
                ASSET,
            ),
            release(
                "v0.1.1",
                &format!("{PREFIX}v0.1.1/{ASSET}"),
                Some(&sha),
                ASSET,
            ),
            release(
                "v0.2.0",
                &format!("{PREFIX}v0.2.0/{ASSET}"),
                Some("sha256:zz"),
                ASSET,
            ),
        ])
        .unwrap();
        assert_eq!(select_latest(&body).unwrap().version, "0.1.1");
    }

    #[test]
    fn api_failures_map_to_distinct_readable_errors() {
        let cases = [
            (
                FetchError::Status {
                    code: 500,
                    rate_limited: false,
                },
                UpdateCheckError::ApiStatus(500),
            ),
            (
                FetchError::Status {
                    code: 404,
                    rate_limited: false,
                },
                UpdateCheckError::ApiStatus(404),
            ),
            (
                FetchError::Status {
                    code: 403,
                    rate_limited: true,
                },
                UpdateCheckError::RateLimited(403),
            ),
            (
                FetchError::Status {
                    code: 429,
                    rate_limited: true,
                },
                UpdateCheckError::RateLimited(429),
            ),
            (
                FetchError::Timeout,
                UpdateCheckError::Timeout("api.github.com"),
            ),
            (
                FetchError::Tls("bad cert".into()),
                UpdateCheckError::Tls("api.github.com"),
            ),
            (
                FetchError::Connect("DNS 解析失败".into()),
                UpdateCheckError::Connect("api.github.com", "DNS 解析失败".into()),
            ),
        ];
        let mut messages = std::collections::HashSet::new();
        for (fetch_error, expected) in cases {
            let error = latest_with(|url| {
                assert_eq!(url, API, "元数据只来自 GitHub API");
                Err(fetch_error)
            })
            .unwrap_err();
            assert_eq!(error, expected);
            let message = error.to_string();
            assert!(!message.contains("无法连接 GitHub 或尚无正式 Release"));
            assert!(messages.insert(message), "每种失败的提示必须可区分");
        }
        assert!(UpdateCheckError::RateLimited(403)
            .to_string()
            .contains("速率限制"));
        assert!(UpdateCheckError::Tls("api.github.com")
            .to_string()
            .contains("TLS"));
        assert!(UpdateCheckError::Timeout("api.github.com")
            .to_string()
            .contains("超时"));
    }

    #[test]
    fn transport_errors_are_classified_without_relaxing_tls() {
        use std::io::{Error, ErrorKind};
        let io =
            |kind, msg: &str| runtime::classify(&ureq::Error::Io(Error::new(kind, msg.to_owned())));
        assert_eq!(io(ErrorKind::TimedOut, "slow"), FetchError::Timeout);
        assert!(matches!(
            io(
                ErrorKind::InvalidData,
                "invalid peer certificate: UnknownIssuer"
            ),
            FetchError::Tls(_)
        ));
        assert!(matches!(
            io(ErrorKind::ConnectionRefused, "refused"),
            FetchError::Connect(_)
        ));
        assert_eq!(
            runtime::classify(&ureq::Error::HostNotFound),
            FetchError::Connect("DNS 解析失败".into())
        );
        assert_eq!(
            runtime::classify(&ureq::Error::StatusCode(503)),
            FetchError::Status {
                code: 503,
                rate_limited: false
            }
        );
        assert!(matches!(
            runtime::classify(&ureq::Error::Tls("handshake")),
            FetchError::Tls(_)
        ));
        // 非白名单或非 https 地址在联网前即被拒绝。
        let hosts = vec!["api.github.com".to_owned()];
        assert_eq!(
            runtime::fetch_https_detailed("http://api.github.com/x", 10, &hosts, &[]),
            Err(FetchError::UnsafeUrl)
        );
        assert_eq!(
            runtime::fetch_https_detailed("https://mirror.example/x", 10, &hosts, &[]),
            Err(FetchError::UnsafeUrl)
        );
    }

    #[test]
    fn rate_limit_detection_uses_github_headers() {
        assert!(runtime::is_rate_limited(429, None, false));
        assert!(runtime::is_rate_limited(403, Some("0"), false));
        assert!(runtime::is_rate_limited(403, None, true));
        assert!(!runtime::is_rate_limited(403, Some("12"), false));
        assert!(!runtime::is_rate_limited(500, Some("0"), false));
    }

    #[test]
    fn check_reports_local_and_remote_versions() {
        let data = b"dmg!";
        let report = check_with("0.1.0", Ok(fixture_asset(data))).unwrap();
        assert_eq!(
            (report.local.as_str(), report.remote.as_str()),
            ("0.1.0", "0.1.1")
        );
        assert!(
            report.available.is_some(),
            "受控候选 0.1.1 > 0.1.0 时可下载"
        );
        assert!(report.summary().contains("发现新版本 0.1.1"));
        let same = check_with("0.1.1", Ok(fixture_asset(data))).unwrap();
        assert!(same.available.is_none());
        assert_eq!(
            same.summary(),
            "当前已是最新版本（本地 0.1.1，远端 0.1.1）。"
        );
        assert_eq!(
            check_with("0.1.0", Err(UpdateCheckError::ApiStatus(502))),
            Err(UpdateCheckError::ApiStatus(502))
        );
    }

    #[test]
    fn proxy_download_verifies_bytes_and_never_overwrites() {
        let root = temp_dir("proxy");
        let data = b"test";
        let asset = fixture_asset(data);
        assert_eq!(
            download_with(&asset, Source::Proxy, &root, |url, _| {
                assert!(url.starts_with(MIRROR));
                Ok(b"evil".to_vec())
            }),
            Err(UpdateCheckError::HashMismatch)
        );
        assert_eq!(
            download_with(&asset, Source::Proxy, &root, |_, _| Ok(b"short!".to_vec())),
            Err(UpdateCheckError::SizeMismatch)
        );
        assert!(!root.join("Jiji-0.1.1.dmg").exists());
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            0,
            "失败不留临时文件"
        );
        let done = download_with(&asset, Source::Proxy, &root, |url, _| {
            assert_eq!(url, format!("{MIRROR}{}", asset.url));
            Ok(data.to_vec())
        })
        .unwrap();
        assert!(!done.reused);
        assert_eq!(std::fs::read(&done.path).unwrap(), data);
        let notice = done.manual_install_notice();
        assert!(notice.contains("预览版不会自动安装或升级"));
        assert!(!notice.contains("升级成功") && !notice.contains("已更新到"));
        // 同名同 hash：不再联网，直接复用。
        let again = download_with(&asset, Source::Github, &root, |_, _| {
            panic!("已有同 hash 文件时不应重新下载")
        })
        .unwrap();
        assert!(again.reused);
        // 同名不同内容：不覆盖，明确报错。
        std::fs::write(&done.path, b"diff").unwrap();
        assert_eq!(
            download_with(&asset, Source::Github, &root, |_, _| Ok(data.to_vec())),
            Err(UpdateCheckError::DestinationExists(done.path.clone()))
        );
        assert_eq!(std::fs::read(&done.path).unwrap(), b"diff");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn download_transport_failures_name_the_source_and_reason() {
        let root = temp_dir("transport");
        let asset = fixture_asset(b"test");
        for (source, error, needle) in [
            (Source::Github, FetchError::Timeout, "超时"),
            (Source::Proxy, FetchError::Tls("x".into()), "TLS"),
            (
                Source::Github,
                FetchError::Status {
                    code: 404,
                    rate_limited: false,
                },
                "HTTP 404",
            ),
        ] {
            let result = download_with(&asset, source, &root, |_, _| Err(error.clone()));
            let Err(UpdateCheckError::DownloadFailed(got, _)) = &result else {
                panic!("unexpected {result:?}")
            };
            assert_eq!(*got, source);
            let message = result.unwrap_err().to_string();
            assert!(
                message.contains(source.label()) && message.contains(needle),
                "{message}"
            );
        }
        assert!(!root.join("Jiji-0.1.1.dmg").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cannot_download_untrusted_or_forged_record() {
        let dir = std::env::temp_dir();
        let item = GithubAsset {
            version: "1.0.0".into(),
            url: "https://evil.example/file".into(),
            size: 4,
            sha256: "ab".repeat(32),
            prerelease: true,
        };
        assert_eq!(
            download(&item, Source::Proxy, &dir),
            Err(UpdateCheckError::AssetInvalid)
        );
        let bad_digest = GithubAsset {
            sha256: "zz".repeat(32),
            ..fixture_asset(b"test")
        };
        assert_eq!(
            download(&bad_digest, Source::Github, &dir),
            Err(UpdateCheckError::DigestInvalid)
        );
        assert_eq!(
            download(
                &fixture_asset(b"test"),
                Source::Github,
                Path::new("relative")
            ),
            Err(UpdateCheckError::NoDownloadDir)
        );
    }
}
