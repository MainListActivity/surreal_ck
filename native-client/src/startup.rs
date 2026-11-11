//! 启动只读取编译时固化的公开更新信任配置；不接受网络或环境变量覆盖。
use std::path::PathBuf;
use surreal_ck_native_updater::runtime::{self, Progress, StartupOutcome};
pub enum Event {
    Status(String),
    Ready,
}
pub fn start(data_dir: Option<PathBuf>) -> async_channel::Receiver<Event> {
    let (tx, rx) = async_channel::bounded(16);
    std::thread::spawn(move || {
        let config = option_env!("SURREAL_UPDATE_CONFIG_JSON");
        if config.is_none() {
            let _ = tx.send_blocking(Event::Status(
                "尚未配置可信更新服务，暂不能打开应用。".into(),
            ));
            return;
        }
        let Some(dir) = data_dir else {
            let _ = tx.send_blocking(Event::Status(
                "无法访问应用私有目录，更新验证已停止。".into(),
            ));
            return;
        };
        let result = (|| {
            let config = runtime::load_embedded_config(
                config,
                dir.join("update-state"),
                dir.join("versions"),
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH,
            )?;
            if config.trust.app_id != "top.maplayer.collaboration" {
                return Err(runtime::RuntimeError::InvalidState);
            }
            run_config(&config, tx.clone(), |progress| {
                let text = match progress {
                    Progress::Checking => "正在验证最新版本…",
                    Progress::Downloading => "正在下载必需更新…",
                    Progress::Verifying => "正在校验更新文件…",
                    Progress::Installing => "正在安装更新…",
                    Progress::Restarting => "更新已安装，正在重新启动…",
                    Progress::Ready => "更新验证完成。",
                };
                let _ = tx.send_blocking(Event::Status(text.into()));
            })
        })();
        match result {
            Ok(StartupOutcome::Ready) => {
                let _ = tx.send_blocking(Event::Ready);
            }
            Ok(StartupOutcome::PlatformInstallerStarted) => {
                // mac桥返回只表示主队列接收请求；实际状态由有generation的原生回调报告。
                // 不在此发送“已启动”，避免异步失败先到达时被这个迟到消息覆盖。
                #[cfg(not(all(target_os = "macos", feature = "macos-auto-update")))]
                let _ = tx.send_blocking(Event::Status(
                    "系统更新安装器已启动，完成安装并重启前应用保持锁定。".into(),
                ));
            }
            Ok(StartupOutcome::RestartRequired(path)) => {
                if let Err(error) = runtime::restart_linux(&path) {
                    let _ = tx.send_blocking(Event::Status(format!(
                        "无法重新启动，应用保持锁定：{error}"
                    )));
                }
            }
            Err(runtime::RuntimeError::SystemConsentRequired) => {
                let _ = tx.send_blocking(Event::Status(
                    "Android需要系统安装授权，应用保持锁定。请在系统设置授权后重新启动。".into(),
                ));
            }
            Err(error) => {
                let _ = tx.send_blocking(Event::Status(format!(
                    "更新验证未完成，应用保持锁定：{error}"
                )));
            }
        }
    });
    rx
}

/// Android 0.4.0 Rust API 尚未暴露 Context.filesDir，缺原生桥时拒绝猜测沙箱路径。
pub fn private_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/share")))
            .filter(|p| p.is_absolute())
            .map(|p| p.join("top.maplayer.collaboration"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|p| {
                PathBuf::from(p).join("Library/Application Support/top.maplayer.collaboration")
            })
            .filter(|p| p.is_absolute())
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|p| PathBuf::from(p).join("SurrealCollaboration"))
            .filter(|p| p.is_absolute())
    }
    #[cfg(all(target_os = "android", feature = "android-auto-update"))]
    {
        surreal_ck_native_updater_platform::android::private_data_dir()
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows",
        all(target_os = "android", feature = "android-auto-update")
    )))]
    {
        None
    }
}

#[cfg(not(any(
    all(target_os = "macos", feature = "macos-auto-update"),
    all(target_os = "windows", feature = "windows-auto-update"),
    all(target_os = "android", feature = "android-auto-update")
)))]
fn run_config(
    config: &runtime::RuntimeConfig,
    _tx: async_channel::Sender<Event>,
    progress: impl FnMut(Progress),
) -> Result<StartupOutcome, runtime::RuntimeError> {
    runtime::run_startup(config, progress)
}
// 仅mac桥及Linux可运行的状态机测试需要此类型；全局保留的是空registry，不是sender。
#[cfg(any(test, all(target_os = "macos", feature = "macos-auto-update")))]
mod callback_lifecycle {
    use super::Event;
    use async_channel::{Sender, TrySendError};
    use std::sync::Mutex;

