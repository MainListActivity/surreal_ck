fn main() {
    println!("cargo:rerun-if-env-changed=SPARKLE_FRAMEWORK_DIR");
    println!("cargo:rerun-if-changed=macos/CKUpdater.m");
    println!("cargo:rerun-if-changed=macos/CKUpdater.h");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos")
        || std::env::var_os("CARGO_FEATURE_MACOS_SPARKLE").is_none()
    {
        return;
    }
    let framework = std::env::var("SPARKLE_FRAMEWORK_DIR")
        .expect("macos-sparkle requires a locally verified Sparkle.framework parent directory");
    assert!(
        std::path::Path::new(&framework).is_absolute(),
        "framework path must be absolute"
    );
    assert!(
        std::path::Path::new(&framework)
            .join("Sparkle.framework/Headers/Sparkle.h")
            .is_file(),
        "Sparkle headers missing"
    );
    cc::Build::new()
        .file("macos/CKUpdater.m")
        .flag("-fobjc-arc")
        .flag("-fblocks")
        .flag("-Wall")
        .flag("-Wextra")
        .flag("-Wno-unused-parameter")
        .flag("-Werror")
        .flag(format!("-F{framework}"))
        .compile("ck_required_updater");
    println!("cargo:rustc-link-search=framework={framework}");
    for framework in ["Sparkle", "Foundation", "Security", "AppKit"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
}
