//! 阻塞式启动更新：真实 TLS 下载、原子状态保存和 Linux 用户目录安装。
//! 只接受发布时固化配置。平台安装能力不足绝不返回 Ready。
use crate::*;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "linux")]
use std::{io::Read, path::Component};

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub trust: TrustConfig,
    pub policy_urls: Vec<String>,
    /// 包含策略、GitHub资产跳转和镜像主机的显式白名单。
    pub network_hosts: Vec<String>,
    pub state_dir: PathBuf,
    pub install_dir: PathBuf,
    pub installed_version: String,
    pub platform: String,
    pub arch: String,
    /// 相对压缩包根目录，如 Surreal Collaboration/SurrealCollaboration。
    pub linux_executable: PathBuf,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    Checking,
    Downloading,
    Verifying,
    Installing,
    Restarting,
    Ready,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupOutcome {
    Ready,
    RestartRequired(PathBuf),
    /// 平台安装器已接收更新；仍未解锁，平台决定何时退出/重启。
    PlatformInstallerStarted,
}
#[derive(Debug)]
pub enum RuntimeError {
    Security(UpdateError),
    Io(std::io::Error),
    InvalidState,
    Busy,
    UnsafeArchive,
    UnsupportedInstaller,
    SystemConsentRequired,
    DownloadFailed,
}
impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for RuntimeError {}
impl From<std::io::Error> for RuntimeError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<UpdateError> for RuntimeError {
    fn from(e: UpdateError) -> Self {
        Self::Security(e)
    }
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredState {
    app_id: String,
    channel: String,
    sequence: u64,
    policy_hash: Option<String>,
    checked_at: u64,
}
#[cfg(target_os = "linux")]
fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}
fn secure_directory(path: &Path) -> Result<(), RuntimeError> {
    if !path.is_absolute() {
        return Err(RuntimeError::InvalidState);
    }
    for part in path.ancestors() {
        if let Ok(m) = fs::symlink_metadata(part) {
            if m.file_type().is_symlink() {
                return Err(RuntimeError::InvalidState);
            }
        }
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), RuntimeError> {
    let temp = path.with_extension(format!(
        "pending-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| RuntimeError::InvalidState)?
            .as_nanos()
    ));
    let mut opts = OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&temp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(temp);
        return Err(e.into());
    }
    #[cfg(unix)]
    File::open(path.parent().ok_or(RuntimeError::InvalidState)?)?.sync_all()?;
    Ok(())
}
fn checked_url(raw: &str, hosts: &[String]) -> Result<url::Url, RuntimeError> {
    let u =
        url::Url::parse(raw).map_err(|_| RuntimeError::Security(UpdateError::UnsafeDownload))?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.port_or_known_default() != Some(443)
        || !hosts.iter().any(|h| Some(h.as_str()) == u.host_str())
    {
        return Err(UpdateError::UnsafeDownload.into());
    }
    Ok(u)
}
/// 真正HTTPS，最多5次显式验证重定向；限制响应字节和每次请求时间。
pub fn fetch_https(raw: &str, max_bytes: u64, hosts: &[String]) -> Result<Vec<u8>, RuntimeError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .max_redirects_will_error(false)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .into();
    let mut u = checked_url(raw, hosts)?;
    for _ in 0..=5 {
        let mut response = agent
            .get(u.as_str())
            // 每次启动必须真实访问端点，不能把中间缓存当作最新策略。
            .header("Cache-Control", "no-cache, no-store")
            .header("Pragma", "no-cache")
            .call()
            .map_err(|_| RuntimeError::DownloadFailed)?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|s| s.to_str().ok())
                .ok_or(RuntimeError::DownloadFailed)?;
            u = checked_url(
                u.join(location)
                    .map_err(|_| RuntimeError::DownloadFailed)?
                    .as_str(),
                hosts,
            )?;
            continue;
        }
        if response.status() != 200 {
            return Err(RuntimeError::DownloadFailed);
        }
        return response
            .body_mut()
            .with_config()
            .limit(max_bytes)
            .read_to_vec()
            .map_err(|_| RuntimeError::DownloadFailed);
    }
    Err(RuntimeError::DownloadFailed)
}
pub fn run_startup(
    config: &RuntimeConfig,
    progress: impl FnMut(Progress),
) -> Result<StartupOutcome, RuntimeError> {
    run_startup_with(config, progress, |url, max| {
        fetch_https(url, max, &config.network_hosts)
    })
}
/// 注入下载器供集成测试/原生TLS适配；生产不得提供跳过TLS或签名验证的下载器。
pub fn run_startup_with<F>(
    config: &RuntimeConfig,
    progress: impl FnMut(Progress),
    fetch: F,
) -> Result<StartupOutcome, RuntimeError>
where
    F: FnMut(&str, u64) -> Result<Vec<u8>, RuntimeError>,
{
    run_startup_engine(config, progress, fetch, |release, bytes| {
        if config.platform != "linux" || !cfg!(target_os = "linux") {
            return Err(RuntimeError::UnsupportedInstaller);
        }
        Ok(StartupOutcome::RestartRequired(install_linux(
            config, release, bytes,
        )?))
    })
}
/// 原生适配器只有在策略/包已验证且反回滚状态保存成功后才能被调用。
/// Ok只表示平台安装已启动，绝不返回Ready；适配器负责系统签名/身份核对。
pub fn run_startup_with_installer(
    config: &RuntimeConfig,
    progress: impl FnMut(Progress),
    installer: impl FnOnce(&Release, &[u8]) -> Result<(), RuntimeError>,
) -> Result<StartupOutcome, RuntimeError> {
    run_startup_with_adapters(
        config,
        progress,
        |url, max| fetch_https(url, max, &config.network_hosts),
        installer,
    )
}
/// 允许平台提供自己的受信任传输；不会跳过任何签名、版本或状态检查。
pub fn run_startup_with_adapters<F>(
    config: &RuntimeConfig,
    progress: impl FnMut(Progress),
    fetch: F,
    installer: impl FnOnce(&Release, &[u8]) -> Result<(), RuntimeError>,
) -> Result<StartupOutcome, RuntimeError>
where
    F: FnMut(&str, u64) -> Result<Vec<u8>, RuntimeError>,
{
    run_startup_engine(config, progress, fetch, |release, bytes| {
        installer(release, bytes)?;
        Ok(StartupOutcome::PlatformInstallerStarted)
    })
}
fn run_startup_engine<F>(
    config: &RuntimeConfig,
    mut progress: impl FnMut(Progress),
    mut fetch: F,
    installer: impl FnOnce(&Release, &[u8]) -> Result<StartupOutcome, RuntimeError>,
) -> Result<StartupOutcome, RuntimeError>
where
    F: FnMut(&str, u64) -> Result<Vec<u8>, RuntimeError>,
{
    if config.trust.public_key == [0; 32] || config.policy_urls.is_empty() {
        return Err(UpdateError::NotConfigured.into());
    }
    secure_directory(&config.state_dir)?;
    let lock_path = config.state_dir.join("update.lock");
    if let Ok(m) = fs::symlink_metadata(&lock_path) {
        if !m.is_file() {
            return Err(RuntimeError::InvalidState);
        }
    }
    // 内核锁随崩溃自动释放，不能以遗留lock文件永久锁死。
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .read(true)
        .open(&lock_path)?;
    lock.try_lock().map_err(|_| RuntimeError::Busy)?;
    let _lock = lock;
    let state_path = config.state_dir.join("state.json");
    let mut state = match fs::symlink_metadata(&state_path) {
        Ok(m) => {
            if !m.is_file() || m.len() > 8192 {
                return Err(RuntimeError::InvalidState);
            }
            let b = fs::read(&state_path)?;
            let s: StoredState =
                serde_json::from_slice(&b).map_err(|_| RuntimeError::InvalidState)?;
            if s.app_id != config.trust.app_id || s.channel != config.trust.channel {
                return Err(RuntimeError::InvalidState);
            }
            s
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => StoredState::default(),
        Err(e) => return Err(e.into()),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RuntimeError::InvalidState)?
        .as_secs();
    if now < state.checked_at {
        return Err(UpdateError::ClockRollback.into());
    }
    // 失败尝试也保留已观察时间：不能在见到过期/断网后回拨到上次成功时间重试。
    // 这里不接受任何策略，sequence/hash 只在后面的验签成功路径提升。
    state.app_id = config.trust.app_id.clone();
    state.channel = config.trust.channel.clone();
    state.checked_at = now;
    atomic_write(
        &state_path,
        &serde_json::to_vec(&state).map_err(|_| RuntimeError::InvalidState)?,
    )?;
    let mut context = CheckContext {
        installed_version: config.installed_version.clone(),
        platform: config.platform.clone(),
        arch: config.arch.clone(),
        now_unix: now,
        highest_sequence: state.sequence,
        previous_policy_hash: state.policy_hash.clone(),
        last_seen_unix: state.checked_at,
    };
    progress(Progress::Checking);
    let mut gate = Gate::default();
    let mut accepted = false;
    for url in &config.policy_urls {
        checked_url(url, &config.network_hosts)?;
        let fetched = fetch(url, 128 * 1024);
        // 网络等待可能跨过到期边界，必须用响应后的时间验证而不是启动时快照。
        let observed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| RuntimeError::InvalidState)?
            .as_secs();
        if observed < context.now_unix {
            return Err(UpdateError::ClockRollback.into());
        }
        if observed > state.checked_at {
            state.checked_at = observed;
            atomic_write(
                &state_path,
                &serde_json::to_vec(&state).map_err(|_| RuntimeError::InvalidState)?,
            )?;
        }
        context.now_unix = observed;
        if let Ok(bytes) = fetched {
            if gate.check(&bytes, &config.trust, &context).is_ok() {
                accepted = true;
                break;
            }
        }
    }
    if !accepted {
        return Err(match gate.status() {
            GateStatus::Blocked(e) if *e != UpdateError::NotConfigured => e.clone(),
            _ => UpdateError::NetworkUnavailable,
        }
        .into());
    }
    let a = gate.acceptance().ok_or(RuntimeError::InvalidState)?;
    let s = StoredState {
        app_id: config.trust.app_id.clone(),
        channel: config.trust.channel.clone(),
        sequence: a.sequence,
        policy_hash: Some(a.policy_hash.clone()),
        checked_at: a.checked_at,
    };
    atomic_write(
        &state_path,
        &serde_json::to_vec(&s).map_err(|_| RuntimeError::InvalidState)?,
    )?;
    if gate.can_enter() {
        progress(Progress::Ready);
        return Ok(StartupOutcome::Ready);
    }
    let release = match gate.status() {
        GateStatus::UpdateRequired(r) => r,
        _ => return Err(RuntimeError::InvalidState),
    };
    progress(Progress::Downloading);
    let bytes = download_verified(release, |url, max| {
        fetch(url, max).map_err(|_| UpdateError::NetworkUnavailable)
    })?;
    progress(Progress::Verifying);
    verify_artifact(release, &bytes)?;
    progress(Progress::Installing);
    let outcome = installer(release, &bytes)?;
    progress(Progress::Restarting);
    Ok(outcome)
}
/// 新版本写独立目录，全部校验后原子替换current软链；旧目录保留可恢复，不运行shell。
#[cfg(target_os = "linux")]
pub fn install_linux(
    config: &RuntimeConfig,
    release: &Release,
    bytes: &[u8],
) -> Result<PathBuf, RuntimeError> {
    use std::os::unix::fs::{symlink, PermissionsExt};
    verify_artifact(release, bytes)?;
    if release.platform != "linux"
        || release.arch != config.arch
        || !safe_relative(&config.linux_executable)
    {
        return Err(RuntimeError::UnsafeArchive);
    }
    secure_directory(&config.install_dir)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RuntimeError::InvalidState)?
        .as_nanos();
    let slot = format!("{}-{}-{nonce}", release.version, release.sha256);
    if !safe_relative(Path::new(&slot)) {
        return Err(RuntimeError::UnsafeArchive);
    }
    let staging = config
        .install_dir
        .join(format!(".stage-{}-{nonce}", std::process::id()));
    // 新建唯一stage，异常中断不会复用/执行旧stage；旧stage保留待安全清理。
    fs::create_dir(&staging)?;
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))?;
    let result = (|| {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        let mut total = 0u64;
        let mut count = 0;
        for item in archive.entries()? {
            let mut item = item?;
            count += 1;
            if count > 10000 {
                return Err(RuntimeError::UnsafeArchive);
            }
            let path = item.path()?.into_owned();
            if !safe_relative(&path) {
                return Err(RuntimeError::UnsafeArchive);
            }
            let kind = item.header().entry_type();
            if !(kind.is_file() || kind.is_dir()) {
                return Err(RuntimeError::UnsafeArchive);
            }
            total = total
                .checked_add(item.size())
                .ok_or(RuntimeError::UnsafeArchive)?;
            if total > 4 * 1024 * 1024 * 1024 {
                return Err(RuntimeError::UnsafeArchive);
            }
            let destination = staging.join(&path);
            if kind.is_dir() {
                fs::create_dir_all(&destination)?;
                continue;
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut target = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&destination)?;
            std::io::copy(&mut item, &mut target)?;
            target.sync_all()?;
            let executable = item.header().mode()? & 0o111 != 0;
            fs::set_permissions(
                &destination,
                fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
            )?;
        }
        let exe = staging.join(&config.linux_executable);
        let parent = exe.parent().ok_or(RuntimeError::UnsafeArchive)?;
        let app: serde_json::Value =
            serde_json::from_slice(&fs::read(parent.join("nsh/app.json"))?)
                .map_err(|_| RuntimeError::UnsafeArchive)?;
        if app["version"].as_str() != Some(&release.version)
            || app["id"].as_str() != Some(&config.trust.app_id)
        {
            return Err(RuntimeError::UnsafeArchive);
        }
        if fs::read_to_string(parent.join("release-version.txt"))?.trim() != release.version {
            return Err(RuntimeError::UnsafeArchive);
        }
        let metadata = fs::symlink_metadata(&exe)?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
            return Err(RuntimeError::UnsafeArchive);
        }
        // Linux正式包必须ELF。避免把脚本解释器作为安装后程序执行。
        let mut magic = [0u8; 4];
        File::open(&exe)?.read_exact(&mut magic)?;
        if magic != *b"\x7fELF" {
            return Err(RuntimeError::UnsafeArchive);
        }
        let final_dir = config.install_dir.join(&slot);
        if final_dir.exists() {
            return Err(RuntimeError::InvalidState);
        }
        fs::rename(&staging, &final_dir)?;
        let link = config
            .install_dir
            .join(format!(".current-{}", std::process::id()));
        symlink(&slot, &link)?;
        fs::rename(&link, config.install_dir.join("current"))?;
        File::open(&config.install_dir)?.sync_all()?;
        Ok(final_dir.join(&config.linux_executable))
    })();
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}
#[cfg(not(target_os = "linux"))]
pub fn install_linux(_: &RuntimeConfig, _: &Release, _: &[u8]) -> Result<PathBuf, RuntimeError> {
    Err(RuntimeError::UnsupportedInstaller)
}
/// 只有由本次成功安装返回的路径可传入；失败不解锁，调用者显示错误。
#[cfg(target_os = "linux")]
pub fn restart_linux(executable: &Path) -> Result<(), RuntimeError> {
    use std::os::unix::process::CommandExt;
    let parent = executable.parent().ok_or(RuntimeError::InvalidState)?;
    Err(std::process::Command::new(executable)
        .current_dir(parent)
        .exec()
        .into())
}
#[cfg(not(target_os = "linux"))]
pub fn restart_linux(_: &Path) -> Result<(), RuntimeError> {
    Err(RuntimeError::UnsupportedInstaller)
}

