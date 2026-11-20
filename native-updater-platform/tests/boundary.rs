use surreal_ck_native_updater::Release;
use surreal_ck_native_updater_platform::*;
fn fixture(platform: &str, publisher: &str) -> Release {
    Release {
        platform: platform.into(),
        arch: "aarch64".into(),
        version: "2.0.0".into(),
        url: "https://updates.example.invalid/app.zip".into(),
        mirror_urls: vec![],
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
        size: 3,
        publisher: publisher.into(),
    }
}
#[test]
fn rechecks_bytes_before_bridge() {
    assert!(matches!(
        InstallRequest::from_verified_policy(&fixture("macos", "ABCD123456"), b"bad"),
        Err(Error::InvalidArtifact)
    ));
}
#[test]
fn rejects_publisher_shell_fragments_and_placeholder() {
    for (platform, publisher) in [
        ("macos", "UNSIGNED"),
        ("macos", "abcd123456"),
        ("windows", "x; calc"),
        ("android", "debug"),
    ] {
        assert!(matches!(
            InstallRequest::from_verified_policy(&fixture(platform, publisher), b"abc"),
            Err(Error::InvalidPublisher)
        ));
    }
}
#[test]
fn unsupported_platform_cannot_start() {
    assert!(matches!(
        InstallRequest::from_verified_policy(&fixture("ios", "ABCD123456"), b"abc"),
        Err(Error::UnsupportedPlatform)
    ));
}
#[test]
fn missing_bridge_never_means_installed() {
    let release = fixture("macos", "ABCD123456");
    let request = InstallRequest::from_verified_policy(&release, b"abc").unwrap();
    assert_eq!(Unavailable.start(&request), Err(Error::BridgeUnavailable));
    assert_eq!(request.release().version, "2.0.0");
    assert_eq!(request.bytes(), b"abc");
}

/// 原生 Android：应用看到的 filesDir 是 /data/user/0/<包>/files，而 /data/user/0 -> /data/data。
#[cfg(unix)]
mod android_files_dir {
    use std::{
        fs,
        os::unix::fs::symlink,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };
    use surreal_ck_native_updater::{runtime::*, TrustConfig, UpdateError};
    use surreal_ck_native_updater_platform::resolve_android_files_dir;

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    /// 构造 <root>/data/data/<包>/files 真实目录，以及系统布局链接 <root>/data/user/0 -> ../data。
    fn stock_layout() -> (Root, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "ck-android-layout-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let root = Root(
            fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(base.file_name().unwrap()),
        );
        let real = root.0.join("data/data/top.maplayer.collaboration/files");
        fs::create_dir_all(&real).unwrap();
        fs::create_dir_all(root.0.join("data/user")).unwrap();
        symlink(root.0.join("data/data"), root.0.join("data/user/0")).unwrap();
        let linked = root.0.join("data/user/0/top.maplayer.collaboration/files");
        (root, linked, real)
    }
    fn startup(dir: &Path) -> Result<StartupOutcome, RuntimeError> {
        let config = RuntimeConfig {
            trust: TrustConfig {
                public_key: [7; 32],
                app_id: "top.maplayer.collaboration".into(),
                channel: "stable".into(),
                download_hosts: vec!["github.com".into()],
            },
            policy_urls: vec!["https://github.com/policy".into()],
            network_hosts: vec!["github.com".into()],
            state_dir: dir.join("update-state"),
            install_dir: dir.join("versions"),
            installed_version: "0.1.0".into(),
            platform: "android".into(),
            arch: "aarch64".into(),
            linux_executable: "App/app".into(),
        };
        run_startup_with_adapters(
            &config,
            |_| {},
            |_, _| Err(RuntimeError::DownloadFailed),
            |_, _| Err(RuntimeError::UnsupportedInstaller),
        )
    }

    #[test]
    fn linked_data_user_path_reaches_network_after_resolution() {
        let (_root, linked, real) = stock_layout();
        // 安全门本身不变：未解析的链接路径仍被拒绝。
        assert!(matches!(startup(&linked), Err(RuntimeError::InvalidState)));
        let resolved = resolve_android_files_dir(&linked).expect("stock Android layout");
        assert_eq!(resolved, real);
        // 解析后通过 secure_directory，抵达网络策略检查（离线适配器使其报告网络不可用）。
        let outcome = startup(&resolved);
        assert!(
            matches!(
                outcome,
                Err(RuntimeError::Security(UpdateError::NetworkUnavailable))
            ),
            "{outcome:?}"
        );
        assert!(real.join("update-state").is_dir());
    }

    #[test]
    fn app_owned_links_are_still_rejected() {
        let (root, _linked, real) = stock_layout();
        let elsewhere = root.0.join("elsewhere/top.maplayer.collaboration/files");
        fs::create_dir_all(&elsewhere).unwrap();
        // files 本身是链接。
        fs::remove_dir(&real).unwrap();
        symlink(&elsewhere, &real).unwrap();
        assert_eq!(resolve_android_files_dir(&real), None);
        // 包目录是链接。
        let pkg_link = root.0.join("data/data/other.pkg");
        symlink(elsewhere.parent().unwrap(), &pkg_link).unwrap();
        assert_eq!(resolve_android_files_dir(&pkg_link.join("files")), None);
        // 非 files 目录、相对路径与 .. 均拒绝。
        assert_eq!(resolve_android_files_dir(elsewhere.parent().unwrap()), None);
        assert_eq!(
            resolve_android_files_dir(Path::new("data/user/0/top.maplayer.collaboration/files")),
            None
        );
        assert_eq!(
            resolve_android_files_dir(
                &root
                    .0
                    .join("data/user/0/../user/0/top.maplayer.collaboration/files")
            ),
            None
        );
    }
}
