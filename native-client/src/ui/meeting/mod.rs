//! 原生会议的独立视图契约；不持有信令、身份或媒体句柄。
// 待集成包 F 接线。
#![allow(dead_code)]

pub mod mock;
mod model;
mod page;
pub use model::*;
// 待集成包 F 接线。
#[allow(unused_imports)]
pub use page::{VideoSlot, meeting_page, placeholder_video};

#[cfg(test)]
mod tests;
