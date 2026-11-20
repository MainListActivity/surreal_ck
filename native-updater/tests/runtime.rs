#![cfg(target_os = "linux")]
use ring::{
    digest,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use surreal_ck_native_updater::{runtime::*, *};
static COUNTER: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn temp() -> Temp {
    let p = std::env::temp_dir().join(format!(
        "surreal-update-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir(&p).unwrap();
    Temp(p)
}
fn append(
    t: &mut tar::Builder<flate2::write::GzEncoder<Vec<u8>>>,
    name: &str,
    b: &[u8],
    mode: u32,
) {
    let mut h = tar::Header::new_gnu();
    h.set_size(b.len() as u64);
    h.set_mode(mode);
    h.set_cksum();
    t.append_data(&mut h, name, b).unwrap();
}
fn package(binary: &[u8], version: &str) -> Vec<u8> {
    let mut t = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    append(&mut t, "App/app", binary, 0o755);
    append(&mut t, "App/release-version.txt", version.as_bytes(), 0o644);
    append(
        &mut t,
        "App/nsh/app.json",
        format!("{{\"id\":\"test.app\",\"version\":\"{version}\"}}").as_bytes(),
        0o644,
    );
    t.into_inner().unwrap().finish().unwrap()
}
fn fixture(root: &Temp, bytes: &[u8]) -> (RuntimeConfig, Release, Vec<u8>) {
    let k = Ed25519KeyPair::from_seed_unchecked(&[43; 32]).unwrap();
    let c = RuntimeConfig {
        trust: TrustConfig {
            public_key: k.public_key().as_ref().try_into().unwrap(),
            app_id: "test.app".into(),
            channel: "stable".into(),
            download_hosts: vec!["github.com".into(), "mirror.example.com".into()],
        },
        policy_urls: vec!["https://github.com/policy".into()],
        network_hosts: vec!["github.com".into(), "mirror.example.com".into()],
        state_dir: root.0.join("state"),
        install_dir: root.0.join("installed"),
        installed_version: "1.0.0".into(),
        platform: "linux".into(),
        arch: "x86_64".into(),
        linux_executable: "App/app".into(),
    };
    let r = Release {
        platform: "linux".into(),
        arch: "x86_64".into(),
        version: "2.0.0".into(),
        url: "https://github.com/package".into(),
        mirror_urls: vec!["https://mirror.example.com/package".into()],
        sha256: hex::encode(digest::digest(&digest::SHA256, bytes)),
        size: bytes.len() as u64,
        publisher: "test.app release signing key".into(),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let p = Policy {
        schema: 1,
        app_id: "test.app".into(),
        channel: "stable".into(),
        sequence: 1,
        issued_at: now - 1,
        expires_at: now + 3600,
        releases: vec![r.clone()],
    };
    let payload = serde_json::to_string(&p).unwrap();
    let signature_hex = hex::encode(k.sign(payload.as_bytes()).as_ref());
    let envelope = serde_json::to_vec(&Envelope {
        payload,
        signature_hex,
    })
    .unwrap();
    (c, r, envelope)
}
fn compile(root: &Temp, version: &str) -> Vec<u8> {
    let source = root.0.join(format!("{version}.c"));
    let out = root.0.join(version);
    fs::write(
        &source,
        format!("#include <stdio.h>\nint main(void){{puts(\"{version}\");return 0;}}\n"),
    )
    .unwrap();
    assert!(Command::new("cc")
        .arg(source)
        .arg("-o")
        .arg(&out)
        .status()
        .unwrap()
        .success());
    fs::read(out).unwrap()
}
#[test]
fn real_download_install_and_exec_version_change() {
    let root = temp();
    let old = compile(&root, "1.0.0");
    let new = compile(&root, "2.0.0");
    assert_ne!(old, new);
    let bytes = package(&new, "2.0.0");
    let (c, _r, envelope) = fixture(&root, &bytes);
    // 真实本地TCP下载验证编排；HTTP仅注入测试传输，生产fetch_https仍强制TLS。
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let package_bytes = bytes.clone();
    let signed = envelope.clone();
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            // TCP允许请求头分段到达；先读完整header，避免带未读数据关闭导致RST。
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|b| b == b"\r\n\r\n") {
                let mut chunk = [0u8; 512];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0, "request closed before headers");
                request.extend_from_slice(&chunk[..n]);
                assert!(request.len() <= 8192, "request headers too large");
            }
            let policy = String::from_utf8_lossy(&request).starts_with("GET /policy ");
            let b = if policy { &signed } else { &package_bytes };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                b.len()
            )
            .unwrap();
            stream.write_all(b).unwrap();
        }
    });
    let mut steps = Vec::new();
    let outcome = run_startup_with(
        &c,
        |p| steps.push(p),
        |url, max| {
            let path = if url.ends_with("policy") {
                "policy"
            } else {
                "package"
            };
            let mut socket = std::net::TcpStream::connect(address).unwrap();
            write!(
                socket,
                "GET /{path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let mut response = Vec::new();
            socket.take(max + 4096).read_to_end(&mut response).unwrap();
            let start = response.windows(4).position(|x| x == b"\r\n\r\n").unwrap() + 4;
            Ok(response[start..].to_vec())
        },
    )
    .unwrap();
    server.join().unwrap();
    let exe = match outcome {
        StartupOutcome::RestartRequired(p) => p,
        _ => panic!("old version must not unlock"),
    };
    assert!(steps.contains(&Progress::Installing));
    assert!(c.state_dir.join("state.json").is_file());
    assert_eq!(
        fs::read_link(c.install_dir.join("current")).unwrap(),
        exe.strip_prefix(&c.install_dir)
            .unwrap()
            .components()
            .next()
            .unwrap()
            .as_os_str()
    );
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "restart_child", "--nocapture"])
        .env("SURREAL_TEST_RESTART", &exe)
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("2.0.0"));
    let mut current = c.clone();
    current.installed_version = "2.0.0".into();
    assert_eq!(
        run_startup_with(&current, |_| {}, |_, _| Ok(envelope.clone())).unwrap(),
        StartupOutcome::Ready
    );
}
#[test]
fn restart_child() {
    if let Some(p) = std::env::var_os("SURREAL_TEST_RESTART") {
        restart_linux(&PathBuf::from(p)).unwrap();
    }
}
#[test]
fn saved_acceptance_never_replaces_next_startup_network_check() {
    let root = temp();
    let (mut c, _, envelope) = fixture(&root, b"x");
    c.installed_version = "2.0.0".into();
    assert_eq!(
        run_startup_with(&c, |_| {}, |_, _| Ok(envelope.clone())).unwrap(),
        StartupOutcome::Ready
    );
    let mut requests = 0;
    assert!(matches!(
        run_startup_with(
            &c,
            |_| {},
            |_, _| {
                requests += 1;
                Err(RuntimeError::DownloadFailed)
            }
        ),
        Err(RuntimeError::Security(UpdateError::NetworkUnavailable))
    ));
    assert_eq!(requests, 1);
}
#[test]
fn failed_startup_persists_clock_floor_without_accepting_policy() {
    let root = temp();
    let (c, _, envelope) = fixture(&root, b"x");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let e: Envelope = serde_json::from_slice(&envelope).unwrap();
    let mut p: Policy = serde_json::from_str(&e.payload).unwrap();
    p.issued_at = now - 86401;
    p.expires_at = now - 1;
    let payload = serde_json::to_string(&p).unwrap();
    let key = Ed25519KeyPair::from_seed_unchecked(&[43; 32]).unwrap();
    let expired = serde_json::to_vec(&Envelope {
        signature_hex: hex::encode(key.sign(payload.as_bytes()).as_ref()),
        payload,
    })
    .unwrap();
    assert!(matches!(
        run_startup_with(&c, |_| {}, |_, _| Ok(expired.clone())),
        Err(RuntimeError::Security(UpdateError::Expired))
    ));
    let state_path = c.state_dir.join("state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    assert!(state["checked_at"].as_u64().unwrap() >= now);
    assert_eq!(state["sequence"], 0);
    assert!(state["policy_hash"].is_null());
    // 模拟持久时间下限高于当前时钟，不修改系统时间。联网或有效策略都不能绕过。
    state["checked_at"] = (now + 3600).into();
    fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    assert!(matches!(
        run_startup_with(
            &c,
            |_| {},
            |_, _| panic!("clock rollback must stop before fetch")
        ),
        Err(RuntimeError::Security(UpdateError::ClockRollback))
    ));
}
#[test]
fn policy_expiring_while_fetching_cannot_unlock() {
    let root = temp();
    let (mut c, _, envelope) = fixture(&root, b"x");
    c.installed_version = "2.0.0".into();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let e: Envelope = serde_json::from_slice(&envelope).unwrap();
    let mut p: Policy = serde_json::from_str(&e.payload).unwrap();
    p.expires_at = now + 1;
    let payload = serde_json::to_string(&p).unwrap();
    let key = Ed25519KeyPair::from_seed_unchecked(&[43; 32]).unwrap();
    let expiring = serde_json::to_vec(&Envelope {
        signature_hex: hex::encode(key.sign(payload.as_bytes()).as_ref()),
        payload,
    })
    .unwrap();
    assert!(matches!(
        run_startup_with(
            &c,
            |_| {},
            |_, _| {
                std::thread::sleep(std::time::Duration::from_secs(2));
                Ok(expiring.clone())
            }
        ),
        Err(RuntimeError::Security(UpdateError::Expired))
    ));
}
#[test]
fn hash_failure_keeps_current_version() {
    let root = temp();
    let b = package(b"\x7fELFbad", "2.0.0");
    let (c, r, _) = fixture(&root, &b);
    assert!(install_linux(&c, &r, b"tampered").is_err());
    assert!(!c.install_dir.join("current").exists());
}
#[test]
fn version_metadata_mismatch_rejected() {
    let root = temp();
    let b = package(b"\x7fELFbad", "1.0.0");
    let (c, r, _) = fixture(&root, &b);
    assert!(matches!(
        install_linux(&c, &r, &b),
        Err(RuntimeError::UnsafeArchive)
    ));
    assert!(!c.install_dir.join("current").exists());
}
#[test]
fn symlink_archive_rejected() {
    let root = temp();
    let mut t = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(tar::EntryType::Symlink);
    h.set_size(0);
    h.set_mode(0o777);
    h.set_link_name("/tmp/outside").unwrap();
    h.set_cksum();
    t.append_data(&mut h, "App/escape", &[][..]).unwrap();
    let b = t.into_inner().unwrap().finish().unwrap();
    let (c, r, _) = fixture(&root, &b);
    assert!(matches!(
        install_linux(&c, &r, &b),
        Err(RuntimeError::UnsafeArchive)
    ));
}
#[test]
fn malformed_persisted_state_blocks() {
    let root = temp();
    let (c, _, _) = fixture(&root, b"x");
    fs::create_dir(&c.state_dir).unwrap();
    fs::write(c.state_dir.join("state.json"), b"broken").unwrap();
    assert!(matches!(
        run_startup_with(
            &c,
            |_| {},
            |_, _| panic!("no network before state validated")
        ),
        Err(RuntimeError::InvalidState)
    ));
}
#[test]
fn offline_runtime_does_not_unlock() {
    let root = temp();
    let (c, _, _) = fixture(&root, b"x");
    assert!(run_startup_with(&c, |_| {}, |_, _| Err(RuntimeError::DownloadFailed)).is_err());
    assert!(!c.install_dir.exists());
}
#[test]
fn insecure_transport_rejected_before_fetch() {
    let root = temp();
    let (mut c, _, _) = fixture(&root, b"x");
    c.policy_urls = vec!["http://github.com/policy".into()];
    assert!(run_startup_with(&c, |_| {}, |_, _| panic!("must reject unsafe URL")).is_err());
    assert!(fetch_https("http://github.com", 128, &c.network_hosts).is_err());
}
#[test]
fn production_config_missing_is_closed() {
    assert!(load_embedded_config(
        None,
        "/tmp/a".into(),
        "/tmp/b".into(),
        "1.0.0",
        "linux",
        "x86_64"
    )
    .is_err());
}

#[test]
fn stale_lock_file_does_not_block_and_live_lock_does() {
    let root = temp();
    let (mut c, _, envelope) = fixture(&root, b"x");
    c.installed_version = "2.0.0".into();
    fs::create_dir(&c.state_dir).unwrap();
    let lockpath = c.state_dir.join("update.lock");
    fs::write(&lockpath, "dead process").unwrap();
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lockpath)
        .unwrap();
    file.lock().unwrap();
    assert!(matches!(
        run_startup_with(&c, |_| {}, |_, _| panic!("locked")),
        Err(RuntimeError::Busy)
    ));
    drop(file);
    assert_eq!(
        run_startup_with(&c, |_| {}, |_, _| Ok(envelope.clone())).unwrap(),
        StartupOutcome::Ready
    );
}
#[test]
fn broken_new_package_preserves_previous_current() {
    use std::os::unix::fs::symlink;
    let root = temp();
    let b = package(b"\x7fELFbad", "1.0.0");
    let (c, r, _) = fixture(&root, &b);
    fs::create_dir(&c.install_dir).unwrap();
    fs::create_dir(c.install_dir.join("previous")).unwrap();
    symlink("previous", c.install_dir.join("current")).unwrap();
    assert!(install_linux(&c, &r, &b).is_err());
    assert_eq!(
        fs::read_link(c.install_dir.join("current")).unwrap(),
        PathBuf::from("previous")
    );
}
#[test]
fn unsupported_platform_never_claims_installed() {
    let root = temp();
    let (mut c, _, _) = fixture(&root, b"x");
    c.platform = "android".into();
    // 签名策略中的平台也必须匹配。Linux策略不能用来触发Android安装。
    let (_, _, envelope) = fixture(&root, b"x");
    assert!(run_startup_with(&c, |_| {}, |_, _| Ok(envelope.clone())).is_err());
    assert!(!c.install_dir.exists());
}

