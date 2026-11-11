//! 桌面发布仅运行随应用交付的工具；不搜索工作目录或用户 PATH。
use std::{
    io,
    path::{Path, PathBuf},
};

pub(super) fn executable(name: &str) -> io::Result<PathBuf> {
    if cfg!(target_os = "linux") {
        // Linux 安装约定仍明确要求发行版 FFmpeg；不冒充自包含发行包。
        return Ok(PathBuf::from(name));
    }
    resolve(&std::env::current_exe()?, std::env::consts::OS, name)
}

fn resolve(app: &Path, platform: &str, name: &str) -> io::Result<PathBuf> {
    if !matches!(name, "ffmpeg" | "ffplay") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unknown media tool",
        ));
    }
    let parent = app
        .parent()
        .ok_or_else(|| io::Error::other("missing app directory"))?;
    let root = match platform {
        "windows" => parent.join("media-runtime"),
        "macos" if parent.file_name().is_some_and(|p| p == "MacOS") => parent
            .parent()
            .ok_or_else(|| io::Error::other("missing Contents directory"))?
            .join("Resources/media-runtime"),
        _ => return Err(io::Error::other("unsupported media runtime layout")),
    };
    let filename = if platform == "windows" {
        format!("{name}.exe")
    } else {
        name.into()
    };
    let candidate = root.join("bin").join(filename);
    let missing = || {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "bundled media runtime missing or invalid: {}; reinstall a complete app package",
                candidate.display()
            ),
        )
    };
    let canonical_root = root.canonicalize().map_err(|_| missing())?;
    let canonical = candidate.canonicalize().map_err(|_| missing())?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Err(missing());
    }
    // Never execute a symlinked runtime root outside the application package.
    let app_parent = parent.canonicalize()?;
    let package = if platform == "macos" {
        app_parent.parent().unwrap_or(&app_parent)
    } else {
        &app_parent
    };
    if !canonical_root.starts_with(package) {
        return Err(missing());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packaged_paths_and_missing_tools() {
        let root = std::env::temp_dir().join(format!("ck-media-runtime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (platform, app, binary) in [
            ("windows", "app.exe", "media-runtime/bin/ffmpeg.exe"),
            (
                "macos",
                "Contents/MacOS/app",
                "Contents/Resources/media-runtime/bin/ffmpeg",
            ),
        ] {
            let app = root.join(app);
            let binary = root.join(binary);
            std::fs::create_dir_all(app.parent().unwrap()).unwrap();
            std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
            std::fs::write(&binary, b"fixture, never executed").unwrap();
            assert_eq!(
                resolve(&app, platform, "ffmpeg").unwrap(),
                binary.canonicalize().unwrap()
            );
            assert_eq!(
                resolve(&app, platform, "ffplay").unwrap_err().kind(),
                io::ErrorKind::NotFound
            );
            assert!(resolve(&app, platform, "../ffmpeg").is_err());
        }
        #[cfg(unix)]
        {
            let external = root.join("outside");
            std::fs::write(&external, b"fixture").unwrap();
            let link = root.join("media-runtime/bin/ffplay.exe");
            std::os::unix::fs::symlink(&external, link).unwrap();
            assert!(resolve(&root.join("app.exe"), "windows", "ffplay").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
