//! 桌面系统对话框与Android SAF共享的明确用户动作接口。
#[cfg(not(target_os = "android"))]
use nsh_core::{
    file_dialog::{OpenDialog, SaveDialog},
    prelude::*,
};
use std::path::PathBuf;
pub const RECEIVE_UNAVAILABLE: &str = "此平台尚未完成安全接收保存适配，仍可发送文件。";
pub fn receive_unavailable_reason() -> &'static str {
    if available() {
        RECEIVE_UNAVAILABLE
    } else {
        "当前平台文件宿主未启用，文件发送与接收暂不可用。"
    }
}
fn receive_size_limit(android: bool) -> u64 {
    if android {
        256 * 1024 * 1024
    } else {
        surreal_ck_peer_transport::file::MAX_FILE_SIZE
    }
}
pub fn receive_size_supported(size: u64) -> bool {
    size <= receive_size_limit(cfg!(target_os = "android"))
}
pub const RECEIVE_TOO_LARGE: &str =
    "文件超过本平台接收/导出大小上限；Android最多256 MiB，请拒绝此请求。";
pub fn can_receive() -> bool {
    available() && surreal_ck_peer_transport::transfer::receive_supported()
}
pub fn available() -> bool {
    #[cfg(all(target_os = "android", feature = "android-auto-update"))]
    {
        crate::android_documents::available()
    }
    #[cfg(all(target_os = "android", not(feature = "android-auto-update")))]
    {
        false
    }
    #[cfg(not(target_os = "android"))]
    {
        true
    }
}
#[cfg(not(target_os = "android"))]
pub async fn select_source() -> Result<Option<PathBuf>, String> {
    Ok(pick_paths(
        OpenDialog::files()
            .multiple(false)
            .title("选择待发送文件")
            .button_label("选择"),
    )
    .await?
    .and_then(|v| v.into_iter().next()))
}
#[cfg(not(target_os = "android"))]
pub async fn receive_destination(_id: &str, name: &str) -> Result<Option<PathBuf>, String> {
    if !can_receive() {
        return Err(receive_unavailable_reason().into());
    }
    pick_save_path(
        SaveDialog::new()
            .file_name(name)
            .title("接收文件，必须选择尚不存在的新文件")
            .button_label("接收"),
    )
    .await
}
#[cfg(all(target_os = "android", feature = "android-auto-update"))]
async fn wait_document(id: i64) -> Result<Option<serde_json::Value>, String> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        for _ in 0..6000 {
            if tx.is_closed() {
                return;
            }
            match crate::android_documents::poll(id) {
                Ok(Some(value)) => {
                    let parsed = serde_json::from_str::<serde_json::Value>(&value)
                        .map_err(|_| "系统文件结果格式无效".to_owned());
                    let result=parsed.and_then(|v|match v["state"].as_str(){Some("imported"|"exported")=>Ok(Some(v)),Some("cancelled")=>Ok(None),_=>Err("系统文件操作失败，请检查保存位置和剩余空间；可能存在未完成的导出文件。".to_owned())});
                    let _ = tx.send_blocking(result);
                    return;
                }
                Err(error) => {
                    let _ = tx.send_blocking(Err(error));
                    return;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        let _ = tx.send_blocking(Err("系统文件选择超时，请关闭选择器后重试。".into()));
    });
    rx.recv()
        .await
        .map_err(|_| "系统文件请求已结束".to_owned())?
}
#[cfg(all(target_os = "android", feature = "android-auto-update"))]
pub async fn select_source() -> Result<Option<PathBuf>, String> {
    let id = crate::android_documents::open()?;
    let Some(value) = wait_document(id).await? else {
        return Ok(None);
    };
    if value["state"] != "imported" {
        return Err("系统未返回可发送文件".into());
    }
    let path = PathBuf::from(value["path"].as_str().ok_or("系统未返回文件路径")?);
    if !path.is_absolute() {
        return Err("系统文件路径无效".into());
    }
    Ok(Some(path))
}
#[cfg(all(target_os = "android", feature = "android-auto-update"))]
pub async fn receive_destination(id: &str, name: &str) -> Result<Option<PathBuf>, String> {
    if !can_receive() {
        return Err(receive_unavailable_reason().into());
    }
    if id.len() != 32
        || !id.bytes().all(|b| b.is_ascii_hexdigit())
        || name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err("文件标识无效".into());
    }
    let root = crate::startup::private_data_dir().ok_or("无法访问应用私有文件区")?;
    let folder = root.join("received").join(id);
    std::fs::create_dir_all(&folder).map_err(|_| "无法创建接收目录")?;
    Ok(Some(folder.join(name)))
}
#[cfg(all(target_os = "android", feature = "android-auto-update"))]
pub async fn export(path: PathBuf) -> Result<bool, String> {
    let id = crate::android_documents::save(path.to_str().ok_or("文件路径无效")?)?;
    Ok(wait_document(id)
        .await?
        .is_some_and(|v| v["state"] == "exported"))
}
#[cfg(all(target_os = "android", not(feature = "android-auto-update")))]
pub async fn select_source() -> Result<Option<PathBuf>, String> {
    Err("Android文件宿主尚未启用".into())
}
#[cfg(all(target_os = "android", not(feature = "android-auto-update")))]
pub async fn receive_destination(_: &str, _: &str) -> Result<Option<PathBuf>, String> {
    Err("Android文件宿主尚未启用".into())
}
#[cfg(not(all(target_os = "android", feature = "android-auto-update")))]
pub async fn export(_: PathBuf) -> Result<bool, String> {
    Err("此平台不使用Android导出操作".into())
}

pub fn release_source(path: PathBuf) {
    #[cfg(all(target_os = "android", feature = "android-auto-update"))]
    std::thread::spawn(move || {
        if let Some(path) = path.to_str() {
            let _ = crate::android_documents::release_import(path);
        }
    });
    #[cfg(not(all(target_os = "android", feature = "android-auto-update")))]
    drop(path); // Desktop selections refer to the user's original file: never delete them.
}

#[cfg(all(test, not(any(target_os = "linux", target_os = "android"))))]
mod tests {
    #[tokio::test]
    async fn unsupported_platform_refuses_before_opening_save_dialog() {
        assert!(!super::can_receive());
        let error = super::receive_destination("test", "file.txt")
            .await
            .unwrap_err();
        assert_eq!(error, super::RECEIVE_UNAVAILABLE);
        assert!(super::available(), "sending dialogs remain available");
    }
}

#[cfg(test)]
mod capacity_tests {
    #[test]
    fn android_receive_limit_matches_saf_export_capacity_without_lowering_desktop_limit() {
        assert_eq!(super::receive_size_limit(true), 256 * 1024 * 1024);
        assert_eq!(
            super::receive_size_limit(false),
            surreal_ck_peer_transport::file::MAX_FILE_SIZE
        );
        let limit = super::receive_size_limit(cfg!(target_os = "android"));
        assert!(super::receive_size_supported(0));
        assert!(super::receive_size_supported(limit));
        assert!(!super::receive_size_supported(limit + 1));
    }
}