/// 公共构建配置，绝不能包含私钥；目录来自平台本地路径，不来自网络JSON。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmbeddedConfig {
    pub trust: TrustConfig,
    pub policy_urls: Vec<String>,
    pub network_hosts: Vec<String>,
    pub linux_executable: PathBuf,
}
pub fn load_embedded_config(
    json: Option<&str>,
    state_dir: PathBuf,
    install_dir: PathBuf,
    installed_version: &str,
    platform: &str,
    arch: &str,
) -> Result<RuntimeConfig, RuntimeError> {
    let json = json.ok_or(RuntimeError::Security(UpdateError::NotConfigured))?;
    if json.len() > 16384 {
        return Err(RuntimeError::InvalidState);
    }
    let c: EmbeddedConfig = serde_json::from_str(json).map_err(|_| RuntimeError::InvalidState)?;
    if c.trust.public_key == [0; 32]
        || c.policy_urls.is_empty()
        || c.trust.app_id.is_empty()
        || c.trust.channel.is_empty()
    {
        return Err(UpdateError::NotConfigured.into());
    }
    for u in &c.policy_urls {
        checked_url(u, &c.network_hosts)?;
    }
    Ok(RuntimeConfig {
        trust: c.trust,
        policy_urls: c.policy_urls,
        network_hosts: c.network_hosts,
        state_dir,
        install_dir,
        installed_version: installed_version.into(),
        platform: platform.into(),
        arch: arch.into(),
        linux_executable: c.linux_executable,
    })
}
