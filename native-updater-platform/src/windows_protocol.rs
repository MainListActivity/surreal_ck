//! 平台无关的Windows交接协议。没有Ready状态；COMMITTED只要求旧进程退出。
use serde::{Deserialize, Serialize};

pub const HELPER_ARG: &str = "--surreal-update-helper";
pub const STAGE_PREFIX: &str = ".SurrealCK-update-";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub old_version: String,
    pub target_version: String,
    pub parent_pid: u32,
    pub parent_created: u64,
    pub restart_exe: String,
    pub size: u64,
    pub sha256: String,
    pub publisher: String,
    pub nonce: String,
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|c| c.is_ascii_hexdigit())
}
impl Manifest {
    pub fn validate(&self) -> bool {
        valid_version(&self.old_version)
            && valid_version(&self.target_version)
            && self.old_version != self.target_version
            && self.parent_pid > 0
            && self.parent_created > 0
            && self.size > 0
            && self.size <= 1024 * 1024 * 1024
            && hex(&self.sha256, 64)
            && hex(&self.publisher, 64)
            && hex(&self.nonce, 32)
            && !self.restart_exe.contains(['\0', '\n', '\r'])
            && !self.restart_exe.is_empty()
    }
}
pub fn handshake_matches(line: &str, phase: &str, nonce: &str) -> bool {
    hex(nonce, 32)
        && matches!(phase, "READY" | "COMMITTED")
        && line.trim_end_matches(['\r', '\n']) == format!("{phase} {nonce}")
}
pub fn commit_matches(line: &str, nonce: &str) -> bool {
    hex(nonce, 32) && line.trim_end_matches(['\r', '\n']) == format!("COMMIT {nonce}")
}
pub fn is_stage_name(name: &str) -> bool {
    name.strip_prefix(STAGE_PREFIX)
        .is_some_and(|id| hex(id, 32))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handshake_is_phase_and_attempt_bound() {
        let nonce = "a".repeat(32);
        assert!(handshake_matches(
            &format!("READY {nonce}\r\n"),
            "READY",
            &nonce
        ));
        for line in [
            format!("COMMITTED {nonce}"),
            format!("READY {}", "b".repeat(32)),
            format!("READY {nonce} injected"),
            "READY".into(),
        ] {
            assert!(!handshake_matches(&line, "READY", &nonce));
        }
        assert!(!handshake_matches(
            &format!("Ready {nonce}"),
            "READY",
            &nonce
        ));
        assert!(commit_matches(&format!("COMMIT {nonce}\n"), &nonce));
        assert!(!commit_matches(&format!("COMMIT {nonce};run"), &nonce));
    }
    #[test]
    fn traversal_and_arbitrary_stage_names_fail() {
        assert!(is_stage_name(&format!("{STAGE_PREFIX}{}", "0".repeat(32))));
        for value in [
            "..",
            ".SurrealCK-update-../../other",
            "C:\\Windows",
            ".SurrealCK-update-unsigned",
        ] {
            assert!(!is_stage_name(value));
        }
    }
    #[test]
    fn malformed_manifest_never_arms() {
        let valid = Manifest {
            old_version: "1.0.0".into(),
            target_version: "2.0.0".into(),
            parent_pid: 1,
            parent_created: 1,
            restart_exe: "C:\\Users\\user\\AppData\\Local\\Programs\\SurrealCK\\app.exe".into(),
            size: 1,
            sha256: "a".repeat(64),
            publisher: "b".repeat(64),
            nonce: "c".repeat(32),
        };
        assert!(valid.validate());
        let mut bad = valid.clone();
        bad.parent_created = 0;
        assert!(!bad.validate());
        bad = valid.clone();
        bad.size = 1024 * 1024 * 1024 + 1;
        assert!(!bad.validate());
        bad = valid.clone();
        bad.publisher = "unsigned".into();
        assert!(!bad.validate());
        bad = valid.clone();
        bad.restart_exe.push('\0');
        assert!(!bad.validate());
        assert!(serde_json::from_str::<Manifest>(r#"{"unknown":true}"#).is_err());
    }
}

/// Opaque release versions are bounded here; ordering remains the signed core policy's job.
fn valid_version(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_graphic())
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub sha256: String,
    pub old_version: String,
    pub target_version: String,
    pub nonce: String,
    pub phase: String,
}
impl Attempt {
    pub fn committed(manifest: &Manifest) -> Self {
        Self {
            sha256: manifest.sha256.to_ascii_lowercase(),
            old_version: manifest.old_version.clone(),
            target_version: manifest.target_version.clone(),
            nonce: manifest.nonce.clone(),
            phase: "commit-intent".into(),
        }
    }
    pub fn matches(&self, manifest: &Manifest) -> bool {
        self == &Self::committed(manifest)
    }
}
/// Presence is deliberately fail-closed, even for a truncated record or an uncertain outcome.
/// A successful new version is admitted only by the ordinary startup gate, never this record.
pub fn may_attempt(existing_record: bool) -> bool {
    !existing_record
}
pub const MAX_STAGES: usize = 8;
pub const MAX_STAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub fn capacity_allows(stages: usize, used: u64, incoming: u64) -> bool {
    stages < MAX_STAGES
        && used
            .checked_add(incoming)
            .is_some_and(|n| n <= MAX_STAGE_BYTES)
}
#[cfg(test)]
mod attempt_tests {
    use super::*;
    #[test]
    fn unchanged_or_wrong_installed_version_never_retries_same_hash() {
        // Record presence covers installer failure, exit0 with V1, reboot/crash, and unreadable records.
        for _phase in [
            "commit-intent",
            "installed",
            "failed",
            "truncated",
            "unknown",
        ] {
            assert!(!may_attempt(true));
        }
        assert!(may_attempt(false));
    }
    #[test]
    fn orphan_stages_are_bounded_even_when_no_cleanup_can_run() {
        assert!(capacity_allows(0, 0, 1));
        assert!(!capacity_allows(MAX_STAGES, 0, 1));
        assert!(!capacity_allows(1, MAX_STAGE_BYTES, 1));
        assert!(!capacity_allows(1, u64::MAX, 2));
    }
    #[test]
    fn attempt_binds_hash_versions_and_phase() {
        let m = Manifest {
            old_version: "1".into(),
            target_version: "2".into(),
            parent_pid: 1,
            parent_created: 1,
            restart_exe: "app.exe".into(),
            size: 1,
            sha256: "a".repeat(64),
            publisher: "b".repeat(64),
            nonce: "c".repeat(32),
        };
        let a = Attempt::committed(&m);
        assert!(a.matches(&m));
        for field in ["hash", "old", "target", "phase", "nonce"] {
            let mut bad = a.clone();
            match field {
                "hash" => bad.sha256 = "d".repeat(64),
                "old" => bad.old_version = "0".into(),
                "target" => bad.target_version = "3".into(),
                "phase" => bad.phase = "installed".into(),
                _ => bad.nonce = "d".repeat(32),
            }
            assert!(!bad.matches(&m));
        }
    }
}