    struct Active {
        generation: u64,
        sender: Sender<Event>,
    }
    pub(super) struct Registry {
        state: Mutex<(u64, Option<Active>)>,
    }
    pub(super) struct Registration<'a> {
        registry: &'a Registry,
        generation: u64,
        detached: bool,
    }
    impl Registry {
        pub(super) const fn new() -> Self {
            Self {
                state: Mutex::new((0, None)),
            }
        }
        pub(super) fn begin(&self, sender: Sender<Event>) -> Option<Registration<'_>> {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.1.is_some() {
                return None;
            }
            state.0 = state.0.checked_add(1)?;
            let generation = state.0;
            state.1 = Some(Active { generation, sender });
            Some(Registration {
                registry: self,
                generation,
                detached: false,
            })
        }
        fn clear(&self, generation: u64) {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state
                .1
                .as_ref()
                .is_some_and(|active| active.generation == generation)
            {
                state.1 = None;
            }
        }
        pub(super) fn report(&self, generation: u64, text: String, terminal: bool) {
            let sender = {
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                if !state
                    .1
                    .as_ref()
                    .is_some_and(|active| active.generation == generation)
                {
                    return;
                }
                if terminal {
                    state.1.take().map(|active| active.sender)
                } else {
                    state.1.as_ref().map(|active| active.sender.clone())
                }
            };
            let Some(sender) = sender else {
                return;
            };
            // 普通进度可合并/丢弃；终态不能因队列满而永远占着sender。
            // 正常路径无额外线程；满队列时在后台等待，绝不阻塞mac主线程。
            if let Err(TrySendError::Full(event)) = sender.try_send(Event::Status(text))
                && terminal
            {
                let _ = std::thread::Builder::new()
                    .name("update-terminal".into())
                    .spawn(move || {
                        let _ = sender.send_blocking(event);
                    });
            }
        }
    }
    impl Registration<'_> {
        pub(super) fn generation(&self) -> u64 {
            self.generation
        }
        pub(super) fn detach(mut self) {
            self.detached = true;
        }
    }
    impl Drop for Registration<'_> {
        fn drop(&mut self) {
            if !self.detached {
                self.registry.clear(self.generation);
            }
        }
    }
}

#[cfg(all(target_os = "macos", feature = "macos-auto-update"))]
fn run_config(
    config: &runtime::RuntimeConfig,
    tx: async_channel::Sender<Event>,
    progress: impl FnMut(Progress),
) -> Result<StartupOutcome, runtime::RuntimeError> {
    use surreal_ck_native_updater_platform::{InstallRequest, sparkle};
    static STATUS: callback_lifecycle::Registry = callback_lifecycle::Registry::new();
    extern "C" fn report(generation: u64, terminal: bool, value: *const std::ffi::c_char) {
        // SAFETY: 原生桥同步传入有效NUL结尾字符串；立即复制，禁止保存借用指针。
        let text = unsafe { sparkle::status_text(value) }
            .unwrap_or_else(|| "更新桥返回无效状态，应用保持锁定。".into());
        STATUS.report(generation, text, terminal);
    }
    runtime::run_startup_with_installer(config, progress, |release, bytes| {
        let request = InstallRequest::from_verified_policy(release, bytes)
            .map_err(|_| runtime::RuntimeError::InvalidState)?;
        // 网络/策略/下载失败此前不会登记sender，因此worker退出后UI自然可重试。
        let registration = STATUS
            .begin(tx.clone())
            .ok_or(runtime::RuntimeError::Busy)?;
        sparkle::start(&request, registration.generation(), report)
            .map_err(|_| runtime::RuntimeError::UnsupportedInstaller)?;
        // 同步启动错误由RAII释放；异步失败由带generation的terminal回调释放。
        registration.detach();
        Ok(())
    })
}

#[cfg(all(target_os = "android", feature = "android-auto-update"))]
fn run_config(
    config: &runtime::RuntimeConfig,
    _tx: async_channel::Sender<Event>,
    progress: impl FnMut(Progress),
) -> Result<StartupOutcome, runtime::RuntimeError> {
    use surreal_ck_native_updater_platform::{InstallRequest, InstallState, android};
    runtime::run_startup_with_installer(config, progress, |release, bytes| {
        let request = InstallRequest::from_verified_policy(release, bytes)
            .map_err(|_| runtime::RuntimeError::InvalidState)?;
        match android::start(&request).map_err(|_| runtime::RuntimeError::UnsupportedInstaller)? {
            InstallState::Started => Ok(()),
            InstallState::PendingSystemConsent => Err(runtime::RuntimeError::SystemConsentRequired),
            _ => Err(runtime::RuntimeError::UnsupportedInstaller),
        }
    })
}

