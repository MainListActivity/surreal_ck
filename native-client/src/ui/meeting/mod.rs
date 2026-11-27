//! 原生会议的独立视图契约；不持有信令、身份或媒体句柄。
// 待集成包 F 接线。
#![allow(dead_code)]

pub mod mock;
mod model;
mod page;
#[cfg(all(
    feature = "experimental-enterprise-meeting",
    any(target_os = "linux", target_os = "macos", target_os = "windows")
))]
mod prejoin;
pub use model::*;
// 待集成包 F 接线。
#[allow(unused_imports)]
pub use page::{
    VideoSlot, meeting_page, meeting_page_in_shell, mini_bar, placeholder_video, privacy_controls,
};

#[cfg(test)]
mod tests;
