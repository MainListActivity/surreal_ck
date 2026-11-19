//! 协同界面的线框图标，随控件着色；不是示例内容。
use nsh_core::{element::ImageSrc, prelude::*};

#[derive(Clone, Copy, Debug)]
pub enum Icon {
    Chat,
    Video,
    People,
    Gear,
    Send,
    Search,
    Link,
    Warning,
}

impl Icon {
    pub fn markup(self, stroke: &str) -> String {
        let body = match self {
            Icon::Chat => {
                r#"<path d="M6 7.2c0-.9.7-1.7 1.7-1.7h8.6c.9 0 1.7.8 1.7 1.7v6.6c0 .9-.8 1.7-1.7 1.7H11L7.2 18v-2.5H7.7c-.9 0-1.7-.8-1.7-1.7V7.2Z"/>"#
            }
            Icon::Video => {
                r#"<rect x="3.8" y="7" width="11.2" height="10" rx="1.8"/><path d="M15 9.8 20 7.6v8.8L15 14.2Z"/>"#
            }
            Icon::People => {
                r#"<circle cx="9" cy="8.2" r="2.4"/><path d="M4.6 17.4c.4-2.6 2.3-4.2 4.4-4.2s4 1.6 4.4 4.2"/><circle cx="16.2" cy="9" r="2"/><path d="M14.8 17.4c.3-1.8 1.5-3.2 3.1-3.4 1.6.3 2.8 1.6 3.1 3.4"/>"#
            }
            Icon::Gear => {
                r#"<circle cx="12" cy="12" r="3"/><path d="M12 4.6v1.8M12 17.6v1.8M4.6 12h1.8M17.6 12h1.8M6.8 6.8l1.3 1.3M15.9 15.9l1.3 1.3M17.2 6.8l-1.3 1.3M8.1 15.9l-1.3 1.3"/>"#
            }
            Icon::Send => {
                r#"<path d="M4.5 11.6 19 5.5 14.2 19.2l-2.6-5.3Z"/><path d="M11.6 13.9 19 5.5"/>"#
            }
            Icon::Search => r#"<circle cx="11" cy="11" r="6"/><path d="m19.5 19.5-4.2-4.2"/>"#,
            Icon::Link => {
                r#"<path d="M10.5 13.5a3.6 3.6 0 0 0 5.2.3l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2"/><path d="M13.5 10.5a3.6 3.6 0 0 0-5.2-.3l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/>"#
            }
            Icon::Warning => {
                r#"<path d="M12 5.2 20.2 19H3.8L12 5.2Z"/><path d="M12 10v4.2M12 16.6h.1"/>"#
            }
        };
        format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="{stroke}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">{body}</svg>"##
        )
    }

    pub fn src(self, stroke: &str) -> ImageSrc {
        ImageSrc::svg_markup(&self.markup(stroke))
    }

    pub fn view(self, stroke: &'static str, size: f32) -> impl IntoElement {
        image(self.src(stroke)).w(px(size)).h(px(size))
    }
}

/// 深色线条：用于金色底或浅色卡片上的图标。
pub const INK: &str = "#161513";
/// 中性灰线条：未选中的导航与说明图标，在明暗背景上都可辨认。
pub const MUTED: &str = "#8F8A82";
