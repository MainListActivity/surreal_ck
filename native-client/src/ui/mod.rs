//! 应用自己的控件风格；页面不重复定义颜色。
pub mod icons;

use nsh_base::{button, input, theme};
use nsh_core::{element::ImageSrc, prelude::*};

use self::icons::{INK, Icon, PAPER};

pub fn action(
    label: &'static str,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .on_press(press)
        .self_start()
        .px_4()
        .py_3()
        .rounded(move || theme().radius)
        .bg(move || theme().primary)
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.4))
        .child(text(label).text_color(move || theme().primary_foreground))
}

pub fn field(value: Signal<String>, placeholder: &'static str) -> impl IntoElement {
    input()
        .value(move || value.get())
        .on_change(move |s: &str| value.set(s.to_owned()))
        .placeholder(placeholder)
        .flex_1()
        .px_4()
        .py_3()
        .border_1()
        .border_color(move || theme().input)
        .rounded(px(10.0))
        .text_color(move || theme().foreground)
        .text_size(px(15.0))
}

/// 手写桌面入口没有NSH打包器的asset_base，内嵌同一原始SVG以免品牌图消失。
/// 由原生SVG图像解码器渲染，不使用WebView或网络资源。
/// 预览入口改用 brand_mark；正式更新门闩仍使用此函数。
#[cfg_attr(feature = "github-manual-updates", allow(dead_code))]
pub fn brand() -> ImageSrc {
    ImageSrc::svg_markup(include_str!("../../assets/brand.svg"))
}

/// 侧栏品牌标：与 brand.svg 相同的 Logo.svelte 几何，提高内禀尺寸以免缩小平铺发糊。
pub fn brand_mark(size: f32) -> impl IntoElement {
    let markup = include_str!("../../assets/brand.svg")
        .replace(r#"width="64" height="64""#, r#"width="256" height="256""#);
    view()
        .w(px(size))
        .h(px(size))
        .rounded(px((size * 15.0 / 64.0).round()))
        .overflow_hidden()
        .child(image(ImageSrc::svg_markup(&markup)).w(px(size)).h(px(size)))
}

/// 消息输入框：回车即提交，保证仅用键盘即可发送。
pub fn composer(
    value: Signal<String>,
    placeholder: &'static str,
    submit: impl Fn() + 'static,
) -> impl IntoElement {
    input()
        .value(move || value.get())
        .on_change(move |s: &str| value.set(s.to_owned()))
        .on_submit(move |_: &str| submit())
        .placeholder(placeholder)
        .flex_1()
        .px_3()
        .py_2()
        .text_color(move || theme().foreground)
        .text_size(px(15.0))
}

/// 次要说明文字。
pub fn note(content: impl Fn() -> String + 'static) -> impl IntoElement {
    text(content)
        .text_size(px(13.0))
        .text_color(move || theme().muted_foreground)
}

#[cfg_attr(not(feature = "github-manual-updates"), allow(dead_code))]
/// 单选项：只改变选择，不触发任何网络请求。文字前缀标明选中状态，不只依赖颜色。
pub fn radio(
    label: &'static str,
    selected: impl Fn() -> bool + Copy + 'static,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .on_press(press)
        .px_3()
        .py_2()
        .border_1()
        .border_color(move || {
            if selected() {
                theme().primary
            } else {
                theme().border
            }
        })
        .rounded(move || theme().radius)
        .disabled_style(|s| s.opacity(0.4))
        .child(text(move || {
            format!("{} {label}", if selected() { "◉" } else { "○" })
        }))
}

/// 左侧图标导航：选中为金色圆角方块，可访问名称是产品文案。
pub fn nav_item(
    label: &'static str,
    icon: Icon,
    selected: impl Fn() -> bool + Copy + 'static,
    on_dark: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .accessibility_label(label)
        .selected(selected)
        .on_press(press)
        .w(px(48.0))
        .h(px(48.0))
        .items_center()
        .justify_center()
        .rounded(px(12.0))
        .bg(move || {
            if selected() {
                rgb(0xF5C542).to_hsla()
            } else if on_dark() {
                rgb(0x161513).to_hsla()
            } else {
                rgba(0x00000000).to_hsla()
            }
        })
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .selected_style(|s| s.bg(theme().primary))
        .child(
            image(move || icon.src(if selected() || !on_dark() { INK } else { PAPER }))
                .w(px(22.0))
                .h(px(22.0)),
        )
}

/// 会话筛选或共享目标的选择条。
pub fn chip(
    label: &'static str,
    selected: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .selected(selected)
        .on_press(press)
        .px_4()
        .py_2()
        .rounded(px(10.0))
        .bg(move || {
            if selected() {
                theme().primary
            } else {
                theme().muted
            }
        })
        .hover(|s| s.opacity(0.9))
        .selected_style(|s| s.bg(theme().primary))
        .child(
            text(label)
                .text_size(px(14.0))
                .text_color(move || theme().foreground),
        )
}

/// 分段控件中的一项，在轨道内均分宽度。
pub fn segment(
    label: &'static str,
    selected: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .selected(selected)
        .on_press(press)
        .flex_1()
        .items_center()
        .justify_center()
        .px_4()
        .py_2()
        .rounded(px(10.0))
        .bg(move || {
            if selected() {
                rgb(0xF5C542).to_hsla()
            } else {
                rgba(0x00000000).to_hsla()
            }
        })
        .hover(|s| s.opacity(0.9))
        .selected_style(|s| s.bg(theme().primary))
        .child(
            text(label)
                .text_size(px(14.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || theme().foreground),
        )
}

/// 次要按钮，例如取消。
pub fn secondary(
    label: &'static str,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .on_press(press)
        .self_start()
        .px_4()
        .py_3()
        .rounded(move || theme().radius)
        .border_1()
        .border_color(move || theme().border)
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.4))
        .child(text(label).text_color(move || theme().foreground))
}

