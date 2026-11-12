//! 应用自己的控件风格；页面不重复定义颜色。
use nsh_base::{button, input, theme};
use nsh_core::{element::ImageSrc, prelude::*};

pub fn action(
    label: &'static str,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .on_press(press)
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
        .px_3()
        .py_3()
        .border_1()
        .border_color(move || theme().input)
        .rounded(move || theme().radius)
        .text_color(move || theme().foreground)
}

/// 手写桌面入口没有NSH打包器的asset_base，内嵌同一原始SVG以免品牌图消失。
/// 由原生SVG图像解码器渲染，不使用WebView或网络资源。
pub fn brand() -> ImageSrc {
    ImageSrc::svg_markup(include_str!("../../assets/brand.svg"))
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
        .py_3()
        .border_1()
        .border_color(move || theme().input)
        .rounded(move || theme().radius)
        .text_color(move || theme().foreground)
}

/// 次要说明文字。
pub fn note(content: impl Fn() -> String + 'static) -> impl IntoElement {
    text(content).text_color(move || theme().muted_foreground)
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

/// 左侧图标导航项：选中时金色底，可访问名称是产品文案而不是图标本身。
pub fn nav_item(
    label: &'static str,
    glyph: &'static str,
    selected: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .accessibility_label(label)
        .selected(selected)
        .on_press(press)
        .w(px(56.0))
        .h(px(56.0))
        .gap_1()
        .items_center()
        .justify_center()
        .rounded(move || theme().radius)
        .bg(move || {
            if selected() {
                theme().primary
            } else {
                theme().background
            }
        })
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .selected_style(|s| s.bg(theme().primary))
        .child(text(glyph).text_size(px(16.0)))
        .child(
            text(label)
                .text_size(px(11.0))
                .text_color(move || theme().foreground),
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
        .px_3()
        .py_2()
        .rounded(move || theme().radius)
        .bg(move || {
            if selected() {
                theme().primary
            } else {
                theme().muted
            }
        })
        .hover(|s| s.opacity(0.9))
        .selected_style(|s| s.bg(theme().primary))
        .child(text(label).text_color(move || theme().foreground))
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

/// 会议坞按钮：禁用时仍显示名称和原因，不假装正在开会。
pub fn dock_item(
    label: &'static str,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .on_press(press)
        .px_4()
        .py_3()
        .rounded(move || theme().radius)
        .bg(rgb(0x2A2825).to_hsla())
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.45))
        .child(text(label).text_color(rgb(0xFAF9F6).to_hsla()))
}

/// 紧凑预览徽标，不做成通栏横幅。
pub fn badge(label: &'static str) -> impl IntoElement {
    view()
        .px_2()
        .py_1()
        .rounded(move || theme().radius)
        .bg(move || theme().primary)
        .child(
            text(label)
                .text_size(px(12.0))
                .text_color(move || theme().primary_foreground),
        )
}
