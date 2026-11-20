//! 桌面真实采集、WebRTC 与原生解码的生命周期协调。默认不访问任何设备或播放声音。
//! Android 必须使用其权限、MediaCodec/Surface 桥接，不能调用桌面 FFmpeg 路径。
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod desktop;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub use desktop::*;

/// 平台检查可用于宿主禁用尚未实现的入口，不能用静默空实现冒充可用。
pub const fn supported() -> bool {
    cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    ))
}

#[cfg(target_os = "android")]
pub mod android;
#[cfg(target_os = "android")]
pub use android::{AndroidCall, AndroidCallState};
