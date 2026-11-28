fn main() {
    println!("cargo:rerun-if-env-changed=SURREAL_UPDATE_CONFIG_JSON");
    println!("cargo:rustc-check-cfg=cfg(manual_update_preview)");
    // 平台更新桥或嵌入信任配置都要求走强制更新，优先于可叠加的预览 feature。
    let mandatory_updates = [
        "CARGO_FEATURE_MACOS_AUTO_UPDATE",
        "CARGO_FEATURE_WINDOWS_AUTO_UPDATE",
        "CARGO_FEATURE_ANDROID_AUTO_UPDATE",
        "SURREAL_UPDATE_CONFIG_JSON",
    ]
    .into_iter()
    .any(|name| std::env::var_os(name).is_some());
    if std::env::var_os("CARGO_FEATURE_GITHUB_MANUAL_UPDATES").is_some() && !mandatory_updates {
        println!("cargo:rustc-cfg=manual_update_preview");
    }
}