#[test]
fn native_adapter_runs_only_after_verification_and_persistence() {
    let root = temp();
    let bytes = b"platform signed package";
    let (c, _, envelope) = fixture(&root, bytes);
    let mut called = false;
    let outcome = run_startup_with_adapters(
        &c,
        |_| {},
        |url, _| {
            Ok(if url.ends_with("policy") {
                envelope.clone()
            } else {
                bytes.to_vec()
            })
        },
        |release, actual| {
            assert_eq!(release.version, "2.0.0");
            assert_eq!(actual, bytes);
            assert!(c.state_dir.join("state.json").exists());
            called = true;
            Ok(())
        },
    )
    .unwrap();
    assert!(called);
    assert_eq!(outcome, StartupOutcome::PlatformInstallerStarted);
}
#[test]
fn bad_artifact_never_reaches_platform_adapter() {
    let root = temp();
    let (c, _, envelope) = fixture(&root, b"good");
    assert!(run_startup_with_adapters(
        &c,
        |_| {},
        |url, _| Ok(if url.ends_with("policy") {
            envelope.clone()
        } else {
            b"evil".to_vec()
        }),
        |_, _| panic!("bad hash must never start installer")
    )
    .is_err());
}
#[test]
fn adapter_failure_does_not_unlock() {
    let root = temp();
    let bytes = b"good";
    let (c, _, envelope) = fixture(&root, bytes);
    assert!(matches!(
        run_startup_with_adapters(
            &c,
            |_| {},
            |url, _| Ok(if url.ends_with("policy") {
                envelope.clone()
            } else {
                bytes.to_vec()
            }),
            |_, _| Err(RuntimeError::UnsupportedInstaller)
        ),
        Err(RuntimeError::UnsupportedInstaller)
    ));
}
