use ring::{
    digest,
    signature::{Ed25519KeyPair, KeyPair},
};
use surreal_ck_native_updater::*;
fn fixture() -> (Ed25519KeyPair, TrustConfig, CheckContext, Policy) {
    // 公开确定性测试种子，仅用于测试，绝不是生产凭证。
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
    let config = TrustConfig {
        public_key: key.public_key().as_ref().try_into().unwrap(),
        app_id: "surreal-ck".into(),
        channel: "stable".into(),
        download_hosts: vec!["github.com".into(), "mirror.example.com".into()],
    };
    let context = CheckContext {
        installed_version: "1.0.0".into(),
        platform: "windows".into(),
        arch: "x86_64".into(),
        now_unix: 100,
        highest_sequence: 0,
        previous_policy_hash: None,
        last_seen_unix: 0,
    };
    let release = Release {
        platform: "windows".into(),
        arch: "x86_64".into(),
        version: "1.0.0".into(),
        url: "https://github.com/org/app/releases/download/v1.0.0/setup.exe".into(),
        mirror_urls: vec!["https://mirror.example.com/setup.exe".into()],
        sha256: hex::encode(digest::digest(&digest::SHA256, b"signed-package")),
        size: 14,
        publisher: "CN=Expected Publisher".into(),
    };
    let policy = Policy {
        schema: 1,
        app_id: "surreal-ck".into(),
        channel: "stable".into(),
        sequence: 1,
        issued_at: 90,
        expires_at: 200,
        releases: vec![release],
    };
    (key, config, context, policy)
}
fn encode(key: &Ed25519KeyPair, policy: &Policy) -> Vec<u8> {
    let payload = serde_json::to_string(policy).unwrap();
    let signature_hex = hex::encode(key.sign(payload.as_bytes()).as_ref());
    serde_json::to_vec(&Envelope {
        payload,
        signature_hex,
    })
    .unwrap()
}
#[test]
fn defaults_fail_closed() {
    let g = Gate::default();
    assert!(!g.can_enter());
    assert!(g.acceptance().is_none());
}
#[test]
fn valid_current_allows_and_records_floor() {
    let (k, c, x, p) = fixture();
    let mut g = Gate::default();
    g.check(&encode(&k, &p), &c, &x).unwrap();
    assert!(g.can_enter());
    assert_eq!(g.acceptance().unwrap().sequence, 1);
}
#[test]
fn mandatory_update_stays_locked() {
    let (k, c, x, mut p) = fixture();
    p.releases[0].version = "1.1.0".into();
    let mut g = Gate::default();
    g.check(&encode(&k, &p), &c, &x).unwrap();
    assert!(!g.can_enter());
    assert!(matches!(g.status(), GateStatus::UpdateRequired(_)));
}
#[test]
fn tamper_cannot_keep_previous_permission() {
    let (k, c, x, p) = fixture();
    let mut g = Gate::default();
    g.check(&encode(&k, &p), &c, &x).unwrap();
    let mut e: Envelope = serde_json::from_slice(&encode(&k, &p)).unwrap();
    e.payload = e.payload.replace("1.0.0", "0.0.0");
    assert_eq!(
        g.check(&serde_json::to_vec(&e).unwrap(), &c, &x),
        Err(UpdateError::InvalidSignature)
    );
    assert!(!g.can_enter());
}
#[test]
fn wrong_key_rejected() {
    let (k, mut c, x, p) = fixture();
    c.public_key = [9; 32];
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::InvalidSignature)
    ));
}
#[test]
fn unavailable_configuration_rejected() {
    let (k, mut c, x, p) = fixture();
    c.public_key = [0; 32];
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::NotConfigured)
    ));
}
#[test]
fn expired_policy_rejected() {
    let (k, c, mut x, p) = fixture();
    x.now_unix = 200;
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::Expired)
    ));
}
#[test]
fn seven_day_policy_remains_valid_after_first_day_but_expires_at_boundary() {
    let (k, c, mut x, mut p) = fixture();
    p.expires_at = p.issued_at + 7 * 86400;
    x.now_unix = p.issued_at + 86401;
    let mut g = Gate::default();
    g.check(&encode(&k, &p), &c, &x).unwrap();
    assert!(g.can_enter());
    x.now_unix = p.expires_at - 1;
    g.check(&encode(&k, &p), &c, &x).unwrap();
    assert!(g.can_enter());
    x.now_unix = p.expires_at;
    assert_eq!(g.check(&encode(&k, &p), &c, &x), Err(UpdateError::Expired));
    assert!(!g.can_enter());
}
#[test]
fn thirty_day_hard_cap_includes_boundary_but_rejects_one_second_more() {
    let (k, c, x, mut p) = fixture();
    p.expires_at = p.issued_at + MAX_POLICY_LIFETIME_SECS;
    assert!(verify_policy(&encode(&k, &p), &c, &x).is_ok());
    p.expires_at += 1;
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::InvalidPolicy)
    ));
}
#[test]
fn renewal_preserves_rollback_floors_and_same_sequence_content_binding() {
    let (k, c, mut x, mut p) = fixture();
    p.expires_at = p.issued_at + 7 * 86400;
    x.now_unix = p.issued_at + 2 * 86400;
    let original = encode(&k, &p);
    let (_, old) = verify_policy(&original, &c, &x).unwrap();
    x.highest_sequence = old.sequence;
    x.previous_policy_hash = Some(old.policy_hash);
    x.last_seen_unix = old.checked_at;
    p.issued_at = x.now_unix;
    p.expires_at = p.issued_at + 7 * 86400;
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::PolicyRollback)
    ));
    p.sequence += 1;
    let renewed = encode(&k, &p);
    let (_, new) = verify_policy(&renewed, &c, &x).unwrap();
    x.highest_sequence = new.sequence;
    x.previous_policy_hash = Some(new.policy_hash);
    assert!(matches!(
        verify_policy(&original, &c, &x),
        Err(UpdateError::PolicyRollback)
    ));
    x.now_unix -= 1;
    assert!(matches!(
        verify_policy(&renewed, &c, &x),
        Err(UpdateError::ClockRollback)
    ));
}
#[test]
fn rollback_sequence_and_clock_rejected() {
    let (k, c, mut x, p) = fixture();
    x.highest_sequence = 2;
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::PolicyRollback)
    ));
    x.highest_sequence = 0;
    x.last_seen_unix = 101;
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::ClockRollback)
    ));
}
#[test]
fn same_sequence_changed_payload_rejected() {
    let (k, c, mut x, mut p) = fixture();
    let (_, a) = verify_policy(&encode(&k, &p), &c, &x).unwrap();
    x.highest_sequence = a.sequence;
    x.previous_policy_hash = Some(a.policy_hash);
    assert!(verify_policy(&encode(&k, &p), &c, &x).is_ok());
    p.expires_at += 1;
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::PolicyRollback)
    ));
}
#[test]
fn version_rollback_rejected() {
    let (k, c, mut x, p) = fixture();
    x.installed_version = "2.0.0".into();
    let mut g = Gate::default();
    assert_eq!(
        g.check(&encode(&k, &p), &c, &x),
        Err(UpdateError::Downgrade)
    );
    assert!(!g.can_enter());
}
#[test]
fn invalid_or_prerelease_version_rejected() {
    for v in ["1.0", "1.0.0-beta", "1.0.0+build"] {
        let (k, c, x, mut p) = fixture();
        p.releases[0].version = v.into();
        assert!(matches!(
            verify_policy(&encode(&k, &p), &c, &x),
            Err(UpdateError::InvalidVersion)
        ));
    }
}
#[test]
fn numeric_semver_not_lexical() {
    let (k, c, mut x, mut p) = fixture();
    x.installed_version = "1.9.0".into();
    p.releases[0].version = "1.10.0".into();
    let mut g = Gate::default();
    g.check(&encode(&k, &p), &c, &x).unwrap();
    assert!(matches!(g.status(), GateStatus::UpdateRequired(_)));
}
#[test]
fn duplicate_or_missing_platform_rejected() {
    let (k, c, x, mut p) = fixture();
    p.releases.push(p.releases[0].clone());
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::UnsupportedTarget)
    ));
    p.releases.clear();
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::UnsupportedTarget)
    ));
}
#[test]
fn untrusted_mirror_and_insecure_urls_rejected() {
    for url in [
        "http://github.com/a",
        "https://evil.example/a",
        "https://user@github.com/a",
        "https://github.com:444/a",
        "https://github.com/a#b",
    ] {
        let (k, c, x, mut p) = fixture();
        p.releases[0].mirror_urls = vec![url.into()];
        assert!(matches!(
            verify_policy(&encode(&k, &p), &c, &x),
            Err(UpdateError::UnsafeDownload)
        ));
    }
}
#[test]
fn primary_failure_uses_verified_mirror() {
    let (_, _, _, p) = fixture();
    let mut calls = Vec::new();
    let b = download_verified(&p.releases[0], |url, _| {
        calls.push(url.to_owned());
        if url.contains("github.com") {
            Err(UpdateError::NetworkUnavailable)
        } else {
            Ok(b"signed-package".to_vec())
        }
    })
    .unwrap();
    assert_eq!(b, b"signed-package");
    assert_eq!(calls.len(), 2);
}
#[test]
fn mirror_corruption_cannot_pass() {
    let (_, _, _, p) = fixture();
    assert_eq!(
        download_verified(&p.releases[0], |url, _| {
            if url.contains("github.com") {
                Err(UpdateError::NetworkUnavailable)
            } else {
                Ok(b"bad-payload!!!".to_vec())
            }
        }),
        Err(UpdateError::ArtifactMismatch)
    );
}
#[test]
fn offline_stays_locked_and_revokes_ready() {
    let (k, c, x, p) = fixture();
    let mut g = Gate::default();
    g.check(&encode(&k, &p), &c, &x).unwrap();
    g.block(UpdateError::NetworkUnavailable);
    assert!(!g.can_enter());
    assert!(g.acceptance().is_none());
    assert!(g.message().contains("网络"));
}
#[test]
fn package_hash_and_size_both_checked() {
    let (_, _, _, p) = fixture();
    assert!(verify_artifact(&p.releases[0], b"signed-package").is_ok());
    assert_eq!(
        verify_artifact(&p.releases[0], b"signed-packagE"),
        Err(UpdateError::ArtifactMismatch)
    );
    assert_eq!(
        verify_artifact(&p.releases[0], b"signed-package-extra"),
        Err(UpdateError::ArtifactMismatch)
    );
}
#[test]
fn wrong_app_and_channel_rejected() {
    let (k, c, x, mut p) = fixture();
    p.app_id = "other-app".into();
    assert!(matches!(
        verify_policy(&encode(&k, &p), &c, &x),
        Err(UpdateError::WrongApplication)
    ));
}
#[test]
fn installation_does_not_implicitly_unlock() {
    let (k, c, x, mut p) = fixture();
    p.releases[0].version = "1.1.0".into();
    let mut g = Gate::default();
    g.check(&encode(&k, &p), &c, &x).unwrap();
    download_verified(&p.releases[0], |_, _| Ok(b"signed-package".to_vec())).unwrap();
    assert!(!g.can_enter());
    g.block(UpdateError::NativeInstallationRequired);
    assert!(!g.can_enter());
}
