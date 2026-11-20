#![cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use bytes::Bytes;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use surreal_ck_native_call::{meeting::*, CaptureStatus, Error, Source};
use surreal_ck_peer_transport::{
    media::{Event, Media},
    meeting::{offer_hash, Attempt, EdgeKey, JoinId, MeetingEdge, RoomId, RouteKind},
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
    sync::{mpsc, Mutex},
    time::{sleep, timeout},
};

fn slot(member: &str, join: &str) -> MemberSlot {
    MemberSlot {
        member_id: member.into(),
        join_id: JoinId::new(join).unwrap(),
    }
}
fn video() -> Bytes {
    let (mut reader, _) = IVFReader::new(
        include_bytes!("../../native-transport/tests/fixtures/test.vp8.ivf").as_slice(),
    )
    .unwrap();
    reader.parse_next_frame().unwrap().0.freeze()
}
fn audio() -> Bytes {
    Bytes::from_static(include_bytes!(
        "../../native-transport/tests/fixtures/test.opus.packet"
    ))
}
struct Synthetic {
    frames: mpsc::Receiver<Encoded>,
    reads: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
    fail_stop: bool,
}
impl EncodedCapture for Synthetic {
    fn next(&mut self) -> MediaFuture<'_, Encoded> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { self.frames.recv().await.ok_or(Error::Stopped) })
    }
    fn stop(&mut self) -> MediaFuture<'_, ()> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if self.fail_stop {
                Err(Error::Backend("测试关闭未确认".into()))
            } else {
                Ok(())
            }
        })
    }
}
fn capture(
    fail_stop: bool,
) -> (
    mpsc::Sender<Encoded>,
    Box<Synthetic>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
) {
    let (tx, frames) = mpsc::channel(16);
    let reads = Arc::new(AtomicUsize::new(0));
    let stops = Arc::new(AtomicUsize::new(0));
    (
        tx,
        Box::new(Synthetic {
            frames,
            reads: reads.clone(),
            stops: stops.clone(),
            fail_stop,
        }),
        reads,
        stops,
    )
}
fn encoded(source: Source) -> Encoded {
    if source == Source::Microphone {
        Encoded::Audio {
            data: audio(),
            duration: Duration::from_millis(20),
        }
    } else {
        Encoded::Video {
            data: video(),
            duration: Duration::from_millis(100),
        }
    }
}
async fn frame_pair(received: &mut mpsc::Receiver<Event>) {
    let mut seen = [false; 2];
    while seen.iter().any(|v| !v) {
        if let Some(Event::Frame { source, data, .. }) = received.recv().await {
            match source {
                Source::Microphone => {
                    assert_eq!(data, audio());
                    seen[0] = true;
                }
                Source::Camera => {
                    assert_eq!(data, video());
                    seen[1] = true;
                }
                _ => {}
            }
        }
    }
}
#[tokio::test]
async fn capture_once_fans_out_and_stalled_member_does_not_block_or_renegotiate() {
    timeout(Duration::from_secs(35), async {
        let router = Arc::new(Mutex::new(
            Router::new(RouterConfig {
                cidr: "10.8.0.0/24".into(),
                ..Default::default()
            })
            .unwrap(),
        ));
        let mut pairs = Vec::new();
        for (index, remote) in ["b", "c", "d"].into_iter().enumerate() {
            let local = JoinId::new("a").unwrap();
            let remote = JoinId::new(remote).unwrap();
            let attempt = Attempt {
                edge: EdgeKey::new(RoomId::new("room").unwrap(), local.clone(), remote.clone())
                    .unwrap(),
                attempt_no: 1,
                nonce: [index as u8; 16],
                route: RouteKind::Direct,
                expires_at: std::time::Instant::now() + Duration::from_secs(30),
            };
            let mut ends = Vec::new();
            for (offset, join) in [local, remote].into_iter().enumerate() {
                let net = Arc::new(Net::new(Some(NetConfig {
                    static_ips: vec![format!("10.8.0.{}", index * 2 + offset + 1)],
                    ..Default::default()
                })));
                let nic = net.get_nic().unwrap();
                router.lock().await.add_net(nic.clone()).await.unwrap();
                nic.lock().await.set_router(router.clone()).await.unwrap();
                let mut settings = SettingEngine::default();
                settings.set_vnet(Some(net));
                ends.push(
                    MeetingEdge::new(attempt.clone(), join, Route::Direct, vec![], settings)
                        .await
                        .unwrap(),
                );
            }
            pairs.push(ends);
        }
        router.lock().await.start().await.unwrap();
        let (mut meeting, mut meeting_events) = MeetingMedia::new(Arc::new(|_, _, _, _| Ok(())));
        let mut received = Vec::new();
        for (index, ends) in pairs.iter_mut().enumerate() {
            let offer = ends[0].offer().await.unwrap();
            let hash = offer_hash(&offer);
            let answer = ends[1].answer(offer).await.unwrap();
            ends[0].accept_answer(answer, hash).await.unwrap();
            for end in ends.iter() {
                while end.connection_state() != RTCPeerConnectionState::Connected {
                    sleep(Duration::from_millis(10)).await;
                }
            }
            let events = ends[0].take_events().unwrap();
            meeting
                .attach_edge(
                    slot(["b", "c", "d"][index], ["b", "c", "d"][index]),
                    ends[0].media(),
                    events,
                )
                .await
                .unwrap();
            received.push(ends[1].take_events().unwrap());
        }
        let extra = Peer::new(Route::Direct, vec![]).await.unwrap();
        let (extra_media, extra_events) = Media::attach(&extra).await.unwrap();
        assert!(meeting
            .attach_edge(slot("extra", "extra"), Arc::new(extra_media), extra_events)
            .await
            .is_err());
        let (video_tx, capture_video, video_reads, video_stops) = capture(false);
        let (audio_tx, capture_audio, audio_reads, audio_stops) = capture(false);
        video_tx.send(encoded(Source::Camera)).await.unwrap();
        audio_tx.send(encoded(Source::Microphone)).await.unwrap();
        meeting
            .start_capture_with(Source::Camera, capture_video)
            .await
            .unwrap();
        meeting
            .start_capture_with(Source::Microphone, capture_audio)
            .await
            .unwrap();
        frame_pair(&mut received[0]).await;
        frame_pair(&mut received[1]).await;
        // 第三条边的远端队列从不消费，填满后也不能拖住 B/C。
        for _ in 0..140 {
            video_tx.send(encoded(Source::Camera)).await.unwrap();
            audio_tx.send(encoded(Source::Microphone)).await.unwrap();
            frame_pair(&mut received[0]).await;
            frame_pair(&mut received[1]).await;
        }
        assert!(video_reads.load(Ordering::SeqCst) <= 142);
        assert!(audio_reads.load(Ordering::SeqCst) <= 142);
        meeting.detach_edge(&slot("c", "c")).await.unwrap();
        assert_eq!(
            pairs[0][0].connection_state(),
            RTCPeerConnectionState::Connected
        );
        video_tx.send(encoded(Source::Camera)).await.unwrap();
        audio_tx.send(encoded(Source::Microphone)).await.unwrap();
        frame_pair(&mut received[0]).await;
        while let Ok(event) = meeting_events.try_recv() {
            assert!(!matches!(event, MeetingEvent::EdgeFailed { .. }));
        }
        pairs[2][0].close().await.unwrap();
        video_tx.send(encoded(Source::Camera)).await.unwrap();
        audio_tx.send(encoded(Source::Microphone)).await.unwrap();
        frame_pair(&mut received[0]).await;
        loop {
            if let Some(MeetingEvent::EdgeFailed { slot: failed, .. }) = meeting_events.recv().await
            {
                assert_eq!(failed, slot("d", "d"));
                break;
            }
        }
        assert_eq!(
            meeting.capture_state().borrow().status(Source::Camera),
            CaptureStatus::Running
        );
        assert_eq!(
            meeting.capture_state().borrow().status(Source::Microphone),
            CaptureStatus::Running
        );
        meeting.shutdown().await.unwrap();
        meeting.shutdown().await.unwrap();
        assert_eq!(video_stops.load(Ordering::SeqCst), 1);
        assert_eq!(audio_stops.load(Ordering::SeqCst), 1);
        assert_eq!(
            meeting.capture_state().borrow().status(Source::Camera),
            CaptureStatus::Stopped
        );
        for ends in pairs {
            for end in ends {
                end.close().await.unwrap();
            }
        }
        extra.close().await.unwrap();
        router.lock().await.stop().await.unwrap();
    })
    .await
    .expect("会议采集扇出超时");
}

