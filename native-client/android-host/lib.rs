// 与NSH0.4生成的Rust-root宿主等价，明确开启实验更新桥并保留JNI符号。
#[cfg(target_os = "android")]
nsh::ui_sets!(vec![nsh_base::registry(), app::__nsh_native_module()]);
#[cfg(target_os = "android")]
nsh::main!(app_root());
#[cfg(target_os = "android")]
fn app_root() -> nsh_core::element::Root {
    app::android_documents::ensure_linked();
    #[cfg(feature = "android-native-oauth")]
    app::android_oauth::ensure_linked();
    #[cfg(feature = "android-native-media")]
    app::ensure_android_media_linked();
    // 显式引用初始化函数，避免rlib链接时丢弃Provider调用的JNI导出。
    std::hint::black_box(surreal_ck_native_updater_platform::android::Java_top_maplayer_collaboration_update_UpdaterInitProvider_initialize as *const () as usize);
    nsh_core::element::Root::of::<app::App>()
        .tokens(
            nsh_base::Theme::from_json(include_str!("../theme.json"))
                .expect("theme")
                .into_tokens(),
        )
        .app_id("top.maplayer.collaboration")
}
#[cfg(not(target_os = "android"))]
compile_error!("This host is only for Android; use aarch64-linux-android or x86_64-linux-android.");
