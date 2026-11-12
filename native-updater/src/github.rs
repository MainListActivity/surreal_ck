//! Manual GitHub Releases checks for the separately configured preview channel.
//! Metadata always comes directly from GitHub over TLS; an optional third-party
//! mirror is used only for asset bytes, which must match GitHub's SHA-256.
use crate::runtime;
use ring::digest;
use serde::Deserialize;
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

const API: &str = "https://api.github.com/repos/MainListActivity/surreal_ck/releases?per_page=30";
const PREFIX: &str = "https://github.com/MainListActivity/surreal_ck/releases/download/";
const MIRROR: &str = "https://ghfast.top/";
const ASSET: &str = "Jiji-macos-arm64.dmg";
const MAX_SIZE: u64 = 512 * 1024 * 1024;

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

pub fn parse_release(bytes: &[u8]) -> Result<GithubAsset, &'static str> {
    let release: GithubRelease = serde_json::from_slice(bytes).map_err(|_| "更新信息格式无效")?;
    if release.draft
        || release.tag_name.is_empty()
        || !release
            .tag_name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
    {
        return Err("发布版本无效");
    }
    let version = release.tag_name.strip_prefix('v').ok_or("发布版本无效")?;
    let parsed = semver::Version::parse(version).map_err(|_| "发布版本无效")?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        return Err("发布版本无效");
    }
    let mut assets = release.assets.into_iter().filter(|a| a.name == ASSET);
    let asset = assets.next().ok_or("最新版本没有 Apple 芯片安装包")?;
    if assets.next().is_some() || asset.size == 0 || asset.size > MAX_SIZE {
        return Err("安装包信息无效");
    }
    let sha = asset
        .digest
        .as_deref()
        .and_then(|v| v.strip_prefix("sha256:"))
        .ok_or("GitHub 未提供 SHA-256，不能安全下载")?;
    if sha.len() != 64 || hex::decode(sha).map_or(true, |v| v.len() != 32) {
        return Err("安装包校验值无效");
    }
    let expected = format!("{PREFIX}{}/{ASSET}", release.tag_name);
    if asset.browser_download_url != expected {
        return Err("安装包地址无效");
    }
    Ok(GithubAsset {
        version: version.to_owned(),
        url: expected,
        size: asset.size,
        sha256: sha.to_ascii_lowercase(),
        prerelease: release.prerelease,
    })
}

pub fn latest() -> Result<GithubAsset, &'static str> {
    let hosts = vec!["api.github.com".to_owned()];
    let bytes = runtime::fetch_https(API, 1024 * 1024, &hosts)
        .map_err(|_| "无法连接 GitHub 或尚无正式 Release")?;
    let releases: Vec<serde_json::Value> =
        serde_json::from_slice(&bytes).map_err(|_| "更新信息格式无效")?;
    releases
        .into_iter()
        .filter_map(|release| {
            let bytes = serde_json::to_vec(&release).ok()?;
            let asset = parse_release(&bytes).ok()?;
            let version = semver::Version::parse(&asset.version).ok()?;
            Some((version, asset))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, asset)| asset)
        .ok_or("GitHub 尚无可用的 Apple 芯片版本")
}

pub fn newer(asset: &GithubAsset, current: &str) -> Result<bool, &'static str> {
    let next = semver::Version::parse(&asset.version).map_err(|_| "发布版本无效")?;
    let installed = semver::Version::parse(current).map_err(|_| "当前版本无效")?;
    Ok(next > installed)
}

pub fn download(
    asset: &GithubAsset,
    mirror: bool,
    directory: &Path,
) -> Result<PathBuf, &'static str> {
    download_with(asset, mirror, directory, |url, size| {
        let hosts = [
            "github.com",
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
            "ghfast.top",
        ]
        .map(str::to_owned)
        .to_vec();
        runtime::fetch_https(url, size, &hosts).map_err(|_| "下载失败，请更换线路后重试")
    })
}

fn download_with(
    asset: &GithubAsset,
    mirror: bool,
    directory: &Path,
    fetch: impl FnOnce(&str, u64) -> Result<Vec<u8>, &'static str>,
) -> Result<PathBuf, &'static str> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("找不到下载目录");
    }
    // Revalidate even if a caller constructs an asset directly.
    let fake = serde_json::json!({"tag_name":format!("v{}", asset.version),"draft":false,"prerelease":asset.prerelease,"assets":[{"name":ASSET,"browser_download_url":asset.url,"size":asset.size,"digest":format!("sha256:{}",asset.sha256)}]});
    let verified = parse_release(&serde_json::to_vec(&fake).map_err(|_| "安装包信息无效")?)?;
    if &verified != asset {
        return Err("安装包信息无效");
    }
    let url = if mirror {
        format!("{MIRROR}{}", asset.url)
    } else {
        asset.url.clone()
    };
    let bytes = fetch(&url, asset.size)?;
    if bytes.len() as u64 != asset.size
        || hex::encode(digest::digest(&digest::SHA256, &bytes)) != asset.sha256
    {
        return Err("下载校验失败，文件未保存");
    }
    let path = directory.join(format!("Jiji-{}.dmg", asset.version));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "无法创建下载文件（文件可能已存在）")?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = std::fs::remove_file(&path);
        return Err("保存失败");
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(tag: &str, url: &str, hash: &str) -> Vec<u8> {
        serde_json::to_vec(
            &serde_json::json!({"tag_name": tag, "draft": false, "prerelease": false,
            "assets": [{"name": ASSET, "browser_download_url": url, "size": 4, "digest": hash}]}),
        )
        .unwrap()
    }
    #[test]
    fn accepts_only_official_versioned_asset_with_digest() {
        let sha = format!("sha256:{}", "ab".repeat(32));
        let url = format!("{PREFIX}v1.2.3/{ASSET}");
        let asset = parse_release(&record("v1.2.3", &url, &sha)).unwrap();
        assert_eq!(asset.version, "1.2.3");
        assert!(newer(&asset, "1.0.0").unwrap());
        assert!(!newer(&asset, "1.2.3").unwrap());
        assert!(parse_release(&record("v1.2.3", "https://evil.example/file", &sha)).is_err());
        assert!(parse_release(&record("v1.2.3", &url, "sha256:bad")).is_err());
        assert!(parse_release(&record("v1.2.3/other", &url, &sha)).is_err());
    }
    #[test]
    fn mirror_download_verifies_bytes_and_never_overwrites() {
        let root = std::env::temp_dir().join(format!("jiji-update-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let data = b"test";
        let sha = hex::encode(digest::digest(&digest::SHA256, data));
        let asset = GithubAsset {
            version: "1.2.3".into(),
            url: format!("{PREFIX}v1.2.3/{ASSET}"),
            size: 4,
            sha256: sha,
            prerelease: true,
        };
        assert!(download_with(&asset, true, &root, |url, _| {
            assert!(url.starts_with(MIRROR));
            Ok(b"evil".to_vec())
        })
        .is_err());
        assert!(!root.join("Jiji-1.2.3.dmg").exists());
        let path = download_with(&asset, true, &root, |url, _| {
            assert_eq!(url, format!("{MIRROR}{}", asset.url));
            Ok(data.to_vec())
        })
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), data);
        assert!(download_with(&asset, false, &root, |url, _| {
            assert_eq!(url, asset.url);
            Ok(data.to_vec())
        })
        .is_err());
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
        assert!(download(&item, true, &dir).is_err());
    }
}
