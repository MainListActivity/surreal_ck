//! 平台安装边界。只在核心验证策略及资产后调用；任何结果都不能替代下一次启动验证。
use surreal_ck_native_updater::{verify_artifact, Release};

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidArtifact,
    InvalidPublisher,
    UnsupportedPlatform,
    BridgeUnavailable,
}
#[derive(Debug, PartialEq, Eq)]
pub enum InstallState {
    Started,
    PendingSystemConsent,
    RestartRequired,
    Failed,
}
/// 绑定核心已验证的策略目标。字段私有，避免桥意外替换版本或发布者。
pub struct InstallRequest<'a> {
    release: &'a Release,
    bytes: &'a [u8],
}
impl<'a> InstallRequest<'a> {
    /// 调用者必须首先验证策略签名、时效和防回滚状态；本方法额外重新核验资产。
    pub fn from_verified_policy(release: &'a Release, bytes: &'a [u8]) -> Result<Self, Error> {
        verify_artifact(release, bytes).map_err(|_| Error::InvalidArtifact)?;
        let valid_publisher = match release.platform.as_str() {
            "macos" => {
                release.publisher.len() == 10
                    && release
                        .publisher
                        .bytes()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            }
            "windows" => {
                release.publisher.len() == 64
                    && release.publisher.bytes().all(|c| c.is_ascii_hexdigit())
            }
            "android" => {
                release.publisher.len() == 64
                    && release.publisher.bytes().all(|c| c.is_ascii_hexdigit())
            }
            _ => return Err(Error::UnsupportedPlatform),
        };
        if !valid_publisher {
            return Err(Error::InvalidPublisher);
        }
        Ok(Self { release, bytes })
    }
    pub fn release(&self) -> &Release {
        self.release
    }
    pub fn bytes(&self) -> &[u8] {
        self.bytes
    }
}
/// 桥的启动结果绝不是业务 Ready；错误和系统确认等待均保持业务锁定。
pub trait PlatformInstaller {
    fn start(&mut self, request: &InstallRequest<'_>) -> Result<InstallState, Error>;
}
/// 默认构建故意没有“模拟成功”；需要平台宿主链接对应适配器。
pub struct Unavailable;
impl PlatformInstaller for Unavailable {
    fn start(&mut self, _: &InstallRequest<'_>) -> Result<InstallState, Error> {
        Err(Error::BridgeUnavailable)
    }
}
/// Android 官方条件随 OS 更新变化；最终决定仍以 PackageInstaller 回调为准。
pub fn android_may_request_unattended(
    api: u32,
    target: u32,
    self_update: bool,
    declares_update_permission: bool,
    can_install_packages: bool,
) -> bool {
    let minimum = match api {
        31..=32 => 29,
        33 => 30,
        34 => 31,
        35 => 33,
        36 => 34,
        37 => 35,
        _ => return false,
    };
    target >= minimum && self_update && declares_update_permission && can_install_packages
}
/// 解析 Android `Context.getFilesDir()` 的真实路径。
///
/// 原生 Android 上 `/data/user/0` 是指向 `/data/data` 的系统符号链接，核心更新器的
/// `secure_directory` 会拒绝路径中的任何链接。这里只解析应用包目录之上的系统布局链接：
/// `<包目录>` 与 `<包目录>/files` 本身必须是真实目录，解析后包名与 `files` 不得改变，
/// 因此应用私有区里的意外链接仍会被拒绝，交给核心的同一安全检查继续把关。
#[cfg(unix)]
pub fn resolve_android_files_dir(raw: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::{fs, path::Component};
    if !raw.is_absolute()
        || !raw
            .components()
            .skip(1)
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let files = raw.file_name()?;
    let package_dir = raw.parent()?;
    let package = package_dir.file_name()?;
    if files != "files" {
        return None;
    }
    for app_owned in [raw, package_dir] {
        if !fs::symlink_metadata(app_owned).ok()?.file_type().is_dir() {
            return None;
        }
    }
    let real = fs::canonicalize(raw).ok()?;
    let real_package = real.parent()?;
    (real.file_name()? == files && real_package.file_name()? == package).then_some(real)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn android_never_promises_old_or_unknown_os() {
        for api in [28, 29, 30, 38, 100] {
            assert!(!android_may_request_unattended(api, 100, true, true, true));
        }
    }
    #[test]
    fn android_requires_each_condition() {
        assert!(android_may_request_unattended(35, 35, true, true, true));
        for (target, own, permission, allowed) in [
            (32, true, true, true),
            (35, false, true, true),
            (35, true, false, true),
            (35, true, true, false),
        ] {
            assert!(!android_may_request_unattended(
                35, target, own, permission, allowed
            ));
        }
    }
    #[test]
    fn android_thresholds_advance() {
        for (api, target) in [
            (31, 29),
            (32, 29),
            (33, 30),
            (34, 31),
            (35, 33),
            (36, 34),
            (37, 35),
        ] {
            assert!(android_may_request_unattended(
                api, target, true, true, true
            ));
            assert!(!android_may_request_unattended(
                api,
                target - 1,
                true,
                true,
                true
            ));
        }
    }
}

pub mod sparkle;

#[cfg(target_os = "android")]
pub mod android;

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(any(target_os = "windows", test))]
pub mod windows_protocol;
