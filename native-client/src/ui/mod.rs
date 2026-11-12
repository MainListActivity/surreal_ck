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
