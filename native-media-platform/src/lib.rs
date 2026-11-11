//! 原生平台媒体适配。不会自动请求权限或启动设备；UI 必须由用户明确操作触发。
#[cfg(any(target_os = "android", test))]
pub mod android;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub mod desktop;
#[cfg(target_os = "linux")]
pub mod linux;
