//! 只检查实际平台绘制源码与官方系统绑定；没有 NSH stub，不代表整个 NSH 宿主通过。
#![allow(dead_code)]
pub use surreal_ck_native_video_view::{subscribe, FrameReceiver, FrameUpdate, RgbaFrame};
#[cfg(all(target_os = "macos", feature = "macos-appkit"))]
#[path = "../../src/appkit.rs"]
mod appkit;
#[path = "../../src/backend.rs"]
mod backend;
#[cfg(all(target_os = "windows", feature = "windows-d2d"))]
#[path = "../../src/direct2d.rs"]
mod direct2d;
#[cfg(all(target_os = "windows", feature = "windows-d2d"))]
#[path = "../../src/redraw.rs"]
mod redraw;
