//! 手动 GitHub 更新（实验预览渠道）：下载来源单选 + 独立“检查更新”按钮。
//! 版本与 SHA-256 只来自 GitHub API；第三方代理只承载安装包字节。
//! 预览版只下载并校验，安装由用户手动完成，绝不把下载成功称为升级成功。
use crate::ui;
use nsh_core::prelude::*;
use surreal_ck_native_updater::github::{
    self, CheckReport, Downloaded, GithubAsset, Source, UpdateCheckError,
};

pub const LOCAL_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const SOURCE_NOTE: &str = "版本号与 SHA-256 始终直接从 GitHub API（TLS）读取；第三方代理只用于下载安装包，内容必须与 GitHub 官方摘要一致才会保存，代理可能记录你的 IP。GitHub API 不可达时检查会失败，不会改信代理提供的版本或校验值。";
pub const INSTALL_MODE: &str = "安装方式：预览版仅下载并校验，需手动安装；不会自动升级。";

/// 面板的可测状态与文案。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateView {
    pub remote: Option<String>,
    pub result: String,
    pub available: Option<GithubAsset>,
}

impl Default for UpdateView {
    fn default() -> Self {
        Self {
            remote: None,
            result: "尚未检查。点击“检查更新”联网查询 GitHub Release。".into(),
            available: None,
        }
    }
}

impl UpdateView {
    pub fn local_line() -> String {
        format!("本地版本：{LOCAL_VERSION}")
    }
    pub fn remote_line(&self) -> String {
        format!(
            "远端版本：{}",
            self.remote.as_deref().unwrap_or("未知（尚未成功检查）")
        )
    }
    pub fn checking(&mut self) {
        self.available = None;
        self.result = "正在检查 GitHub Release…".into();
    }
    pub fn checked(&mut self, result: Result<CheckReport, UpdateCheckError>) {
        match result {
            Ok(report) => {
                self.remote = Some(report.remote.clone());
                self.result = report.summary();
                self.available = report.available;
            }
            Err(error) => {
                self.available = None;
                self.result = format!("检查失败：{error}");
            }
        }
    }
    pub fn downloading(&mut self, source: Source) {
        self.result = format!("正在通过{}下载并校验 SHA-256…", source.label());
    }
    pub fn downloaded(&mut self, result: Result<Downloaded, UpdateCheckError>) {
        self.result = match result {
            Ok(done) => done.manual_install_notice(),
            Err(error) => format!("下载未完成：{error}"),
        };
    }
}

