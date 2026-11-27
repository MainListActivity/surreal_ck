use bytes::Bytes;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use surreal_ck_peer_transport::{
    media::{Event, Source},
    meeting::*,
    webrtc::{
        api::setting_engine::SettingEngine,
        media::io::ivf_reader::IVFReader,
        peer_connection::peer_connection_state::RTCPeerConnectionState,
        util::vnet::{
            net::{Net, NetConfig},
            router::{Router, RouterConfig},
        },
    },
    Route,
};
use tokio::sync::Mutex;

#[tokio::test]
#[ignore = "requires coturn: isolated 127.0.0.1 fixture or M04_TURN_URL with short-lived credentials"]
async fn meeting_edge_uses_only_coturn_relay_and_observes_selected_relay() {
    let env = |key: &str| std::env::var(key).ok().filter(|value| !value.is_empty());
    let route = Route::RelayFallback {
        urls: env("M04_TURN_URLS")
            .map(|urls| urls.split(',').map(str::to_owned).collect())
            .unwrap_or_else(|| {
                let port = env("M04_COTURN_TEST_PORT").unwrap();
                vec![format!("turn:127.0.0.1:{port}?transport=udp")]
            }),
        username: env("M04_TURN_USERNAME").unwrap_or_else(|| "fixture-user".into()),
        credential: env("M04_TURN_CREDENTIAL").unwrap_or_else(|| "fixture-password".into()),
    };
    let a = JoinId::new("a").unwrap();
    let b = JoinId::new("b").unwrap();
    let attempt = Attempt {
        edge: EdgeKey::new(RoomId::new("room").unwrap(), a.clone(), b.clone()).unwrap(),
        attempt_no: 2,
        nonce: [0; 16],
        route: RouteKind::Relay,
        expires_at: Instant::now() + Duration::from_secs(35),
    };
    let mut settings = SettingEngine::default();
    settings.set_include_loopback_candidate(true);
    let mut first = MeetingEdge::new(attempt.clone(), a, route.clone(), vec![], settings.clone())
        .await
        .unwrap();
    let mut second = MeetingEdge::new(attempt, b, route, vec![], settings)
        .await
        .unwrap();
    let mut first_events = first.take_events().unwrap();
    let mut second_events = second.take_events().unwrap();
    let offer = first.offer().await.unwrap();
    let hash = offer_hash(&offer);
    let answer = second.answer(offer.clone()).await.unwrap();
    for description in [&offer, &answer] {
        let candidates: Vec<_> = description
            .sdp
            .lines()
            .filter(|line| line.starts_with("a=candidate:"))
            .collect();
        assert!(!candidates.is_empty());
        assert!(candidates.iter().all(|line| line.contains(" typ relay")));
    }
    first.accept_answer(answer, hash).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        for edge in [&first, &second] {
            while edge.connection_state() != RTCPeerConnectionState::Connected {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(edge.stats().await.route, ObservedRoute::Relay);
            edge.media().set_enabled(Source::Microphone, true);
            edge.media()
                .send(
                    Source::Microphone,
                    Bytes::from_static(include_bytes!("fixtures/test.opus.packet")),
                    Duration::from_millis(20),
                )
                .await
                .unwrap();
        }
        for events in [&mut first_events, &mut second_events] {
            loop {
                match events.recv().await {
                    Some(Event::Frame {
                        source: Source::Microphone,
                        ..
                    }) => break,
                    Some(_) => {}
                    None => panic!("relay media event channel closed"),
                }
            }
        }
    })
    .await
    .expect("coturn relay did not establish two-way media");
    first.close().await.unwrap();
    second.close().await.unwrap();
}

