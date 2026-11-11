//! 真实 NSH 0.4 注册契约；不初始化 GUI、不调用工厂、不读取媒体设备。
//! 与仅检查系统绘制 API 的 platform-api 不同，本测试依赖完整平台 crate。
#![cfg(any(
    all(target_os = "linux", feature = "linux-gtk"),
    all(target_os = "macos", feature = "macos-appkit"),
    all(target_os = "windows", feature = "windows-d2d")
))]

#[cfg(all(target_os = "linux", feature = "linux-gtk"))]
use nsh_platform_linux as host;
#[cfg(all(target_os = "macos", feature = "macos-appkit"))]
use nsh_platform_macos as host;
#[cfg(all(target_os = "windows", feature = "windows-d2d"))]
use nsh_platform_windows as host;

#[cfg(all(target_os = "linux", feature = "linux-gtk"))]
use surreal_ck_native_video_view::linux as renderer;
#[cfg(all(target_os = "macos", feature = "macos-appkit"))]
use surreal_ck_native_video_view::macos as renderer;
#[cfg(all(target_os = "windows", feature = "windows-d2d"))]
use surreal_ck_native_video_view::windows as renderer;

// 必须位于 integration-test crate 根，和发行 app 根 lib.rs 的位置相同。
#[cfg_attr(target_os = "linux", nsh_core::element::native_components(linux))]
#[cfg_attr(target_os = "macos", nsh_core::element::native_components(macos))]
#[cfg_attr(target_os = "windows", nsh_core::element::native_components(windows))]
fn register_video(components: &renderer::Components) {
    renderer::register(components);
}

#[cfg(target_os = "linux")]
use __nsh_native_components_linux as generated_register;
#[cfg(target_os = "macos")]
use __nsh_native_components_macos as generated_register;
#[cfg(target_os = "windows")]
use __nsh_native_components_windows as generated_register;

#[test]
fn generated_root_entry_registers_exact_native_name_without_opening_a_window() {
    let components = host::Components::default();
    let earlier_clone = components.clone();
    let other_host = host::Components::default();
    assert_eq!(format!("{components:?}"), "{}");
    generated_register(&components);
    let expected = format!("{{{:?}}}", surreal_ck_native_video_view::COMPONENT_NAME);
    assert_eq!(format!("{components:?}"), expected);
    assert_eq!(format!("{earlier_clone:?}"), expected);
    assert_eq!(format!("{other_host:?}"), "{}");
    // 重复注册替换同名工厂，不增加组件名，也不构造原生视图。
    generated_register(&components);
    assert_eq!(format!("{components:?}"), expected);
}

#[test]
fn explicit_main_options_use_the_same_registry_and_callback_types() {
    let components = host::Components::default();
    renderer::register(&components);
    let options = host::AppOptions {
        components,
        ..Default::default()
    };
    assert!(
        format!("{:?}", options.components).contains(surreal_ck_native_video_view::COMPONENT_NAME)
    );
    // 只验证全局 setup 的签名，不实际修改进程级设置或运行事件循环。
    let _: fn(fn(&host::Components)) = host::set_components;
    let _: fn(&host::Components) = renderer::register;
    let _: fn(&host::Components) = generated_register;
}

#[test]
fn context_is_thread_safe_and_experimental_renderers_require_host_optin() {
    fn send_sync<T: Send + Sync + 'static>() {}
    send_sync::<host::ComponentContext>();
    assert_eq!(
        surreal_ck_native_video_view::rendering_supported(),
        cfg!(all(target_os = "linux", feature = "linux-gtk"))
            || cfg!(all(
                feature = "experimental-host",
                any(target_os = "macos", target_os = "windows")
            ))
    );
}
