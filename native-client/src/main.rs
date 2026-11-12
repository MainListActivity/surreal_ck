//! Runs the Rust application directly on the machine's native backend.

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use nsh_platform_linux as platform;
#[cfg(target_os = "macos")]
use nsh_platform_macos as platform;
#[cfg(target_os = "windows")]
use nsh_platform_windows as platform;

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn main() -> impl std::process::Termination {
    // helper入口必须早于NSH、日志或任何业务初始化；生成runner未接此入口会拒绝更新。
    #[cfg(all(target_os = "windows", feature = "windows-auto-update"))]
    if let Some(result) = surreal_ck_native_updater_platform::windows::dispatch_helper() {
        let code = if result.is_ok() { 0 } else { 1 };
        if let Err(error) = result {
            eprintln!("更新交接失败：{error}");
        }
        std::process::exit(code);
    }
    env_logger::init();
    #[cfg(target_os = "linux")]
    platform::set_components(surreal_ck_native_video_view::linux::register);
    #[cfg(all(target_os = "macos", feature = "experimental-macos-video"))]
    platform::set_components(surreal_ck_native_video_view::macos::register);
    #[cfg(all(target_os = "windows", feature = "experimental-windows-video"))]
    platform::set_components(surreal_ck_native_video_view::windows::register);
    platform::run_app(
        platform::AppSource::Rust(platform::Root::of::<nsh_app_native_client::App>()),
        platform::AppOptions {
            title: "吉吉".to_owned(),
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            app_id: "top.maplayer.collaboration".to_owned(),
            size: (1100, 760),
            ..Default::default()
        },
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!(
    "Run this binary on macOS, Windows or Linux; use the native Rust root with nsh package for Android."
);
