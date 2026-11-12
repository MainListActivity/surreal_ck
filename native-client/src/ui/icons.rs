//! 协同界面的线框图标，随控件着色；不是示例内容。
use nsh_core::{element::ImageSrc, prelude::*};

#[derive(Clone, Copy, Debug)]
pub enum Icon {
    Chat,
    Video,
    People,
    Gear,
    Mic,
    Camera,
    Share,
    Leave,
    Send,
    Attach,
    Emoji,
    Layout,
    Fullscreen,
    Close,
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
            Icon::Mic => {
                r#"<rect x="9.2" y="4.5" width="5.6" height="9" rx="2.8"/><path d="M7 11.8a5 5 0 0 0 10 0M12 16.8v2.7"/>"#
            }
            Icon::Camera => {
                r#"<rect x="3.8" y="7" width="11.2" height="10" rx="1.8"/><path d="M15 9.8 20 7.6v8.8L15 14.2Z"/>"#
            }
            Icon::Share => {
                r#"<rect x="4" y="6.5" width="16" height="11" rx="1.8"/><path d="M8 17.5v2M16 17.5v2M8 19.5h8"/><path d="M12 8.8v5.2M9.6 11.2 12 8.8l2.4 2.4"/>"#
            }
            Icon::Leave => {
                r#"<path d="M8.2 15.6c1.2 1.2 2.8 2 4.8 2.2 3 .3 5.6-1.4 6.4-4.1.3-1.2-.3-2.2-1.4-2.6l-1.7-.6M7.4 9.4l-1.6-.6c-1.1-.4-1.8-1.5-1.5-2.7.7-2.6 3.4-4.4 6.4-4.1 1.6.2 3 .8 4.1 1.7"/><path d="M4 12h8.5M10 9.2 12.6 12 10 14.8"/>"#
            }
            Icon::Send => {
                r#"<path d="M4.5 11.6 19 5.5 14.2 19.2l-2.6-5.3Z"/><path d="M11.6 13.9 19 5.5"/>"#
            }
            Icon::Attach => {
                r#"<path d="M8.6 12.2 13 7.8a3.2 3.2 0 0 1 4.5 4.5l-6.2 6.2a4.2 4.2 0 0 1-6-6L11.5 6.3"/>"#
            }
            Icon::Emoji => {
                r#"<circle cx="12" cy="12" r="7.2"/><path d="M9 10.2h.1M15 10.2h.1M8.8 13.8c.8 1.6 2.1 2.4 3.2 2.4s2.4-.8 3.2-2.4"/>"#
            }
            Icon::Layout => {
                r#"<rect x="4.2" y="5.2" width="15.6" height="13.6" rx="1.6"/><path d="M4.2 9.4h15.6M13.6 9.4v9.4"/>"#
            }
            Icon::Fullscreen => {
                r#"<path d="M8 5.5H5.5V8M16 5.5h2.5V8M8 18.5H5.5V16M16 18.5h2.5V16"/>"#
            }
            Icon::Close => r#"<path d="M7 7l10 10M17 7 7 17"/>"#,
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

pub const INK: &str = "#161513";
pub const PAPER: &str = "#FAF9F6";
