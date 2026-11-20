//! 独立合成媒体验收宿主。不是生产客户端，不创建账号、更新信任或设备采集权限。
//! cargo run --offline --locked --features desktop --example synthetic_video
#[cfg(all(target_os = "linux", feature = "desktop"))]
#[nsh_core::element::native_components(linux)]
fn video_components(components: &surreal_ck_native_video_view::linux::Components) {
    surreal_ck_native_video_view::linux::register(components);
}

#[cfg(all(target_os = "linux", feature = "desktop"))]
mod linux {
    use nsh_core::prelude::*;
    use std::sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
    };
    use std::time::Duration;
    use surreal_ck_native_call::{CallEvent, CallSession, Source};
    use surreal_ck_native_video_view::{FramePublisher, RgbaFrame};
    use surreal_ck_peer_transport::{
        Route,
        chat::{Chat, Event as ChatEvent},
        media::Media,
        webrtc::{media::io::ivf_reader::IVFReader, stats::StatsReportType},
    };

    #[derive(Clone, Copy)]
    enum Command {
        BadFrame,
        Stop,
        Close,
        Exit,
    }
    enum Update {
        Status(String),
        Counters(String),
        Stopped,
        Closed,
    }
    struct Controls {
        commands: async_channel::Sender<Command>,
        updates: async_channel::Receiver<Update>,
        camera: FramePublisher,
        screen: FramePublisher,
    }
    static CONTROLS: OnceLock<Controls> = OnceLock::new();
    fn action(label: &'static str, press: impl Fn() + 'static) -> impl IntoElement {
        nsh_base::button()
            .on_press(press)
            .px_4()
            .py_3()
            .bg(rgb(0x245dba))
            .rounded(px(6.0))
            .child(text(label).text_color(rgb(0xffffff)))
    }
    fn video(
        title: &'static str,
        stream: String,
        native_status: Signal<String>,
    ) -> impl IntoElement {
        view()
            .gap_2()
            .child(text(title).text_size(px(18.0)))
            .child(
                native(surreal_ck_native_video_view::COMPONENT_NAME)
                    .prop("streamId", serde_json::Value::String(stream))
                    .w(px(400.0))
                    .h(px(225.0))
                    .on_native_event(move |event: &NativeEvent| {
                        let state = format!("{title} / GTK {} {}", event.name, event.data);
                        eprintln!("NATIVE {state}");
                        native_status.set(state);
                    }),
            )
            .child(text(move || native_status.get()).text_size(px(12.0)))
    }
    #[component]
    pub fn SyntheticVideo() -> impl IntoElement {
        let c = CONTROLS.get().expect("test controls initialized");
        let status = signal("正在建立两个同机真实 UDP Peer…".to_owned());
        let counters = signal("等待接收计数".to_owned());
        let lifecycle = signal("运行中：未请求任何真实设备或扬声器".to_owned());
        let camera_status = signal("等待 GTK 原生纹理".to_owned());
        let screen_status = signal("等待 GTK 原生纹理".to_owned());
        let updates = c.updates.clone();
        spawn(async move {
            while let Ok(update) = updates.recv().await {
                match update {
                    Update::Status(value) => status.set(value),
                    Update::Counters(value) => counters.set(value),
                    Update::Stopped => {
                        lifecycle.set("STOP 已确认：接收帧冻结，原生纹理已清空".into())
                    }
                    Update::Closed => {
                        lifecycle.set("CLOSE 已确认：两个 Peer 已关闭，迟到发送被拒绝".into())
                    }
                }
            }
        });
        view()
        .flex_1()
        .p_6()
        .gap_4()
        .bg(rgb(0x111b2e))
        .text_color(rgb(0xf2f5fb))
        .child(text("合成视频测试 · 独立原生验收宿主").text_size(px(26.0)))
        .child(text(
            "仅 FFmpeg testsrc2 / sine 合成素材。不是摄像头、不是屏幕共享，不播放声音。",
        ))
        .child(text(
            "同机 Peer A → 真实 UDP / ICE / DTLS / SRTP → Peer B → FFmpeg VP8 解码 → GTK 原生纹理",
        ))
        .child(text("生产客户端的签名更新门保持不变；本窗不是生产入口。"))
        .child(text(move || status.get()))
        .child(text(move || counters.get()).text_size(px(17.0)))
        .child(
            view()
                .flex_row()
                .gap_4()
                .child(video(
                    "合成视频 A（camera 测试轨）",
                    c.camera.id().into(),
                    camera_status,
                ))
                .child(video(
                    "合成视频 B（screen 测试轨）",
                    c.screen.id().into(),
                    screen_status,
                )),
        )
        .child(text(move || lifecycle.get()))
        .child(
            view()
                .flex_row()
                .gap_3()
                .child(action("注入坏帧", || {
                    let _ = CONTROLS.get().unwrap().commands.try_send(Command::BadFrame);
                }))
                .child(action("停止接收并清空", || {
                    let _ = CONTROLS.get().unwrap().commands.try_send(Command::Stop);
                }))
                .child(action("关闭两个 Peer", || {
                    let _ = CONTROLS.get().unwrap().commands.try_send(Command::Close);
                })),
        )
    }
    fn counts(values: &[AtomicU64; 2]) -> [u64; 2] {
        std::array::from_fn(|i| values[i].load(Ordering::SeqCst))
    }
    async fn opened(events: &mut tokio::sync::mpsc::Receiver<ChatEvent>) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(15), async {
            while let Some(event) = events.recv().await {
                if matches!(event, ChatEvent::Open) {
                    return Ok(());
                }
            }
            Err("DataChannel 提前关闭".into())
        })
        .await
        .map_err(|_| "真实 UDP 连接超时".to_owned())?
    }
    async fn report(tx: &async_channel::Sender<Update>, text: impl Into<String>) {
        let text = text.into();
        eprintln!("TEST {text}");
        let _ = tx.try_send(Update::Status(text));
    }
    // 只使用仓库已记录来源的合成 fixture；没有生产采集 fallback 或测试信任配置。
    async fn run(
        commands: async_channel::Receiver<Command>,
        updates: async_channel::Sender<Update>,
        camera: FramePublisher,
        screen: FramePublisher,
    ) -> Result<(), String> {
        let (a, mut ae) = Chat::new(true, Route::Direct, vec![])
            .await
            .map_err(|e| e.to_string())?;
        let (b, mut be) = Chat::new(false, Route::Direct, vec![])
            .await
            .map_err(|e| e.to_string())?;
        let (media, mut feedback) = Media::attach(a.peer()).await.map_err(|e| e.to_string())?;
        let decoded = Arc::new([AtomicU64::new(0), AtomicU64::new(0)]);
        let accepted = decoded.clone();
        let camera_sink = camera.clone();
        let screen_sink = screen.clone();
        let (mut call, mut call_events) = CallSession::attach(
            &b,
            Arc::new(move |source, w, h, pixels| {
                let (publisher, index) = match source {
                    Source::Camera => (&camera_sink, 0),
                    Source::Screen => (&screen_sink, 1),
                    Source::Microphone => return Err("音频不可写入原生视频纹理".into()),
                };
                publisher
                    .present(
                        RgbaFrame::packed(w.into(), h.into(), pixels).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                accepted[index].fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
        let offer = a.offer_json().await?;
        if offer.contains(" typ relay") || !offer.contains(" udp ") {
            return Err("测试必须使用真实 UDP host candidate".into());
        }
        a.accept_answer_json(&b.answer_json(&offer).await?).await?;
        opened(&mut ae).await?;
        opened(&mut be).await?;
        a.send_text("合成视频测试：同一真实 UDP 会话").await?;
        tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(event) = be.recv().await {
            if matches!(event, ChatEvent::Text(ref text) if text == "合成视频测试：同一真实 UDP 会话") { return Ok(()); }
        }
        Err("中文消息通道提前关闭".to_owned())
    }).await.map_err(|_| "中文聊天验证超时".to_owned())??;
        report(
            &updates,
            "真实 UDP Peer 已连接；同会话中文 DataChannel 验证通过",
        )
        .await;
        call.set_remote_video_enabled(true)
            .await
            .map_err(|e| e.to_string())?;
        // 音频仅验证入站 SRTP 统计；保持 CallSession 的默认音频播放关闭。
        for source in [Source::Camera, Source::Screen, Source::Microphone] {
            media.set_enabled(source, true);
        }
        let (mut ivf, _) = IVFReader::new(
            include_bytes!("../../native-transport/tests/fixtures/test.vp8.ivf").as_slice(),
        )
        .map_err(|e| e.to_string())?;
        let mut frames = Vec::new();
        while let Ok((frame, _)) = ivf.parse_next_frame() {
            frames.push(frame.freeze());
        }
        if frames.len() < 2 {
            return Err("合成 fixture 不足两帧，无法验证画面变化".into());
        }
        let opus =
            include_bytes!("../../native-transport/tests/fixtures/test.opus.packet").as_slice();
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut index = 0usize;
        let mut ticks = 0u64;
        let mut stopped = false;
        let mut closed = false;
        let mut frozen = None;
        let mut bad_pending = false;
        let mut errors = 0u64;
        let mut incoming = [0u64; 3];
        loop {
            tokio::select! {
                biased;
                command = commands.recv() => {
                    match command.unwrap_or(Command::Exit) {
                        Command::BadFrame if !stopped && !closed => {
                            if RgbaFrame::packed(320, 180, vec![0u8; 3].into()).is_ok() { return Err("畸形 RGBA 未被拒绝".into()); }
                            media.send(Source::Camera, vec![0x10, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 0, 0].into(), Duration::from_millis(100)).await?;
                            bad_pending = true;
                            report(&updates, "畸形 RGBA 已拒绝；畸形 VP8 已经 SRTP 发送，等待接收端错误").await;
                        }
                        Command::BadFrame => report(&updates, "会话已停止：不再发送测试坏帧").await,
                        Command::Stop if !stopped => {
                            call.stop().await.map_err(|e| e.to_string())?; camera.close(); screen.close();
                            frozen = Some(counts(&decoded)); stopped = true;
                            if call.set_remote_video_enabled(true).await.is_ok() { return Err("停止后的 CallSession 仍能重开".into()); }
                            let _ = updates.try_send(Update::Stopped);
                            report(&updates, format!("STOP 已确认，RGBA {:?}；发送端继续发送以验证接收不会恢复", frozen.unwrap())).await;
                        }
                        Command::Close if !closed => {
                            call.stop().await.map_err(|e| e.to_string())?; camera.close(); screen.close();
                            frozen = Some(counts(&decoded)); stopped = true; a.close().await.map_err(|e| e.to_string())?; b.close().await.map_err(|e| e.to_string())?;
                            for source in [Source::Camera, Source::Screen, Source::Microphone] {
                                let data = if source == Source::Microphone { opus.to_vec().into() } else { frames[0].clone() };
                                if media.send(source, data, Duration::from_millis(20)).await.is_ok() { return Err(format!("关闭后 {source:?} 仍接受发送")); }
                            }
                            closed = true; let _ = updates.try_send(Update::Closed);
                            report(&updates, format!("CLOSE 已确认，RGBA {:?}；三轨迟到发送全部拒绝", frozen.unwrap())).await;
                        }
                        Command::Exit => break,
                        _ => report(&updates, "重复停止/关闭：保持已确认状态").await,
                    }
                }
                event = call_events.recv(), if !call_events.is_closed() => {
                    if let Some(CallEvent::Failed { message, .. }) = event {
                        errors += 1;
                        if bad_pending { bad_pending = false;
                            report(&updates, format!("坏帧已在接收端拒绝，无崩溃：{message}；继续等待合法关键帧恢复")).await;
                        } else if !closed { return Err(format!("非预期接收错误：{message}")); }
                    }
                }
                _ = feedback.recv(), if !feedback.is_closed() => {}
                _ = ae.recv(), if !ae.is_closed() => {}
                _ = be.recv(), if !be.is_closed() => {}
                _ = tick.tick() => {
                    if !closed {
                        media.send(Source::Camera, frames[index % frames.len()].clone(), Duration::from_millis(100)).await?;
                        media.send(Source::Screen, frames[(index + 1) % frames.len()].clone(), Duration::from_millis(100)).await?;
                        for _ in 0..5 { media.send(Source::Microphone, opus.to_vec().into(), Duration::from_millis(20)).await?; }
                        index = index.wrapping_add(1);
                    }
                    let current = counts(&decoded);
                    if frozen.is_some_and(|at| at != current) { return Err("STOP/CLOSE 后 RGBA 计数仍增长".into()); }
                    ticks += 1;
                    if ticks.is_multiple_of(10) {
                        if !closed {
                            let stats = b.peer().connection().get_stats().await;
                            for stat in stats.reports.values() {
                                if let StatsReportType::InboundRTP(stat) = stat {
                                    let i = match stat.track_identifier.as_str() { "camera" => 0, "screen" => 1, "microphone" => 2, _ => continue };
                                    incoming[i] = stat.packets_received;
                                }
                            }
                        }
                        let summary = format!("RGBA A={} B={} | SRTP 包 A={} B={} Opus={} | 错误={} | 运行={}s", current[0], current[1], incoming[0], incoming[1], incoming[2], errors, ticks / 10);
                        eprintln!("COUNTERS {summary} stopped={stopped} closed={closed}");
                        let _ = updates.try_send(Update::Counters(summary));
                    }
                }
            }
        }
        call.stop().await.map_err(|e| e.to_string())?;
        camera.close();
        screen.close();
        a.close().await.map_err(|e| e.to_string())?;
        b.close().await.map_err(|e| e.to_string())?;
        eprintln!("EXIT 两个 Peer 与解码子进程均已确认停止");
        Ok(())
    }
    pub(super) fn run_main() -> std::process::ExitCode {
        env_logger::init();
        let camera = surreal_ck_native_video_view::open_stream().expect("camera test stream");
        let screen = surreal_ck_native_video_view::open_stream().expect("screen test stream");
        let (command_tx, command_rx) = async_channel::bounded(8);
        let (update_tx, update_rx) = async_channel::bounded(16);
        let _ = CONTROLS.set(Controls {
            commands: command_tx.clone(),
            updates: update_rx,
            camera: camera.clone(),
            screen: screen.clone(),
        });
        let worker = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            runtime.block_on(async move {
                if let Err(error) = run(
                    command_rx,
                    update_tx.clone(),
                    camera.clone(),
                    screen.clone(),
                )
                .await
                {
                    camera.close();
                    screen.close();
                    report(&update_tx, format!("测试失败（未获通过）：{error}")).await;
                    Err(error)
                } else {
                    Ok(())
                }
            })
        });
        nsh_platform_linux::set_components(surreal_ck_native_video_view::linux::register);
        let result = nsh_platform_linux::run_app(
            nsh_platform_linux::AppSource::Rust(nsh_platform_linux::Root::of::<SyntheticVideo>()),
            nsh_platform_linux::AppOptions {
                title: "合成视频测试 · 非生产客户端".into(),
                app_id: "top.maplayer.synthetic-video-test".into(),
                size: (1000, 700),
                ..Default::default()
            },
        );
        // 关窗即关闭命令端；不被满队列或已经消失的 UI 接收端阻塞。
        command_tx.close();
        if !matches!(worker.join(), Ok(Ok(()))) {
            return std::process::ExitCode::FAILURE;
        }
        result.into()
    }
}

#[cfg(all(target_os = "linux", feature = "desktop"))]
fn main() -> std::process::ExitCode {
    linux::run_main()
}

#[cfg(not(all(target_os = "linux", feature = "desktop")))]
fn main() {
    eprintln!("合成视频测试宿主仅支持 Linux；请显式启用 --features desktop。");
}
