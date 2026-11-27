//! 会前检测只在本机处理设备数据。退出弹窗时关闭进程，确认停止后才允许入会。
use crate::ui;
use nsh_core::prelude::*;
use std::{io, path::PathBuf, process::Stdio, time::Duration};
use surreal_ck_native_video_view::{COMPONENT_NAME, FramePublisher, RgbaFrame, open_stream};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

const FRAME_WIDTH: u32 = 320;
const FRAME_HEIGHT: u32 = 180;
const FIRST_SAMPLE_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_TEST_TIME: Duration = Duration::from_secs(60);
const STOP_UNCONFIRMED: &str = "无法确认检测已停止，请检查系统设备指示灯。";

#[derive(Clone, Copy, PartialEq)]
enum Test {
    Camera,
    Microphone,
    Speaker,
}

impl Test {
    fn label(self) -> &'static str {
        match self {
            Self::Camera => "预览摄像头",
            Self::Microphone => "检测麦克风",
            Self::Speaker => "测试扬声器",
        }
    }
}

#[derive(Clone)]
enum Sample {
    Camera,
    Microphone(u8),
}

#[derive(Clone, Copy)]
pub(super) struct PrejoinMedia {
    test: Signal<Option<Test>>,
    stop: Signal<Option<async_channel::Sender<()>>>,
    stream_id: Signal<String>,
    sample: Signal<Option<Sample>>,
    feedback: Signal<&'static str>,
}

impl PrejoinMedia {
    pub(super) fn new() -> Self {
        let this = Self {
            test: signal(None),
            stop: signal_with(None, SignalEquals::Never),
            stream_id: signal(String::new()),
            sample: signal_with(None, SignalEquals::Never),
            feedback: signal(""),
        };
        cleanup(move || {
            if let Some(stop) = this.stop.get_untracked() {
                stop.close();
            }
        });
        this
    }

    pub(super) fn active(self) -> bool {
        self.test.get().is_some() || self.feedback.get() == STOP_UNCONFIRMED
    }

    pub(super) fn stop(self) {
        if let Some(stop) = self.stop.get_untracked() {
            stop.close();
        }
    }

