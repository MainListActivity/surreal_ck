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
