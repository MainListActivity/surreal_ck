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