    fn start(self, test: Test) {
        if self.test.get_untracked().is_some() || self.feedback.get_untracked() == STOP_UNCONFIRMED
        {
            return;
        }
        let stream = if test == Test::Camera {
            let Ok(publisher) = open_stream() else {
                self.feedback.set("无法显示摄像头预览。");
                return;
            };
            self.stream_id.set(publisher.id().into());
            Some(publisher)
        } else {
            None
        };
        let (stop, stopped) = async_channel::bounded(1);
        let (samples, output) = async_channel::bounded(1);
        let (finished, done) = async_channel::bounded(1);
        if std::thread::Builder::new()
            .name("prejoin-media".into())
            .spawn(move || {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| "无法启动设备检测。")
                    .and_then(|runtime| runtime.block_on(run(test, stream, stopped, samples)));
                let _ = finished.try_send(result);
            })
            .is_err()
        {
            self.feedback.set("无法启动设备检测。");
            return;
        }
        self.test.set(Some(test));
        self.stop.set(Some(stop));
        self.sample.set(None);
        self.feedback.set("正在启动检测…");
        spawn(async move {
            while let Ok(sample) = output.recv().await {
                self.sample.set(Some(sample));
                self.feedback.set("");
            }
            let outcome = done.recv().await;
            self.sample.set(None);
            self.stream_id.set(String::new());
            self.stop.set(None);
            self.test.set(None);
            self.feedback.set(match outcome {
                Ok(Ok(true)) if test == Test::Speaker => "扬声器测试结束。",
                Ok(Ok(_)) => "",
                Ok(Err(message)) => message,
                Err(_) => "设备检测已中断。",
            });
        });
    }

    pub(super) fn controls(self) -> impl IntoElement {
        view()
            .gap_2()
            .child(
                view()
                    .flex_row()
                    .flex_wrap()
                    .gap_2()
                    .child(ui::secondary(
                        Test::Camera.label(),
                        move || self.active() || !camera_available(),
                        move || self.start(Test::Camera),
                    ))
                    .child(ui::secondary(
                        Test::Microphone.label(),
                        move || self.active() || cfg!(target_os = "windows"),
                        move || self.start(Test::Microphone),
                    ))
                    .child(ui::secondary(
                        Test::Speaker.label(),
                        move || self.active(),
                        move || self.start(Test::Speaker),
                    )),
            )
            .child(when(
                move || self.test.get().is_some(),
                move || ui::danger("停止检测", || false, move || self.stop()),
            ))
            .child(when(
                move || !self.feedback.get().is_empty(),
                move || ui::note(move || self.feedback.get().into()),
            ))
            .child(when(
                move || matches!(self.sample.get(), Some(Sample::Camera)),
                move || {
                    native(COMPONENT_NAME)
                        .prop(
                            "streamId",
                            serde_json::Value::String(self.stream_id.get_untracked()),
                        )
                        .w(px(FRAME_WIDTH as f32))
                        .h(px(FRAME_HEIGHT as f32))
                },
            ))
            .child(when(
                move || matches!(self.sample.get(), Some(Sample::Microphone(_))),
                move || {
                    let level = move || match self.sample.get() {
                        Some(Sample::Microphone(level)) => level,
                        _ => 0,
                    };
                    view()
                        .gap_1()
                        .child(ui::note(move || format!("麦克风音量 · {}%", level())))
                        .child(
                            view()
                                .w(px(180.0))
                                .h(px(6.0))
                                .rounded(px(3.0))
                                .bg(move || nsh_base::theme().muted)
                                .child(
                                    view()
                                        .h_full()
                                        .w(move || px(f32::from(level()) * 1.8))
                                        .rounded(px(3.0))
                                        .bg(move || nsh_base::theme().primary),
                                ),
                        )
                },
            ))
    }
}

fn camera_available() -> bool {
    cfg!(any(
        all(target_os = "linux", feature = "desktop"),
        all(
            target_os = "macos",
            feature = "experimental-macos-video",
            feature = "desktop"
        )
    ))
}

/// 与桌面会议运行时使用相同的安装位置。macOS/Windows 只启动包内工具。
fn tool(name: &str) -> io::Result<PathBuf> {
    if cfg!(target_os = "linux") {
        return Ok(name.into());
    }
    let exe = std::env::current_exe()?;
    let parent = exe
        .parent()
        .ok_or_else(|| io::Error::other("missing executable directory"))?;
    let (bundle, bin, filename) = if cfg!(target_os = "macos") {
        let contents = parent
            .parent()
            .filter(|_| parent.ends_with("MacOS"))
            .ok_or_else(|| io::Error::other("missing application bundle"))?;
        (contents, "Resources/media-runtime/bin", name.to_owned())
    } else {
        (parent, "media-runtime/bin", format!("{name}.exe"))
    };
    let bundle = bundle.canonicalize()?;
    let root = bundle.join(bin).canonicalize()?;
    let executable = root.join(filename).canonicalize()?;
    if !root.starts_with(&bundle) || !executable.starts_with(&root) || !executable.is_file() {
        return Err(io::Error::other("tool outside application bundle"));
    }
    Ok(executable)
}

