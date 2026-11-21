//! 应用自己的控件风格；页面不重复定义颜色，颜色统一取自 theme.json 的语义角色。
pub mod icons;
pub mod meeting;

/// 左侧图标导航的总宽度。
pub const RAIL_WIDTH: f32 = 76.0;
/// 导航项尺寸：图标在上、短标签在下。
pub const RAIL_NAV: f32 = 58.0;
pub const RAIL_BRAND: f32 = 40.0;
/// 消息页会话栏宽度，其余空间给聊天内容。
pub const SESSION_COLUMN: f32 = 300.0;
/// 设置、通讯录、会议等内容页的最大宽度，避免长行。
pub const CONTENT_MAX: f32 = 760.0;
/// 半透明品牌金，叠在明暗背景上都能表达「我发出的」和「已选中」。
pub const GOLD_TINT: u32 = 0xF5C54238;

use nsh_base::{button, input, theme};
use nsh_core::{element::ImageSrc, prelude::*};

use self::icons::{INK, Icon, MUTED};

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
        .py_2()
        .rounded(px(8.0))
        .bg(move || theme().primary)
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.4))
        .child(
            text(label)
                .text_size(px(14.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || theme().primary_foreground),
        )
}

pub fn field(value: Signal<String>, placeholder: &'static str) -> impl IntoElement {
    input()
        .value(move || value.get())
        .on_change(move |s: &str| value.set(s.to_owned()))
        .placeholder(placeholder)
        .flex_1()
        .px_3()
        .py_2()
        .border_1()
        .border_color(move || theme().input)
        .rounded(px(8.0))
        .bg(move || theme().card)
        .text_color(move || theme().foreground)
        .text_size(px(15.0))
}

/// 带放大镜图标的搜索框。
pub fn search_field(value: Signal<String>, placeholder: &'static str) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap_2()
        .px_3()
        .rounded(px(8.0))
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().card)
        .child(Icon::Search.view(MUTED, 16.0))
        .child(
            input()
                .value(move || value.get())
                .on_change(move |s: &str| value.set(s.to_owned()))
                .placeholder(placeholder)
                .flex_1()
                .py_2()
                .text_color(move || theme().foreground)
                .text_size(px(14.0)),
        )
}

/// 手写桌面入口没有NSH打包器的asset_base，内嵌同一原始SVG以免品牌图消失。
/// 由原生SVG图像解码器渲染，不使用WebView或网络资源。
/// 预览入口改用 brand_mark；正式更新门闩仍使用此函数。
#[cfg_attr(feature = "github-manual-updates", allow(dead_code))]
pub fn brand() -> ImageSrc {
    ImageSrc::svg_markup(include_str!("../../assets/brand.svg"))
}

/// 品牌标：与 brand.svg 相同的 Logo.svelte 几何，提高内禀尺寸以免缩小平铺发糊。
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
        .px_2()
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

/// 导航项：线框图标在上、短标签在下；选中为金色圆角块。
/// 可访问名称即标签文字，桌面侧栏与窄屏底栏共用。
pub fn nav_item(
    label: &'static str,
    icon: Icon,
    selected: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .accessibility_label(label)
        .on_press(press)
        .w(px(RAIL_NAV))
        .py_2()
        .gap_1()
        .items_center()
        .justify_center()
        .rounded(px(12.0))
        // 不设 .selected()：平台层会为 a11y selected 状态绘制系统选中色块
        // （GTK/macos 均把 :selected 渲染成深色系统色，压住元素自定义 bg），
        // 选中态完全由显式样式表达——金色圆角块 + 深色图标与文字。
        .bg(move || {
            if selected() {
                theme().primary
            } else {
                rgba(0x00000000).to_hsla().into()
            }
        })
        .hover(|s| s.opacity(0.85))
        .active(|s| s.opacity(0.65))
        .child(
            image(move || icon.src(if selected() { INK } else { MUTED }))
                .w(px(22.0))
                .h(px(22.0)),
        )
        .child(
            text(label)
                .text_size(px(11.0))
                .text_color(move || nav_label(selected())),
        )
}

fn nav_label(selected: bool) -> AdaptiveColor {
    if selected {
        theme().primary_foreground
    } else {
        theme().muted_foreground
    }
}

fn emphasis(on: bool) -> AdaptiveColor {
    if on {
        theme().foreground
    } else {
        theme().muted_foreground
    }
}

/// 分段控件中的一项：选中项是浮起的卡片色，轨道由调用方用 segment_track 提供。
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
        .px_3()
        .py_1()
        .rounded(px(7.0))
        .hover(|s| s.opacity(0.85))
        .selected_style(|s| s.bg(theme().card))
        .child(
            text(label)
                .text_size(px(13.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || emphasis(selected())),
        )
}

/// 分段控件的轨道。
pub fn segment_track() -> View {
    view()
        .flex_row()
        .p_1()
        .gap_1()
        .rounded(px(9.0))
        .bg(move || theme().muted)
}

/// 次要按钮，例如取消、返回。
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
        .py_2()
        .rounded(px(8.0))
        .border_1()
        .border_color(move || theme().input)
        .bg(move || theme().card)
        .hover(|s| s.opacity(0.85))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.4))
        .child(
            text(label)
                .text_size(px(14.0))
                .text_color(move || theme().foreground),
        )
}