#[component]
pub fn GithubUpdatePanel() -> impl IntoElement {
    let source = signal(Source::Github);
    let busy = signal(false);
    let view_state = signal(UpdateView::default());
    view()
        .gap_2()
        .child(text("软件更新").text_size(px(18.0)))
        .child(text(UpdateView::local_line()))
        .child(text(move || view_state.get().remote_line()))
        .child(text(INSTALL_MODE))
        .child(text("下载来源"))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(ui::radio(
                    "GitHub",
                    move || source.get() == Source::Github,
                    move || busy.get(),
                    move || source.set(Source::Github),
                ))
                .child(ui::radio(
                    "第三方代理",
                    move || source.get() == Source::Proxy,
                    move || busy.get(),
                    move || source.set(Source::Proxy),
                )),
        )
        .child(ui::note(|| SOURCE_NOTE.to_owned()))
        .child(text(move || view_state.get().result).test_id("update-result"))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(ui::action(
                    "检查更新",
                    move || busy.get(),
                    move || {
                        busy.set(true);
                        view_state.update(UpdateView::checking);
                        let (tx, rx) = async_channel::bounded(1);
                        std::thread::spawn(move || {
                            let _ = tx.send_blocking(github::check(LOCAL_VERSION));
                        });
                        spawn(async move {
                            let result = rx
                                .recv()
                                .await
                                .unwrap_or_else(|_| Err(UpdateCheckError::MetadataInvalid));
                            view_state.update(|v| v.checked(result));
                            busy.set(false);
                        });
                    },
                ))
                .child(ui::action(
                    "下载并校验",
                    move || busy.get() || view_state.get().available.is_none(),
                    move || {
                        let Some(asset) = view_state.get_untracked().available else {
                            return;
                        };
                        let chosen = source.get_untracked();
                        busy.set(true);
                        view_state.update(|v| v.downloading(chosen));
                        let (tx, rx) = async_channel::bounded(1);
                        std::thread::spawn(move || {
                            let result = std::env::var_os("HOME")
                                .map(std::path::PathBuf::from)
                                .ok_or(UpdateCheckError::NoDownloadDir)
                                .and_then(|home| {
                                    github::download(&asset, chosen, &home.join("Downloads"))
                                });
                            let _ = tx.send_blocking(result);
                        });
                        spawn(async move {
                            let result = rx.recv().await.unwrap_or_else(|_| {
                                Err(UpdateCheckError::SaveFailed("后台任务中断".into()))
                            });
                            view_state.update(|v| v.downloaded(result));
                            busy.set(false);
                        });
                    },
                )),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate() -> GithubAsset {
        // 受控测试候选 0.1.1：用于覆盖 newer→可下载 路径，不代表已发布版本。
        GithubAsset {
            version: "0.1.1".into(),
            url: format!(
                "https://github.com/MainListActivity/surreal_ck/releases/download/v0.1.1/{}",
                github::ASSET
            ),
            size: 4,
            sha256: "ab".repeat(32),
            prerelease: true,
        }
    }

    #[test]
    fn check_shows_local_remote_and_result() {
        let mut v = UpdateView::default();
        assert_eq!(
            UpdateView::local_line(),
            format!("本地版本：{LOCAL_VERSION}")
        );
        assert!(v.remote_line().contains("未知"));
        v.checking();
        assert!(v.result.contains("正在检查"));
        v.checked(github::check_with("0.1.0", Ok(candidate())));
        assert_eq!(v.remote_line(), "远端版本：0.1.1");
        assert!(v.result.contains("发现新版本 0.1.1"));
        assert!(v.available.is_some());
        v.checked(github::check_with("0.1.1", Ok(candidate())));
        assert!(v.available.is_none());
        assert!(
            v.result
                .contains("当前已是最新版本（本地 0.1.1，远端 0.1.1）")
        );
    }

    #[test]
    fn failures_are_specific_and_clear_the_download() {
        let mut v = UpdateView::default();
        v.checked(github::check_with("0.1.0", Ok(candidate())));
        for error in [
            UpdateCheckError::ApiStatus(500),
            UpdateCheckError::RateLimited(403),
            UpdateCheckError::Timeout("api.github.com"),
            UpdateCheckError::Tls("api.github.com"),
            UpdateCheckError::NoCompatibleAsset("0.1.1".into()),
            UpdateCheckError::DigestInvalid,
        ] {
            let expected = error.to_string();
            v.checked(Err(error));
            assert!(v.available.is_none(), "失败后不能保留可下载状态");
            assert_eq!(v.result, format!("检查失败：{expected}"));
            assert!(!v.result.contains("无法连接 GitHub 或尚无正式 Release"));
        }
    }

    #[test]
    fn download_success_is_manual_install_not_upgrade() {
        let mut v = UpdateView::default();
        v.downloading(Source::Proxy);
        assert!(v.result.contains("第三方代理"));
        v.downloaded(Ok(Downloaded {
            path: "/Users/me/Downloads/Jiji-0.1.1.dmg".into(),
            version: "0.1.1".into(),
            reused: false,
        }));
        assert!(v.result.starts_with("下载完成"));
        assert!(v.result.contains("预览版不会自动安装或升级"));
        for forbidden in ["升级成功", "已升级", "更新成功", "已更新到"] {
            assert!(!v.result.contains(forbidden), "{forbidden}");
        }
        assert!(INSTALL_MODE.contains("需手动安装"));
        v.downloaded(Err(UpdateCheckError::HashMismatch));
        assert!(v.result.contains("SHA-256 与 GitHub 官方摘要不一致"));
        v.downloaded(Err(UpdateCheckError::DestinationExists(
            "/tmp/Jiji-0.1.1.dmg".into(),
        )));
        assert!(v.result.contains("目标文件已存在"));
    }

    #[test]
    fn proxy_note_keeps_github_as_the_only_metadata_source() {
        assert!(SOURCE_NOTE.contains("始终直接从 GitHub API"));
        assert!(SOURCE_NOTE.contains("不会改信代理"));
    }
}