fn command(test: Test) -> Result<Command, &'static str> {
    let program = if test == Test::Speaker {
        "ffplay"
    } else {
        "ffmpeg"
    };
    let mut command =
        Command::new(tool(program).map_err(|_| "安装包缺少媒体运行时，无法检测设备。")?);
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    if test == Test::Speaker {
        command
            .args([
                "-loglevel",
                "error",
                "-autoexit",
                "-nodisp",
                "-f",
                "lavfi",
                "sine=frequency=660:duration=0.7",
            ])
            .stdout(Stdio::null());
        return Ok(command);
    }
    let camera = test == Test::Camera;
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    match (std::env::consts::OS, camera) {
        ("macos", true) => command.args([
            "-f",
            "avfoundation",
            "-framerate",
            "30",
            "-i",
            "default:none",
        ]),
        ("macos", false) => command.args(["-f", "avfoundation", "-i", "none:default"]),
        ("linux", true) => command.args(["-f", "v4l2", "-i", "/dev/video0"]),
        ("linux", false) => command.args(["-f", "pulse", "-i", "default"]),
        _ => return Err("当前平台暂不支持检测此设备。"),
    };
    if camera {
        command.args([
            "-an",
            "-vf",
            "scale=320:180,format=rgba",
            "-c:v",
            "rawvideo",
            "-f",
            "rawvideo",
        ]);
    } else {
        command.args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "s16le",
        ]);
    }
    command.arg("pipe:1").stdout(Stdio::piped());
    Ok(command)
}

async fn run(
    test: Test,
    stream: Option<FramePublisher>,
    stopped: async_channel::Receiver<()>,
    samples: async_channel::Sender<Sample>,
) -> Result<bool, &'static str> {
    let mut child = command(test)?.spawn().map_err(|_| "无法启动媒体检测。")?;
    let outcome = if let Some(mut stdout) = child.stdout.take() {
        let mut buffer = vec![
            0;
            if stream.is_some() {
                (FRAME_WIDTH * FRAME_HEIGHT * 4) as usize
            } else {
                3200
            }
        ];
        let sample_device = async {
            let mut first_frame = true;
            loop {
                timeout(FIRST_SAMPLE_TIMEOUT, stdout.read_exact(&mut buffer))
                    .await
                    .map_err(|_| "设备没有返回数据，请检查系统权限与设备连接。")?
                    .map_err(|_| "无法读取设备，请检查系统权限与设备连接。")?;
                if let Some(stream) = &stream {
                    let frame = RgbaFrame::packed(
                        FRAME_WIDTH,
                        FRAME_HEIGHT,
                        bytes::Bytes::copy_from_slice(&buffer),
                    )
                    .map_err(|_| "无法显示摄像头画面。")?;
                    stream.present(frame).map_err(|_| "摄像头预览已关闭。")?;
                    if first_frame {
                        let _ = samples.try_send(Sample::Camera);
                        first_frame = false;
                    }
                } else {
                    let _ = samples.try_send(Sample::Microphone(microphone_level(&buffer)));
                }
            }
        };
        tokio::select! {
            biased;
            _ = stopped.recv() => Ok(false),
            result = timeout(MAX_TEST_TIME, sample_device) => result.unwrap_or(Ok(false)),
        }
    } else {
        tokio::select! {
            biased;
            _ = stopped.recv() => Ok(false),
            result = timeout(FIRST_SAMPLE_TIMEOUT, child.wait()) => match result {
                Ok(Ok(status)) if status.success() => Ok(true),
                _ => Err("无法播放测试音，请检查扬声器。"),
            },
        }
    };
    if child.try_wait().map_err(|_| STOP_UNCONFIRMED)?.is_none() {
        child.kill().await.map_err(|_| STOP_UNCONFIRMED)?;
    }
    outcome
}

fn microphone_level(buffer: &[u8]) -> u8 {
    let (samples, _) = buffer.as_chunks::<2>();
    let max = samples
        .iter()
        .map(|value| i16::from_le_bytes(*value).unsigned_abs())
        .max()
        .unwrap_or_default();
    (u32::from(max) * 100 / 32768) as u8
}

#[cfg(test)]
mod tests {
    #[test]
    fn microphone_level_uses_actual_pcm_amplitude() {
        assert_eq!(super::microphone_level(&[0; 4]), 0);
        assert_eq!(super::microphone_level(&[0, 0x40, 0, 0]), 50);
        assert_eq!(super::microphone_level(&[0, 0, 0, 0x80]), 100);
    }
}