/// 危险操作的次要按钮：红字描边，不使用整块红底以免喧宾夺主。
pub fn danger(
    label: &'static str,
    disabled: impl Fn() -> bool + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .on_press(press)
        .self_start()
        .px_3()
        .py_1()
        .rounded(px(8.0))
        .border_1()
        .border_color(move || theme().destructive)
        .hover(|s| s.opacity(0.85))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.4))
        .child(
            text(label)
                .text_size(px(13.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || theme().destructive),
        )
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
        .w(px(40.0))
        .h(px(36.0))
        .items_center()
        .justify_center()
        .rounded(px(8.0))
        .bg(move || theme().primary)
        .hover(|s| s.opacity(0.9))
        .active(|s| s.opacity(0.65))
        .disabled_style(|s| s.opacity(0.35))
        .child(Icon::Send.view(INK, 18.0))
}

/// 紧凑预览徽标，不做成通栏横幅。
pub fn badge(label: &'static str) -> impl IntoElement {
    view()
        .px_2()
        .py_1()
        .rounded(px(6.0))
        .bg(move || theme().accent)
        .child(
            text(label)
                .text_size(px(11.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || theme().accent_foreground),
        )
}

pub fn page_title(label: &'static str) -> impl IntoElement {
    text(label)
        .text_size(px(22.0))
        .font_weight(FontWeight::BOLD)
        .text_color(move || theme().foreground)
}

/// 内容页标题区：标题加一行说明。
pub fn page_header(
    title: &'static str,
    subtitle: impl Fn() -> String + 'static,
) -> impl IntoElement {
    view()
        .gap_1()
        .child(page_title(title))
        .child(note(subtitle))
}

/// 分组小标题，例如「进行中」「关于」。
pub fn section_label(label: &'static str) -> impl IntoElement {
    text(label)
        .text_size(px(12.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(move || theme().muted_foreground)
}

/// 浮起的卡片容器：设置分组、会议入口等。调用方继续追加子元素。
pub fn card() -> View {
    view()
        .gap_3()
        .p_4()
        .rounded(px(12.0))
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().card)
}

/// 卡片里的一行：左侧标题与说明，右侧放控件。
pub fn card_row(
    title: impl Fn() -> String + 'static,
    detail: impl Fn() -> String + 'static,
) -> View {
    view().flex_row().items_center().gap_3().child(
        view()
            .flex_1()
            .gap_1()
            .child(
                text(title)
                    .text_size(px(15.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(move || theme().foreground),
            )
            .child(note(detail)),
    )
}

/// 带图标的大入口卡片：会议首页的「开始新会议」「加入会议」。
pub fn entry_card(
    icon: Icon,
    highlighted: bool,
    title: &'static str,
    detail: impl Fn() -> String + 'static,
) -> View {
    view()
        .flex_1()
        .min_w(px(240.0))
        .flex_row()
        .gap_3()
        .p_4()
        .rounded(px(12.0))
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().card)
        .child(
            view()
                .w(px(44.0))
                .h(px(44.0))
                .rounded(px(12.0))
                .items_center()
                .justify_center()
                .bg(move || {
                    if highlighted {
                        theme().primary
                    } else {
                        theme().muted
                    }
                })
                .child(icon.view(INK, 22.0)),
        )
        .child(
            view()
                .flex_1()
                .gap_1()
                .child(
                    text(title)
                        .text_size(px(16.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(move || theme().foreground),
                )
                .child(note(detail)),
        )
}

/// 空状态：图标、标题和一句说明，居中放置。
pub fn empty_state(
    icon: Icon,
    title: impl Fn() -> String + 'static,
    body: impl Fn() -> String + 'static,
) -> View {
    view()
        .items_center()
        .justify_center()
        .gap_2()
        .p(px(24.0))
        .child(
            view()
                .w(px(48.0))
                .h(px(48.0))
                .rounded(px(14.0))
                .items_center()
                .justify_center()
                .bg(move || theme().muted)
                .child(icon.view(MUTED, 24.0)),
        )
        .child(
            text(title)
                .text_size(px(15.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_center()
                .text_color(move || theme().foreground),
        )
        .child(
            text(body)
                .text_size(px(13.0))
                .text_center()
                .text_color(move || theme().muted_foreground),
        )
}

/// 圆形头像：只显示真实名称的首字，不生成示例人像。
pub fn avatar(initial: impl Fn() -> String + 'static, size: f32) -> impl IntoElement {
    view()
        .w(px(size))
        .h(px(size))
        .rounded_full()
        .items_center()
        .justify_center()
        .bg(move || theme().accent)
        .child(
            text(initial)
                .text_size(px((size * 0.4).round()))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(move || theme().accent_foreground),
        )
}

/// 状态点加文字，状态不只依赖颜色。
pub fn status_dot(
    label: impl Fn() -> String + 'static,
    alert: impl Fn() -> bool + Copy + 'static,
) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap_2()
        .child(view().w(px(8.0)).h(px(8.0)).rounded_full().bg(move || {
            if alert() {
                theme().destructive
            } else {
                theme().input
            }
        }))
        .child(note(label))
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
                .text_color(rgb(0x161513).to_hsla()),
        )
}