#[tokio::test]
async fn receive_consumers_and_render_slots_are_isolated_and_rejoin_retires_old_slot() {
    timeout(Duration::from_secs(20), async {
        let (rendered, mut frames) = mpsc::channel(8);
        let (mut meeting, _events) = MeetingMedia::new(Arc::new(move |slot, w, h, data| {
            rendered
                .try_send((slot.clone(), w, h, data))
                .map_err(|e| e.to_string())
        }));
        let mut peers = Vec::new();
        let mut incoming = Vec::new();
        for member in [slot("b", "b1"), slot("c", "c1")] {
            let peer = Peer::new(Route::Direct, vec![]).await.unwrap();
            let (media, _events) = Media::attach(&peer).await.unwrap();
            let (tx, rx) = mpsc::channel(8);
            meeting
                .attach_edge(member, Arc::new(media), rx)
                .await
                .unwrap();
            incoming.push(tx);
            peers.push(peer);
        }
        let b = slot("b", "b1");
        let c = slot("c", "c1");
        let b_state = meeting.playback_state(&b).unwrap();
        let c_state = meeting.playback_state(&c).unwrap();
        assert_eq!(
            b_state.borrow().status(Source::Camera),
            CaptureStatus::Stopped
        );
        meeting.set_remote_video_enabled(true).await.unwrap();
        meeting.set_remote_audio_enabled(true).await.unwrap();
        // 相同 RTP 时间戳不能让另一成员的独立 consumer 丢帧。
        for tx in &incoming {
            tx.send(Event::Frame {
                source: Source::Camera,
                timestamp: 9000,
                data: video(),
            })
            .await
            .unwrap();
        }
        let first = frames.recv().await.unwrap().0;
        let second = frames.recv().await.unwrap().0;
        assert_ne!(first.member_id, second.member_id);
        assert_eq!(first.source, Source::Camera);
        assert_eq!(second.source, Source::Camera);
        incoming[0]
            .send(Event::Ended(Source::Camera))
            .await
            .unwrap();
        while b_state.borrow().status(Source::Camera) != CaptureStatus::Stopped {
            sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            c_state.borrow().status(Source::Camera),
            CaptureStatus::Running
        );
        let peer = Peer::new(Route::Direct, vec![]).await.unwrap();
        let (media, events) = Media::attach(&peer).await.unwrap();
        meeting
            .attach_edge(slot("b", "b2"), Arc::new(media), events)
            .await
            .unwrap();
        assert_eq!(
            b_state.borrow().status(Source::Microphone),
            CaptureStatus::Stopped
        );
        meeting.detach_edge(&b).await.unwrap();
        assert!(meeting.playback_state(&slot("b", "b2")).is_some());
        meeting.shutdown().await.unwrap();
        assert_eq!(
            c_state.borrow().status(Source::Camera),
            CaptureStatus::Stopped
        );
        for peer in peers {
            peer.close().await.unwrap();
        }
        peer.close().await.unwrap();
    })
    .await
    .expect("逐成员接收隔离超时");
}

