//! Explicit user-initiated GitHub update check and verified download.
use crate::ui;
use nsh_core::prelude::*;
use surreal_ck_native_updater::github::{self, GithubAsset};

#[component]
pub fn GithubUpdatePanel() -> impl IntoElement {
    let selected_mirror = signal(false);
    let busy = signal(false);
    let status = signal("检查 GitHub Release；下载前会校验 SHA-256。".to_owned());
    let available = signal(None::<GithubAsset>);
    view()
        .gap_2()
        .child(text("软件更新").text_size(px(18.0)))
        .child(text(move || {
            if selected_mirror.get() {
                "下载线路：第三方 ghfast.top 镜像"
            } else {
                "下载线路：GitHub 直连"
            }
        }))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(ui::action(
                    "GitHub 直连",
                    move || busy.get(),
                    move || selected_mirror.set(false),
                ))
                .child(ui::action(
                    "第三方国内镜像",
                    move || busy.get(),
                    move || selected_mirror.set(true),
                )),
        )
        .child(text(
            "版本和校验值从 GitHub 获取；镜像仅用于下载，可能记录你的 IP。",
        ))
        .child(text(move || status.get()))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(ui::action(
                    "检查更新",
                    move || busy.get(),
                    move || {
                        busy.set(true);
                        available.set(None);
                        status.set("正在检查 GitHub Release…".into());
                        let (tx, rx) = async_channel::bounded(1);
                        std::thread::spawn(move || {
                            let _ = tx.send_blocking(github::latest());
                        });
                        spawn(async move {
                            match rx.recv().await {
                                Ok(Ok(asset)) => {
                                    match github::newer(&asset, env!("CARGO_PKG_VERSION")) {
                                        Ok(true) => {
                                            status.set(format!(
                                                "发现新版本 {}{}，可选择线路下载。",
                                                asset.version,
                                                if asset.prerelease {
                                                    "（预发布）"
                                                } else {
                                                    ""
                                                }
                                            ));
                                            available.set(Some(asset));
                                        }
                                        Ok(false) => status.set("当前已是最新版本。".into()),
                                        Err(e) => status.set(e.into()),
                                    }
                                }
                                Ok(Err(e)) => status.set(e.into()),
                                Err(_) => status.set("检查更新失败，请重试。".into()),
                            }
                            busy.set(false);
                        });
                    },
                ))
                .child(ui::action(
                    "下载并校验",
                    move || busy.get() || available.get().is_none(),
                    move || {
                        let Some(asset) = available.get_untracked() else {
                            return;
                        };
                        let mirror = selected_mirror.get_untracked();
                        busy.set(true);
                        status.set("正在下载并校验更新…".into());
                        let (tx, rx) = async_channel::bounded(1);
                        std::thread::spawn(move || {
                            let result = std::env::var_os("HOME")
                                .map(std::path::PathBuf::from)
                                .ok_or("找不到下载目录")
                                .and_then(|home| {
                                    github::download(&asset, mirror, &home.join("Downloads"))
                                });
                            let _ = tx.send_blocking(result);
                        });
                        spawn(async move {
                            match rx.recv().await {
                                Ok(Ok(path)) => status.set(format!(
                                    "已校验并保存：{}。请手动打开安装。",
                                    path.display()
                                )),
                                Ok(Err(e)) => status.set(e.into()),
                                Err(_) => status.set("下载失败，请重试。".into()),
                            }
                            busy.set(false);
                        });
                    },
                )),
        )
}