/// 深色顶栏上的次要按钮。
pub fn secondary_on_dark(
    label: &'static str,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .on_press(press)
        .self_start()
        .px_3()
        .py_2()
        .rounded(move || theme().radius)
        .border_1()
        .border_color(rgb(0x3B3832).to_hsla())
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.4))
        .child(
            text(label)
                .text_size(px(13.0))
                .text_color(rgb(0xFAF9F6).to_hsla()),
        )
}

/// 会议坞按钮：图标 + 标签；危险操作用红色，不假装正在开会。
pub fn dock_item(
    label: &'static str,
    icon: Icon,
    kind: DockKind,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    let (bg, fg) = match kind {
        DockKind::Normal => (rgb(0x2A2825).to_hsla(), PAPER),
        DockKind::Danger => (rgb(0xD14B4B).to_hsla(), PAPER),
    };
    button()
        .accessibility_label(label)
        .disabled(disabled)
        .on_press(press)
        .px_4()
        .py_3()
        .gap_1()
        .items_center()
        .rounded(px(12.0))
        .bg(bg)
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.45))
        .child(icon.view(fg, 18.0))
        .child(
            text(label)
                .text_size(px(13.0))
                .text_color(rgb(0xFAF9F6).to_hsla()),
        )
}

#[derive(Clone, Copy)]
pub enum DockKind {
    Normal,
    Danger,
}

/// 会议顶栏中禁用的工具按钮。
pub fn toolbar_item(
    label: &'static str,
    icon: Icon,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .accessibility_label(label)
        .disabled(disabled)
        .on_press(press)
        .px_3()
        .py_2()
        .gap_1()
        .flex_row()
        .items_center()
        .rounded(px(10.0))
        .border_1()
        .border_color(rgb(0x3B3832).to_hsla())
        .disabled_style(|s| s.opacity(0.45))
        .child(icon.view(PAPER, 16.0))
        .child(
            text(label)
                .text_size(px(13.0))
                .text_color(rgb(0xFAF9F6).to_hsla()),
        )
}

/// 图标按钮：附件、表情、关闭等。禁用时不得假装可用。
pub fn icon_action(
    label: &'static str,
    icon: Icon,
    stroke: &'static str,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .accessibility_label(label)
        .disabled(disabled)
        .on_press(press)
        .w(px(36.0))
        .h(px(36.0))
        .items_center()
        .justify_center()
        .rounded(px(10.0))
        .hover(|s| s.opacity(0.85))
        .disabled_style(|s| s.opacity(0.4))
        .child(icon.view(stroke, 20.0))
}

/// 金色发送按钮，可访问名称保持「发送消息」。
pub fn send_control(
    label: &'static str,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .accessibility_label(label)
        .disabled(disabled)
        .on_press(press)
        .w(px(44.0))
        .h(px(44.0))
        .items_center()
        .justify_center()
        .rounded(px(12.0))
        .bg(move || theme().primary)
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.4))
        .child(Icon::Send.view(INK, 20.0))
}

/// 紧凑预览徽标，不做成通栏横幅。
pub fn badge(label: &'static str) -> impl IntoElement {
    view()
        .px_2()
        .py_1()
        .rounded(px(8.0))
        .bg(move || theme().primary)
        .child(
            text(label)
                .text_size(px(12.0))
                .text_color(move || theme().primary_foreground),
        )
}

pub fn page_title(label: &'static str) -> impl IntoElement {
    text(label)
        .text_size(px(24.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(move || theme().foreground)
}

/// 参会人或共享源的空槽，不含头像或缩略图。
pub fn empty_tile(min_h: f32) -> impl IntoElement {
    view()
        .flex_1()
        .min_h(px(min_h))
        .rounded(px(10.0))
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().muted)
}

pub fn empty_tile_dark(min_h: f32) -> impl IntoElement {
    view()
        .flex_1()
        .min_h(px(min_h))
        .rounded(px(10.0))
        .bg(rgb(0x2A2825).to_hsla())
}

pub fn warning_card(message: &'static str) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .p_3()
        .rounded(px(10.0))
        .bg(rgb(0xF8EFC6).to_hsla())
        .child(Icon::Warning.view(INK, 18.0))
        .child(
            text(message)
                .flex_1()
                .text_size(px(13.0))
                .text_color(move || theme().foreground),
        )
}
