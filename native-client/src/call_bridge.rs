//! 仅把本机明确操作转成真实媒体控制；收到聊天/SDP/媒体帧不会选择设备。
#[cfg(not(all(target_os = "android", feature = "android-native-media")))]
use async_channel::Sender;
#[cfg(not(all(target_os = "android", feature = "android-native-media")))]
use surreal_ck_peer_transport::chat::Chat;
pub use surreal_ck_peer_transport::media::Source;

#[cfg(not(all(target_os = "android", feature = "android-native-media")))]
use crate::bridge::Update;

// Android共用UI协议，但媒体宿主未接入，明确拒绝这些操作。
#[cfg_attr(target_os = "android", allow(dead_code))]
#[derive(Debug, Clone)]
pub enum Control {
    /// 仅企业UI适配队列使用；真实媒体actor必须先解包。
    #[cfg(feature = "experimental-enterprise-media")]
    Tagged {
        ticket: u64,
        control: Box<Control>,
    },
    #[cfg(all(target_os = "android", feature = "android-native-media"))]
    OpenNativeMedia,
    #[cfg(all(target_os = "android", feature = "android-native-media"))]
    StopAllNativeMedia,
    /// Linux: /dev/videoN、Pulse source 或 :0.0+0,0；Windows: dshow名或x,y；macOS: 本次确认的AVFoundation索引。
    Start {
        source: Source,
        selection: String,
    },
    Stop(Source),
    RemoteVideo(bool),
    RemoteAudio(bool),
}
impl Control {
    pub fn action(&self) -> &Self {
        #[cfg(feature = "experimental-enterprise-media")]
        if let Self::Tagged { control, .. } = self {
            return control.action();
        }
        self
    }
    #[cfg(feature = "experimental-enterprise-media")]
    pub fn ticket(&self) -> Option<u64> {
        match self {
            Self::Tagged { ticket, .. } => Some(*ticket),
            _ => None,
        }
    }
    #[cfg(feature = "experimental-enterprise-media")]
    pub fn into_action(self) -> Self {
        match self {
            Self::Tagged { control, .. } => control.into_action(),
            other => other,
        }
    }
    pub fn source(&self) -> Option<Source> {
        match self.action() {
            Self::Start { source, .. } | Self::Stop(source) => Some(*source),
            _ => None,
        }
    }
}
#[cfg_attr(target_os = "android", allow(dead_code))]
#[derive(Debug, Clone)]
pub enum Notice {
    #[cfg(all(target_os = "android", feature = "android-native-media"))]
    CapturePending(Source),
    #[cfg(all(target_os = "android", feature = "android-native-media"))]
    CaptureStopping(Source),
    #[cfg(all(target_os = "android", feature = "android-native-media"))]
    CaptureUnconfirmed(Source),
    Capture {
        source: Source,
        active: bool,
    },
    RemoteVideo {
        enabled: bool,
        camera_stream: Option<String>,
        screen_stream: Option<String>,
    },
    RemoteAudio(bool),
    VideoPresented(Source),
    RemoteEnded(Source),
    Failed {
        source: Option<Source>,
        message: String,
    },
    PlaybackFailed {
        source: Option<Source>,
        message: String,
    },
    /// 未确认时 UI 必须保留采集指示并突出警告，不得用一般断线状态覆盖。
    Stopped {
        confirmed: bool,
        message: Option<String>,
    },
}
pub fn capture_supported() -> bool {
    surreal_ck_native_call::supported()
}
pub fn experimental_video_host() -> bool {
    cfg!(any(
        all(target_os = "macos", feature = "experimental-macos-video"),
        all(
            target_os = "windows",
            feature = "experimental-windows-video"
        )
    ))
}
pub fn video_supported() -> bool {
    (cfg!(target_os = "linux") || experimental_video_host())
        && surreal_ck_native_video_view::rendering_supported()
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod desktop {
    use super::*;
    use std::sync::{Arc, Mutex};
    use surreal_ck_native_call::{
        CallEvent, CallSession, CaptureInput, CaptureState, CaptureStatus, VideoConfig,
    };
    use surreal_ck_native_video_view::{FramePublisher, RgbaFrame, open_stream};
    use tokio::{
        sync::{mpsc, oneshot},
        task::JoinHandle,
    };

    #[derive(Default)]
    struct Streams {
        camera: Option<FramePublisher>,
        screen: Option<FramePublisher>,
    }
    impl Streams {
        fn close(&mut self) {
            for stream in [self.camera.take(), self.screen.take()]
                .into_iter()
                .flatten()
            {
                stream.close();
            }
        }
        fn open(&mut self) -> Result<(), String> {
            self.close();
            let camera = open_stream().map_err(|e| e.to_string())?;
            let screen = match open_stream() {
                Ok(screen) => screen,
                Err(error) => {
                    camera.close();
                    return Err(error.to_string());
                }
            };
            self.camera = Some(camera);
            self.screen = Some(screen);
            Ok(())
        }
        fn notice(&self, enabled: bool) -> Notice {
            Notice::RemoteVideo {
                enabled,
                camera_stream: if enabled {
                    self.camera.as_ref().map(|s| s.id().to_owned())
                } else {
                    None
                },
                screen_stream: if enabled {
                    self.screen.as_ref().map(|s| s.id().to_owned())
                } else {
                    None
                },
            }
        }
        fn close_source(&mut self, source: Source) {
            let slot = match source {
                Source::Camera => &mut self.camera,
                Source::Screen => &mut self.screen,
                Source::Microphone => return,
            };
            if let Some(stream) = slot.take() {
                stream.close();
            }
        }
    }
    pub struct Call {
        session: CallSession,
        streams: Arc<Mutex<Streams>>,
        output: Sender<Update>,
        flush: mpsc::Sender<oneshot::Sender<()>>,
        pump: JoinHandle<()>,
    }
    impl Call {
        #[cfg(feature = "experimental-enterprise-media")]
        pub fn capture_state(&self) -> tokio::sync::watch::Receiver<CaptureState> {
            self.session.capture_state()
        }
        #[cfg(feature = "experimental-enterprise-media")]
        pub fn playback_state(&self) -> tokio::sync::watch::Receiver<CaptureState> {
            self.session.playback_state()
        }
        #[cfg(feature = "experimental-enterprise-media")]
        pub fn video_streams(&self) -> [Option<String>; 2] {
            let streams = self.streams.lock().unwrap_or_else(|p| p.into_inner());
            [
                streams.camera.as_ref().map(|s| s.id().to_owned()),
                streams.screen.as_ref().map(|s| s.id().to_owned()),
            ]
        }
        pub async fn attach(chat: &Chat, output: Sender<Update>) -> Result<Self, String> {
            let streams = Arc::new(Mutex::new(Streams::default()));
            let sink_streams = streams.clone();
            let (session, mut events) = CallSession::attach(
                chat,
                Arc::new(move |source, width, height, rgba| {
                    let stream = {
                        let streams = sink_streams
                            .lock()
                            .map_err(|_| "视频流状态异常".to_owned())?;
                        match source {
                            Source::Camera => streams.camera.clone(),
                            Source::Screen => streams.screen.clone(),
                            Source::Microphone => None,
                        }
                    }
                    .ok_or_else(|| "远端视频视图未启用".to_owned())?;
                    let frame = RgbaFrame::packed(u32::from(width), u32::from(height), rgba)
                        .map_err(|e| e.to_string())?;
                    stream.present(frame).map(|_| ()).map_err(|e| e.to_string())
                }),
            )
            .await
            .map_err(|e| e.to_string())?;
            let mut states = session.capture_state();
            let event_streams = streams.clone();
            let event_output = output.clone();
            let (flush, mut barriers) = mpsc::channel::<oneshot::Sender<()>>(1);
            let pump = tokio::spawn(async move {
                let mut previous = states.borrow().clone();
                loop {
                    let mut acknowledgement = None;
                    tokio::select! {
                        biased;
                        event = events.recv() => {
                            let Some(event) = event else { break; };
                            let current = states.borrow().clone();
                            forward(event, &event_streams, &event_output, &current).await;
                        }
                        changed = states.changed() => { if changed.is_err() { break; } }
                        barrier = barriers.recv() => {
                            let Some(barrier) = barrier else { break; };
                            acknowledgement = Some(barrier);
                        }
                    }
                    // 先清旧普通事件，最后发布权威快照，防止迟到Started/Stopped覆盖新状态。
                    while let Ok(event) = events.try_recv() {
                        let current = states.borrow().clone();
                        forward(event, &event_streams, &event_output, &current).await;
                    }
                    let current = states.borrow_and_update().clone();
                    forward_states(&current, &previous, &event_output).await;
                    previous = current;
                    if let Some(acknowledgement) = acknowledgement {
                        let _ = acknowledgement.send(());
                    }
                }
            });
            Ok(Self {
                session,
                streams,
                output,
                flush,
                pump,
            })
        }
        pub async fn control(&mut self, control: Control) {
            let source = control.source();
            let playback = match &control {
                Control::RemoteAudio(enabled) => Some((false, *enabled)),
                Control::RemoteVideo(enabled) => Some((true, *enabled)),
                _ => None,
            };
            let result = self.apply(control).await;
            self.flush_events().await;
            // 普通媒体事件允许丢弃，成功的用户命令确认不能依赖try_send通知。
            // 排空旧事件后，再可靠发送本次配置的最终确认（不代表已收到媒体）。
            if result.is_ok()
                && let Some((video, enabled)) = playback
            {
                let notice = if video {
                    self.streams
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .notice(enabled)
                } else {
                    Notice::RemoteAudio(enabled)
                };
                let _ = self.output.send(Update::Media(notice)).await;
            }
            if let Err(message) = result {
                let notice = if playback.is_some() {
                    Notice::PlaybackFailed { source, message }
                } else {
                    Notice::Failed { source, message }
                };
                let _ = self.output.send(Update::Media(notice)).await;
                // 选择无效、未启动进程等情形也可从权威状态明确解除等待；未知关闭绝不清除。
                if let Some(source) = source {
                    let snapshot = self.session.capture_state().borrow().clone();
                    let status = snapshot.status(source);
                    if status != CaptureStatus::Unconfirmed {
                        let _ = self
                            .output
                            .send(Update::Media(Notice::Capture {
                                source,
                                active: status == CaptureStatus::Running,
                            }))
                            .await;
                    }
                }
            }
        }
        async fn flush_events(&self) {
            let (ack, done) = oneshot::channel();
            if self.flush.send(ack).await.is_ok() {
                let _ = done.await;
            }
        }
        async fn apply(&mut self, control: Control) -> Result<(), String> {
            match control {
                #[cfg(feature = "experimental-enterprise-media")]
                Control::Tagged { .. } => Err("企业控制标签未通过受控句柄，未执行设备操作".into()),
                Control::Start { source, selection } => {
                    let input = selected_input(source, &selection)?;
                    self.session
                        .start_capture(source, input)
                        .await
                        .map_err(|e| e.to_string())
                }
                Control::Stop(source) => self
                    .session
                    .stop_capture(source)
                    .await
                    .map_err(|e| e.to_string()),
                Control::RemoteAudio(enabled) => self
                    .session
                    .set_remote_audio_enabled(enabled)
                    .await
                    .map_err(|e| e.to_string()),
                Control::RemoteVideo(enabled) => {
                    if enabled && !video_supported() {
                        return Err("当前平台尚无已接线的原生视频视图，不能开启远端视频".into());
                    }
                    // 先停止旧decoder，再关闭旧stream。每次显式重新启用使用全新ID。
                    self.session
                        .set_remote_video_enabled(false)
                        .await
                        .map_err(|e| e.to_string())?;
                    // 旧decoder已停止，但队列中可能仍有RemoteEnded/Failed。
                    // 必须先排空旧事件，再发布新stream，避免旧终止事件关闭新画面。
                    self.flush_events().await;
                    self.streams.lock().map_err(|_| "视频流状态异常")?.close();
                    if !enabled {
                        return Ok(());
                    }
                    self.streams.lock().map_err(|_| "视频流状态异常")?.open()?;
                    if let Err(error) = self.session.set_remote_video_enabled(true).await {
                        self.streams.lock().map_err(|_| "视频流状态异常")?.close();
                        let _ = self.session.set_remote_video_enabled(false).await;
                        return Err(error.to_string());
                    }
                    Ok(())
                }
            }
        }
        pub async fn shutdown(&mut self) -> Result<(), String> {
            let result = self.session.stop().await.map_err(|e| e.to_string());
            self.flush_events().await;
            self.streams
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .close();
            let _ = self
                .output
                .send(Update::Media(Notice::RemoteVideo {
                    enabled: false,
                    camera_stream: None,
                    screen_stream: None,
                }))
                .await;
            let _ = self
                .output
                .send(Update::Media(Notice::Stopped {
                    confirmed: result.is_ok(),
                    message: result.as_ref().err().cloned(),
                }))
                .await;
            self.pump.abort();
            result
        }
    }
    impl Drop for Call {
        fn drop(&mut self) {
            self.streams
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .close();
            self.pump.abort();
        }
    }
    async fn forward(
        event: CallEvent,
        streams: &Arc<Mutex<Streams>>,
        output: &Sender<Update>,
        state: &CaptureState,
    ) {
        let notice = match event {
            // 权威watch快照独占隐私状态，普通事件只能作为兼容通知，不能覆盖它。
            CallEvent::CaptureStarted(_) | CallEvent::CaptureStopped(_) => return,
            // 配置确认由control()在命令返回后可靠发送，普通队列可能丢失或迟到。
            CallEvent::RemoteVideoEnabled(_) | CallEvent::RemoteAudioEnabled(_) => return,
            CallEvent::VideoPresented(source) => Notice::VideoPresented(source),
            CallEvent::RemoteEnded(source) => {
                streams
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .close_source(source);
                Notice::RemoteEnded(source)
            }
            CallEvent::Failed { source, message } => {
                if source.is_some_and(|source| state.error(source) == Some(message.as_str())) {
                    return;
                }
                if source.is_none() {
                    streams.lock().unwrap_or_else(|p| p.into_inner()).close();
                }
                Notice::PlaybackFailed { source, message }
            }
            // 仅shutdown()将 stop() 的明确返回值发给UI，避免与event pump重复或乱序。
            CallEvent::Stopped => return,
        };
        let _ = output.send(Update::Media(notice)).await;
    }
    async fn forward_states(
        current: &CaptureState,
        previous: &CaptureState,
        output: &Sender<Update>,
    ) {
        for source in [Source::Microphone, Source::Camera, Source::Screen] {
            if current.revision(source) == previous.revision(source) {
                continue;
            }
            let status = current.status(source);
            if status != CaptureStatus::Unconfirmed {
                let _ = output
                    .send(Update::Media(Notice::Capture {
                        source,
                        active: status == CaptureStatus::Running,
                    }))
                    .await;
            }
            if current.error(source) != previous.error(source)
                && let Some(message) = current.error(source)
            {
                let _ = output
                    .send(Update::Media(Notice::Failed {
                        source: Some(source),
                        message: message.to_owned(),
                    }))
                    .await;
            }
        }
    }
    fn video() -> VideoConfig {
        VideoConfig {
            width: 640,
            height: 360,
            fps: 15,
        }
    }
    fn selected_input(source: Source, selection: &str) -> Result<CaptureInput, String> {
        let selection = selection.trim();
        if selection.is_empty() || selection.len() > 512 || selection.chars().any(char::is_control)
        {
            return Err("请先明确填写并确认本次采集设备或640×360屏幕区域".into());
        }
        #[cfg(target_os = "linux")]
        return match source {
            Source::Camera => Ok(CaptureInput::Camera {
                device: selection.into(),
                video: video(),
            }),
            Source::Microphone => Ok(CaptureInput::Microphone {
                source: selection.into(),
            }),
            Source::Screen => {
                validate_x11_region(selection)?;
                Ok(CaptureInput::X11Screen {
                    display: selection.into(),
                    video: video(),
                })
            }
        };
        #[cfg(target_os = "macos")]
        {
            let device_index = selection
                .parse::<u32>()
                .map_err(|_| "请填写本次枚举并确认的AVFoundation数字索引")?;
            return Ok(match source {
                Source::Microphone => CaptureInput::MacMicrophone { device_index },
                Source::Camera | Source::Screen => CaptureInput::MacVideo {
                    device_index,
                    video: video(),
                },
            });
        }
        #[cfg(target_os = "windows")]
        return match source {
            Source::Camera => Ok(CaptureInput::WindowsCamera {
                device: selection.into(),
                video: video(),
            }),
            Source::Microphone => Ok(CaptureInput::WindowsMicrophone {
                device: selection.into(),
            }),
            Source::Screen => {
                let (x, y) = parse_origin(selection)?;
                Ok(CaptureInput::WindowsScreen {
                    x,
                    y,
                    video: video(),
                })
            }
        };
    }
    #[cfg(any(target_os = "windows", test))]
    fn parse_origin(selection: &str) -> Result<(i32, i32), String> {
        let (x, y) = selection
            .split_once(',')
            .ok_or("屏幕区域必须是明确的x,y左上角，宽640高360")?;
        let x = x.trim().parse::<i32>().map_err(|_| "屏幕x坐标无效")?;
        let y = y.trim().parse::<i32>().map_err(|_| "屏幕y坐标无效")?;
        x.checked_add(640).ok_or("屏幕x坐标越界")?;
        y.checked_add(360).ok_or("屏幕y坐标越界")?;
        Ok((x, y))
    }
    #[cfg(any(target_os = "linux", test))]
    fn validate_x11_region(selection: &str) -> Result<(), String> {
        let (display, origin) = selection
            .split_once('+')
            .ok_or("请填写明确X11区域，例如 :0.0+0,0；宽640高360，不是全屏或窗口选择器")?;
        let display = display
            .strip_prefix(':')
            .ok_or("仅支持明确的本机X11 display")?;
        let mut parts = display.split('.');
        parts
            .next()
            .filter(|v| !v.is_empty())
            .ok_or("X11 display无效")?
            .parse::<u16>()
            .map_err(|_| "X11 display无效")?;
        if let Some(screen) = parts.next() {
            screen.parse::<u16>().map_err(|_| "X11 screen无效")?;
        }
        if parts.next().is_some() {
            return Err("X11 display无效".into());
        }
        let (x, y) = origin.split_once(',').ok_or("X11区域必须明确给出+x,y")?;
        let x = x.parse::<u32>().map_err(|_| "X11 x坐标无效")?;
        let y = y.parse::<u32>().map_err(|_| "X11 y坐标无效")?;
        if x > i32::MAX as u32 - 640 || y > i32::MAX as u32 - 360 {
            return Err("X11区域坐标越界".into());
        }
        Ok(())
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn selection_never_defaults_to_a_device_or_whole_screen() {
            for source in [Source::Camera, Source::Microphone, Source::Screen] {
                assert!(selected_input(source, "").is_err());
            }
            assert!(validate_x11_region(":0.0").is_err());
            assert!(validate_x11_region("remote:0.0+0,0").is_err());
            assert!(validate_x11_region(":0.0+0,0").is_ok());
            assert!(validate_x11_region(":0.0+0,-1").is_err());
            assert_eq!(parse_origin("-1920,0").unwrap(), (-1920, 0));
            assert!(parse_origin("0,0,0").is_err());
            assert!(parse_origin("2147483647,0").is_err());
        }
        #[test]
        fn disabling_streams_clears_frames_and_reenable_uses_new_ids() {
            let mut streams = Streams::default();
            streams.open().unwrap();
            let camera = streams.camera.as_ref().unwrap().clone();
            let first = camera.id().to_owned();
            camera
                .present(RgbaFrame::packed(1, 1, vec![0, 0, 0, 255].into()).unwrap())
                .unwrap();
            streams.close();
            assert!(
                camera
                    .present(RgbaFrame::packed(1, 1, vec![0, 0, 0, 255].into()).unwrap())
                    .is_err()
            );
            streams.open().unwrap();
            assert_ne!(first, streams.camera.as_ref().unwrap().id());
            streams.close();
        }
        #[tokio::test]
        async fn delayed_capture_events_cannot_overwrite_the_authoritative_snapshot() {
            let streams = Arc::new(Mutex::new(Streams::default()));
            let (output, updates) = async_channel::bounded(8);
            forward(
                CallEvent::CaptureStarted(Source::Camera),
                &streams,
                &output,
                &CaptureState::default(),
            )
            .await;
            forward(
                CallEvent::CaptureStopped(Source::Camera),
                &streams,
                &output,
                &CaptureState::default(),
            )
            .await;
            assert!(updates.try_recv().is_err());
        }
        #[tokio::test]
        async fn invalid_selection_can_be_explicitly_confirmed_stopped_without_a_device() {
            use surreal_ck_peer_transport::Route;
            let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
            let (output, updates) = async_channel::bounded(32);
            let mut call = Call::attach(&chat, output).await.unwrap();
            call.control(Control::Start {
                source: Source::Camera,
                selection: String::new(),
            })
            .await;
            assert!(matches!(
                updates.recv().await.unwrap(),
                Update::Media(Notice::Failed {
                    source: Some(Source::Camera),
                    ..
                })
            ));
            assert!(matches!(
                updates.recv().await.unwrap(),
                Update::Media(Notice::Capture {
                    source: Source::Camera,
                    active: false
                })
            ));
            call.control(Control::Stop(Source::Camera)).await;
            assert!(matches!(
                updates.recv().await.unwrap(),
                Update::Media(Notice::Capture {
                    source: Source::Camera,
                    active: false
                })
            ));
            call.shutdown().await.unwrap();
            chat.close().await.unwrap();
        }
        #[tokio::test]
        async fn receiver_failure_is_not_a_local_capture_shutdown_failure() {
            let (output, updates) = async_channel::bounded(2);
            let streams = Arc::new(Mutex::new(Streams::default()));
            let state = CaptureState::default();
            forward(
                CallEvent::Failed {
                    source: Some(Source::Camera),
                    message: "invalid remote frame".into(),
                },
                &streams,
                &output,
                &state,
            )
            .await;
            assert!(matches!(
                updates.recv().await.unwrap(),
                Update::Media(Notice::PlaybackFailed {
                    source: Some(Source::Camera),
                    ..
                })
            ));
            forward(
                CallEvent::RemoteAudioEnabled(true),
                &streams,
                &output,
                &state,
            )
            .await;
            assert!(updates.try_recv().is_err());
        }
        #[tokio::test]
        async fn repeated_playback_configuration_finishes_with_reliable_confirmation() {
            use surreal_ck_peer_transport::Route;
            let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
            let (output, updates) = async_channel::bounded(64);
            let mut call = Call::attach(&chat, output).await.unwrap();
            for enabled in [true, false, true, false] {
                // 只改变接收许可；没有远端数据时不打开音频设备。
                call.control(Control::RemoteAudio(enabled)).await;
                let mut last = None;
                while let Ok(update) = updates.try_recv() {
                    last = Some(update);
                }
                assert!(
                    matches!(last, Some(Update::Media(Notice::RemoteAudio(value))) if value == enabled)
                );
            }
            for _ in 0..2 {
                call.control(Control::RemoteVideo(false)).await;
                let mut last = None;
                while let Ok(update) = updates.try_recv() {
                    last = Some(update);
                }
                assert!(matches!(
                    last,
                    Some(Update::Media(Notice::RemoteVideo {
                        enabled: false,
                        camera_stream: None,
                        screen_stream: None
                    }))
                ));
            }
            call.shutdown().await.unwrap();
            chat.close().await.unwrap();
        }
        #[tokio::test]
        async fn shutdown_flushes_actual_state_before_confirming_and_stops_pump() {
            use surreal_ck_peer_transport::Route;
            let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
            let (output, updates) = async_channel::bounded(32);
            let mut call = Call::attach(&chat, output).await.unwrap();
            call.control(Control::RemoteAudio(false)).await;
            call.shutdown().await.unwrap();
            let mut audio = false;
            let mut stopped = false;
            let mut closed = [false; 3];
            while let Ok(update) = updates.try_recv() {
                match update {
                    Update::Media(Notice::Capture {
                        source,
                        active: false,
                    }) => {
                        assert!(!stopped);
                        closed[match source {
                            Source::Microphone => 0,
                            Source::Camera => 1,
                            Source::Screen => 2,
                        }] = true;
                    }
                    Update::Media(Notice::RemoteAudio(false)) => {
                        assert!(!stopped);
                        audio = true;
                    }
                    Update::Media(Notice::Stopped {
                        confirmed: true, ..
                    }) => {
                        assert!(audio);
                        assert_eq!(closed, [true; 3]);
                        stopped = true;
                    }
                    _ => {}
                }
            }
            assert!(stopped);
            chat.close().await.unwrap();
        }
    }
}
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub use desktop::Call;

#[cfg(not(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows",
    all(target_os = "android", feature = "android-native-media")
)))]
pub struct Call {
    output: Sender<Update>,
}
#[cfg(not(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows",
    all(target_os = "android", feature = "android-native-media")
)))]
impl Call {
    #[cfg(feature = "experimental-enterprise-media")]
    pub fn capture_state(&self) -> tokio::sync::watch::Receiver<()> {
        tokio::sync::watch::channel(()).1
    }
    pub async fn attach(_chat: &Chat, output: Sender<Update>) -> Result<Self, String> {
        Ok(Self { output })
    }
    pub async fn control(&mut self, control: Control) {
        let _ = self
            .output
            .send(Update::Media(Notice::Failed {
                source: control.source(),
                message: "此平台的原生通话权限/采集/播放桥接尚未接通；不会打开设备".into(),
            }))
            .await;
    }
    pub async fn shutdown(&mut self) -> Result<(), String> {
        let _ = self
            .output
            .send(Update::Media(Notice::Stopped {
                confirmed: true,
                message: None,
            }))
            .await;
        Ok(())
    }
}

#[cfg(all(target_os = "android", feature = "android-native-media"))]
pub use crate::android_call_bridge::Call;

pub fn android_media_supported() -> bool {
    #[cfg(all(target_os = "android", feature = "android-native-media"))]
    {
        surreal_ck_native_media_platform::android::available()
    }
    #[cfg(not(all(target_os = "android", feature = "android-native-media")))]
    {
        false
    }
}

#[cfg(feature = "experimental-enterprise-media")]
#[path = "enterprise_media.rs"]
mod enterprise;
#[cfg(feature = "experimental-enterprise-media")]
pub use enterprise::{CapturePhase, EnterpriseCall, EnterpriseCaptureState, EnterpriseMediaHandle};
