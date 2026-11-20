//! 只验证编译 feature 的支持门闩，不创建 GUI，不替代实际平台验收。
use surreal_ck_native_video_view::rendering_supported;

#[test]
fn marker_without_a_matching_native_backend_does_not_enable_video() {
    if !cfg!(any(
        all(target_os = "linux", feature = "linux-gtk"),
        all(target_os = "macos", feature = "macos-appkit"),
        all(target_os = "windows", feature = "windows-d2d")
    )) {
        assert!(!rendering_supported());
    }
}

#[test]
fn target_policy_requires_explicit_host_optin_only_for_experimental_backends() {
    #[cfg(target_os = "linux")]
    assert_eq!(rendering_supported(), cfg!(feature = "linux-gtk"));
    #[cfg(target_os = "macos")]
    assert_eq!(
        rendering_supported(),
        cfg!(feature = "macos-appkit") && cfg!(feature = "experimental-host")
    );
    #[cfg(target_os = "windows")]
    assert_eq!(
        rendering_supported(),
        cfg!(feature = "windows-d2d") && cfg!(feature = "experimental-host")
    );
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    assert!(!rendering_supported());
}