#[tokio::test]
async fn capture_validation_and_unconfirmed_cleanup_are_latched() {
    let (mut meeting, _events) = MeetingMedia::new(Arc::new(|_, _, _, _| Ok(())));
    let (tx, capture, _, stops) = capture(true);
    tx.send(encoded(Source::Camera)).await.unwrap();
    meeting
        .start_capture_with(Source::Camera, capture)
        .await
        .unwrap();
    assert!(meeting.stop_capture(Source::Camera).await.is_err());
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    assert_eq!(
        meeting.capture_state().borrow().status(Source::Camera),
        CaptureStatus::Unconfirmed
    );
    assert!(meeting.shutdown().await.is_err());
    assert!(meeting.shutdown().await.is_err());
    let (mut meeting, _events) = MeetingMedia::new(Arc::new(|_, _, _, _| Ok(())));
    let (tx, capture, _, stops) = self::capture(false);
    tx.send(Encoded::Video {
        data: Bytes::new(),
        duration: Duration::from_millis(100),
    })
    .await
    .unwrap();
    assert!(meeting
        .start_capture_with(Source::Camera, capture)
        .await
        .is_err());
    assert_eq!(stops.load(Ordering::SeqCst), 1);
    assert_eq!(
        meeting.capture_state().borrow().status(Source::Camera),
        CaptureStatus::Stopped
    );
    meeting.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_startup_and_drop_preserve_unconfirmed_capture_watch() {
    let (mut meeting, _events) = MeetingMedia::new(Arc::new(|_, _, _, _| Ok(())));
    let state = meeting.capture_state();
    let (_tx, capture, reads, _) = capture(false);
    {
        let starting = meeting.start_capture_with(Source::Camera, capture);
        tokio::pin!(starting);
        tokio::select! {
            result = &mut starting => panic!("不应在首帧前完成：{result:?}"),
            _ = async { while reads.load(Ordering::SeqCst) == 0 { tokio::task::yield_now().await; } } => {},
        }
    }
    assert_eq!(
        state.borrow().status(Source::Camera),
        CaptureStatus::Unconfirmed
    );
    assert!(meeting.shutdown().await.is_err());
    let (mut meeting, _events) = MeetingMedia::new(Arc::new(|_, _, _, _| Ok(())));
    let state = meeting.capture_state();
    let (tx, capture, _, _) = self::capture(false);
    tx.send(encoded(Source::Camera)).await.unwrap();
    meeting
        .start_capture_with(Source::Camera, capture)
        .await
        .unwrap();
    drop(meeting);
    timeout(Duration::from_secs(2), async {
        while state.borrow().status(Source::Camera) != CaptureStatus::Unconfirmed {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn device_gate_is_exclusive_across_clones_and_owners() {
    let gate = DeviceGate::default();
    let other = gate.clone();
    let lease = gate.try_acquire(GateOwner::Call).unwrap();
    assert!(other.try_acquire(GateOwner::Meeting).is_err());
    assert!(other.try_acquire(GateOwner::Call).is_err());
    drop(lease);
    let lease = other.try_acquire(GateOwner::Meeting).unwrap();
    assert!(gate.try_acquire(GateOwner::Call).is_err());
    drop(lease);
    assert!(gate.try_acquire(GateOwner::Call).is_ok());
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn fake_records_control_commands_and_emits_events() {
    use fake::{Command, FakeMeetingMedia};
    use surreal_ck_native_call::CaptureInput;
    let (mut fake, mut received) = FakeMeetingMedia::new();
    let peer = Peer::new(Route::Direct, vec![]).await.unwrap();
    let (media, events) = Media::attach(&peer).await.unwrap();
    let member = slot("b", "b");
    fake.start_capture(
        Source::Microphone,
        CaptureInput::Microphone {
            source: "合成测试".into(),
        },
    )
    .await
    .unwrap();
    fake.stop_capture(Source::Microphone).await.unwrap();
    fake.set_remote_audio_enabled(true).await.unwrap();
    fake.set_remote_video_enabled(true).await.unwrap();
    fake.attach_edge(member.clone(), Arc::new(media), events)
        .await
        .unwrap();
    let playback = fake.playback_state(&member).unwrap();
    assert_eq!(
        playback.borrow().status(Source::Microphone),
        CaptureStatus::Running
    );
    assert_eq!(
        playback.borrow().status(Source::Camera),
        CaptureStatus::Running
    );
    fake.detach_edge(&member).await.unwrap();
    assert_eq!(
        playback.borrow().status(Source::Camera),
        CaptureStatus::Stopped
    );
    fake.shutdown().await.unwrap();
    assert_eq!(
        fake.commands(),
        &[
            Command::Start(Source::Microphone),
            Command::Stop(Source::Microphone),
            Command::RemoteAudio(true),
            Command::RemoteVideo(true),
            Command::Attach(member.clone()),
            Command::Detach(member.clone()),
            Command::Shutdown
        ]
    );
    while received.try_recv().is_ok() {}
    fake.emit(MeetingEvent::RemoteEnded(RenderSlot {
        member_id: member.member_id,
        join_id: member.join_id,
        source: Source::Camera,
    }))
    .unwrap();
    assert!(matches!(
        received.recv().await,
        Some(MeetingEvent::RemoteEnded(_))
    ));
    peer.close().await.unwrap();
}
