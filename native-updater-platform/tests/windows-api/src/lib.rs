// 直接引用生产源码；不复制实现、不伪造Windows API类型。
#[cfg(target_os = "windows")]
#[path = "../../../src/windows.rs"]
pub mod windows;
#[path = "../../../src/windows_protocol.rs"]
pub mod windows_protocol;

/// Compile the complete host-facing call shape against the actual Windows module.
/// This is not executed and is not a replacement for compiling the NSH client.
#[cfg(target_os = "windows")]
pub fn check_host_api(
    old_version: &str,
    target_version: &str,
    bytes: &[u8],
    sha256: &str,
    publisher: &str,
) -> std::io::Result<()> {
    let handoff: windows::Handoff = windows::prepare(windows::VerifiedUpdate {
        old_version,
        target_version,
        bytes,
        sha256,
        publisher,
    })?;
    handoff.arm_for_exit()
}
