#![cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use bytes::Bytes;
use std::{process::Stdio, sync::Arc, time::Duration};
use surreal_ck_native_call::{CallSession, Error, Source};
use surreal_ck_peer_transport::{
    chat::Chat,
    media::Media,
    webrtc::{
        api::setting_engine::SettingEngine,
        media::io::ivf_reader::IVFReader,
        peer_connection::peer_connection_state::RTCPeerConnectionState,
        util::vnet::{
            net::{Net, NetConfig},
            router::{Router, RouterConfig},
        },
    },
    Peer, Route,
};
use tokio::{
    process::Command,
    sync::{mpsc, Mutex},
    time::{sleep, timeout},
};

// 只在测试中生成明确标注的合成源，不调用任何实际摄像头、麦克风或屏幕。
async fn synthetic_keyframe(width: u16, height: u16) -> Bytes {
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
        ])
        .arg(format!("testsrc2=size={width}x{height}:rate=10"))
        .args([
            "-frames:v",
            "1",
            "-c:v",
            "libvpx",
            "-threads",
            "1",
            "-deadline",
            "realtime",
            "-f",
            "ivf",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .expect("test requires installed FFmpeg/libvpx");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let (mut ivf, _) = IVFReader::new(output.stdout.as_slice()).unwrap();
    ivf.parse_next_frame().unwrap().0.freeze()
}
async fn pair() -> (Chat, Chat, Arc<Mutex<Router>>) {
    let router = Arc::new(Mutex::new(
        Router::new(RouterConfig {
            cidr: "10.6.0.0/24".into(),
            ..Default::default()
        })
        .unwrap(),
    ));
    let mut peers = Vec::new();
    for ip in ["10.6.0.1", "10.6.0.2"] {
        let net = Arc::new(Net::new(Some(NetConfig {
            static_ips: vec![ip.into()],
            ..Default::default()
        })));
        let nic = net.get_nic().unwrap();
        router.lock().await.add_net(nic.clone()).await.unwrap();
        nic.lock().await.set_router(router.clone()).await.unwrap();
        let mut settings = SettingEngine::default();
        settings.set_vnet(Some(net));
        peers.push(
            Peer::new_with_settings(Route::Direct, vec![], settings)
                .await
                .unwrap(),
        );
    }
    router.lock().await.start().await.unwrap();
    let (a, mut ae) = Chat::from_peer(peers.remove(0), true).await.unwrap();
    let (b, mut be) = Chat::from_peer(peers.remove(0), false).await.unwrap();
    // Chat 回调也必须被消费；任务在 peer 关闭后自行结束。
    tokio::spawn(async move { while ae.recv().await.is_some() {} });
    tokio::spawn(async move { while be.recv().await.is_some() {} });
    (a, b, router)
}
#[tokio::test]
async fn synthetic_ffmpeg_through_real_virtual_webrtc_decodes_camera_and_screen_to_sink() {
    timeout(Duration::from_secs(30), async {
        let (a, b, router) = pair().await;
        let (sender, mut feedback) = Media::attach(a.peer()).await.unwrap();
        let feedback = tokio::spawn(async move { while feedback.recv().await.is_some() {} });
        let (tx, mut received) = mpsc::channel(8);
        let (mut session, mut events) = CallSession::attach(
            &b,
            Arc::new(move |source, width, height, data| {
                tx.try_send((source, width, height, data))
                    .map_err(|e| e.to_string())
            }),
        )
        .await
        .unwrap();
        let events = tokio::spawn(async move { while events.recv().await.is_some() {} });
        for source in [Source::Camera, Source::Screen, Source::Microphone] {
            assert!(!session.capture_active(source));
        }
        assert!(matches!(
            CallSession::attach(&b, Arc::new(|_, _, _, _| Ok(()))).await,
            Err(Error::AlreadyNegotiated)
        ));
        a.accept_answer_json(&b.answer_json(&a.offer_json().await.unwrap()).await.unwrap())
            .await
            .unwrap();
        while a.peer().connection().connection_state() != RTCPeerConnectionState::Connected {
            sleep(Duration::from_millis(10)).await;
        }
        let camera = synthetic_keyframe(64, 48).await;
        let screen = synthetic_keyframe(96, 64).await;
        sender.set_enabled(Source::Camera, true);
        sender.set_enabled(Source::Screen, true);
        sender
            .send(Source::Camera, camera.clone(), Duration::from_millis(100))
            .await
            .unwrap();
        // 默认关闭远端解码/渲染，不因对端送帧自行开启。
        assert!(timeout(Duration::from_millis(150), received.recv())
            .await
            .is_err());
        session.set_remote_video_enabled(true).await.unwrap();
        for (source, frame) in [
            (Source::Camera, camera.clone()),
            (Source::Screen, screen.clone()),
        ] {
            sender
                .send(source, frame, Duration::from_millis(100))
                .await
                .unwrap();
        }
        let mut seen = [false; 2];
        for _ in 0..2 {
            let (source, width, height, rgba) = received.recv().await.unwrap();
            let expected = if source == Source::Camera {
                seen[0] = true;
                (64, 48)
            } else {
                seen[1] = true;
                (96, 64)
            };
            assert_eq!((width, height), expected);
            assert_eq!(rgba.len(), usize::from(width) * usize::from(height) * 4);
            assert!(rgba.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 255));
            assert!(rgba
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[0] != pixel[1]));
        }
        assert_eq!(seen, [true, true]);
        // 关键帧的安全尺寸改变会重建decoder，而非固定640×360或错误拼接。
        sender
            .send(Source::Camera, screen, Duration::from_millis(100))
            .await
            .unwrap();
        let (source, width, height, _) = received.recv().await.unwrap();
        assert_eq!((source, width, height), (Source::Camera, 96, 64));
        session.set_remote_video_enabled(false).await.unwrap();
        sender
            .send(Source::Camera, camera.clone(), Duration::from_millis(100))
            .await
            .unwrap();
        assert!(timeout(Duration::from_millis(150), received.recv())
            .await
            .is_err());
        session.set_remote_video_enabled(true).await.unwrap();
        sender
            .send(Source::Camera, camera, Duration::from_millis(100))
            .await
            .unwrap();
        assert_eq!(received.recv().await.unwrap().1, 64);
        // 与Chat独立的断开监测也必须终止媒体，禁止迟到命令恢复播放。
        b.close().await.unwrap();
        sleep(Duration::from_millis(200)).await;
        assert!(matches!(
            session.set_remote_audio_enabled(true).await,
            Err(Error::Stopped)
        ));
        session.stop().await.unwrap();
        session.stop().await.unwrap();
        assert!(matches!(
            session.set_remote_video_enabled(true).await,
            Err(Error::Stopped)
        ));
        drop(session);
        a.close().await.unwrap();
        feedback.abort();
        events.abort();
        router.lock().await.stop().await.unwrap();
    })
    .await
    .expect("synthetic encode → real virtual WebRTC → decode → RGBA sink timed out");
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn absent_device_is_an_error_and_never_enables_a_source() {
    use surreal_ck_native_call::{CaptureInput, VideoConfig};
    let (chat, _events) = Chat::new(true, Route::Direct, vec![]).await.unwrap();
    let (mut session, _events) = CallSession::attach(
        &chat,
        Arc::new(|_, _, _, _| panic!("no synthetic fallback allowed")),
    )
    .await
    .unwrap();
    let result = session
        .start_capture(
            Source::Camera,
            CaptureInput::Camera {
                device: "/dev/video999999".into(),
                video: VideoConfig {
                    width: 64,
                    height: 48,
                    fps: 10,
                },
            },
        )
        .await;
    assert!(result.is_err());
    assert!(!session.capture_active(Source::Camera));
    session.stop().await.unwrap();
    chat.close().await.unwrap();
}