#[cfg(all(target_os = "windows", feature = "windows-auto-update"))]
fn run_config(
    config: &runtime::RuntimeConfig,
    _tx: async_channel::Sender<Event>,
    progress: impl FnMut(Progress),
) -> Result<StartupOutcome, runtime::RuntimeError> {
    use surreal_ck_native_updater_platform::{InstallRequest, windows};
    let mut pending = None;
    let outcome = runtime::run_startup_with_installer(config, progress, |release, bytes| {
        let request = InstallRequest::from_verified_policy(release, bytes)
            .map_err(|_| runtime::RuntimeError::InvalidState)?;
        pending = Some(
            windows::prepare(windows::VerifiedUpdate {
                bytes: request.bytes(),
                sha256: &release.sha256,
                publisher: &release.publisher,
                old_version: env!("CARGO_PKG_VERSION"),
                target_version: &release.version,
            })
            .map_err(|_| runtime::RuntimeError::UnsupportedInstaller)?,
        );
        Ok(())
    })?;
    if matches!(outcome, StartupOutcome::PlatformInstallerStarted) {
        // 仅已验证策略/文件且helper确认交接后退出；业务未挂载，无采集会话。
        // helper还必须等待旧PID退出、验证安装和重启；此处绝不发送Ready。
        pending
            .ok_or(runtime::RuntimeError::InvalidState)?
            .arm_for_exit()
            .map_err(|_| runtime::RuntimeError::UnsupportedInstaller)?;
        std::process::exit(0);
    }
    Ok(outcome)
}

#[cfg(test)]
mod callback_tests {
    use super::{Event, callback_lifecycle::Registry};
    use async_channel::TryRecvError;
    fn status(receiver: &async_channel::Receiver<Event>) -> String {
        match receiver.recv_blocking().expect("status event") {
            Event::Status(text) => text,
            Event::Ready => panic!("callback must never unlock the application"),
        }
    }
    #[test]
    fn failure_before_installer_does_not_retain_sender() {
        let registry = Registry::new();
        let (sender, receiver) = async_channel::bounded::<Event>(1);
        // 核心下载/策略失败：未调用installer，因此不会begin。
        drop(sender);
        assert!(receiver.is_closed());
        let (sender, _) = async_channel::bounded::<Event>(1);
        assert!(registry.begin(sender).is_some());
    }
    #[test]
    fn synchronous_start_failure_releases_registration_and_allows_retry() {
        let registry = Registry::new();
        let (sender, receiver) = async_channel::bounded::<Event>(1);
        let attempt = registry.begin(sender).unwrap();
        drop(attempt); // 等价于sparkle::start返回Err后?展开
        assert!(receiver.is_closed());
        let (sender, _) = async_channel::bounded::<Event>(1);
        assert!(registry.begin(sender).is_some());
    }
    #[test]
    fn terminal_closes_channel_and_late_old_callbacks_cannot_touch_retry() {
        let registry = Registry::new();
        let (sender, receiver) = async_channel::bounded::<Event>(2);
        let attempt = registry.begin(sender).unwrap();
        let old = attempt.generation();
        attempt.detach();
        registry.report(old, "failure".into(), true);
        assert_eq!(status(&receiver), "failure");
        assert!(receiver.is_closed());
        let (sender, newer) = async_channel::bounded::<Event>(2);
        let attempt = registry.begin(sender).unwrap();
        let current = attempt.generation();
        assert_ne!(old, current);
        attempt.detach();
        registry.report(old, "late progress".into(), false);
        registry.report(old, "duplicate terminal".into(), true);
        assert_eq!(newer.try_recv().err(), Some(TryRecvError::Empty));
        assert!(!newer.is_closed());
        registry.report(current, "new failure".into(), true);
        assert_eq!(status(&newer), "new failure");
        assert!(newer.is_closed());
    }
    #[test]
    fn terminal_before_start_returns_is_safe_and_full_queue_still_drains() {
        let registry = Registry::new();
        let (sender, receiver) = async_channel::bounded::<Event>(1);
        let attempt = registry.begin(sender).unwrap();
        let generation = attempt.generation();
        registry.report(generation, "progress".into(), false);
        registry.report(generation, "terminal".into(), true);
        attempt.detach(); // 回调可早于C返回，detach不会重建已清理的slot
        assert_eq!(status(&receiver), "progress");
        assert_eq!(status(&receiver), "terminal");
        assert!(receiver.recv_blocking().is_err());
    }
    #[test]
    fn active_attempt_rejects_overlap_without_closing_current_channel() {
        let registry = Registry::new();
        let (sender, receiver) = async_channel::bounded::<Event>(1);
        let attempt = registry.begin(sender).unwrap();
        let (second, second_receiver) = async_channel::bounded::<Event>(1);
        assert!(registry.begin(second).is_none());
        assert!(second_receiver.is_closed());
        assert!(!receiver.is_closed());
        drop(attempt);
        assert!(receiver.is_closed());
    }
}