#[tokio::test]
async fn meeting_mesh_three_edges_survive_member_departure() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let router = Arc::new(Mutex::new(
            Router::new(RouterConfig {
                cidr: "10.1.0.0/24".into(),
                ..Default::default()
            })
            .unwrap(),
        ));
        let mut edges = Vec::new();
        for (index, (a, b)) in [("a", "b"), ("a", "c"), ("b", "c")].into_iter().enumerate() {
            let a = JoinId::new(a).unwrap();
            let b = JoinId::new(b).unwrap();
            let attempt = Attempt {
                edge: EdgeKey::new(RoomId::new("room").unwrap(), b.clone(), a.clone()).unwrap(),
                attempt_no: 1,
                nonce: [index as u8; 16],
                route: RouteKind::Direct,
                expires_at: Instant::now() + Duration::from_secs(35),
            };
            let mut ends = Vec::new();
            for (offset, join) in [a, b].into_iter().enumerate() {
                let net = Arc::new(Net::new(Some(NetConfig {
                    static_ips: vec![format!("10.1.0.{}", index * 2 + offset + 1)],
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
            edges.push(ends);
        }
        router.lock().await.start().await.unwrap();
        let mut receivers = Vec::new();
        for ends in &mut edges {
            assert_eq!(ends[0].stats().await.route, ObservedRoute::Unknown);
            assert!(ends[1].offer().await.is_err());
            let offer = ends[0].offer().await.unwrap();
            let hash = offer_hash(&offer);
            let answer = ends[1].answer(offer).await.unwrap();
            assert!(ends[0]
                .accept_answer(answer.clone(), [0; 32])
                .await
                .is_err());
            ends[0].accept_answer(answer.clone(), hash).await.unwrap();
            assert!(ends[0].accept_answer(answer, hash).await.is_err());
            for end in ends {
                receivers.push(end.take_events().unwrap());
                assert!(end.take_events().is_none());
            }
        }
        for ends in &edges {
            for end in ends {
                while end.connection_state() != RTCPeerConnectionState::Connected {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                assert_eq!(end.stats().await.route, ObservedRoute::Direct);
            }
        }
        let opus = Bytes::from_static(include_bytes!("fixtures/test.opus.packet"));
        let (mut ivf, _) =
            IVFReader::new(include_bytes!("fixtures/test.vp8.ivf").as_slice()).unwrap();
        let (frame, _) = ivf.parse_next_frame().unwrap();
        let video = frame.freeze();
        for (round, count) in [(0, 3), (1, 1)] {
            if round == 1 {
                for ends in &edges[1..] {
                    for end in ends {
                        end.close().await.unwrap();
                    }
                }
            }
            for (index, ends) in edges.iter().take(count).enumerate() {
                let before = [ends[0].stats().await, ends[1].stats().await];
                for end in ends {
                    assert_eq!(end.connection_state(), RTCPeerConnectionState::Connected);
                    let media = end.media();
                    media.set_enabled(Source::Microphone, true);
                    media
                        .send(Source::Microphone, opus.clone(), Duration::from_millis(20))
                        .await
                        .unwrap();
                    for source in [Source::Camera, Source::Screen] {
                        media.set_enabled(source, true);
                        media
                            .send(source, video.clone(), Duration::from_millis(100))
                            .await
                            .unwrap();
                    }
                }
                for offset in 0..2 {
                    let mut seen = [false; 3];
                    while seen.iter().any(|seen| !seen) {
                        if let Some(Event::Frame { source, data, .. }) =
                            receivers[index * 2 + offset].recv().await
                        {
                            let slot = match source {
                                Source::Microphone => {
                                    assert_eq!(data, opus);
                                    0
                                }
                                Source::Camera => {
                                    assert_eq!(data, video);
                                    1
                                }
                                Source::Screen => {
                                    assert_eq!(data, video);
                                    2
                                }
                            };
                            seen[slot] = true;
                        }
                    }
                    loop {
                        let after = ends[offset].stats().await;
                        if after.rtp_packets_sent > before[offset].rtp_packets_sent
                            && after.rtp_packets_received > before[offset].rtp_packets_received
                            && after.rtp_bytes_sent > before[offset].rtp_bytes_sent
                            && after.rtp_bytes_received > before[offset].rtp_bytes_received
                        {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            }
        }
        for end in &edges[0] {
            end.close().await.unwrap();
        }
        router.lock().await.stop().await.unwrap();
    })
    .await
    .expect("会议三边媒体超时");
}
