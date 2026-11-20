use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use surreal_ck_peer_transport::{file, Peer, Route};
use tokio::sync::{mpsc, oneshot};

#[tokio::test]
#[ignore = "requires real OS interfaces; cloud sandbox returns no ICE candidates"]
async fn encrypted_direct_data_channel_transfers_multichunk_file() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let a = Peer::new(Route::Direct, vec![]).await.unwrap();
        let b = Peer::new(Route::Direct, vec![]).await.unwrap();
        transfer(a, b).await;
    })
    .await
    .expect("real local ICE/DTLS/SCTP timed out");
}
async fn transfer(a: Peer, b: Peer) {
    use surreal_ck_peer_transport::webrtc::{
        media::Sample, rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
        track::track_local::track_local_static_sample::TrackLocalStaticSample,
    };
    let audio = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: "audio/opus".into(),
            clock_rate: 48000,
            channels: 2,
            ..Default::default()
        },
        "audio".into(),
        "test".into(),
    ));
    a.connection().add_track(audio.clone()).await.unwrap();
    let (media_tx, mut media_rx) = mpsc::channel(1);
    b.connection().on_track(Box::new(move |track, _, _| {
        let tx = media_tx.clone();
        Box::pin(async move {
            let (packet, _) = track.read_rtp().await.unwrap();
            tx.send(packet.payload).await.unwrap();
        })
    }));
    let data = vec![0x42; file::CHUNK_SIZE * 4 + 123];
    let receiver = Arc::new(Mutex::new(Some(
        file::Receiver::new(Vec::new(), data.len() as u64, Sha256::digest(&data).into()).unwrap(),
    )));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let receiver_cb = receiver.clone();
    b.connection().on_data_channel(Box::new(move |channel| {
        let receiver = receiver_cb.clone();
        let tx = tx.clone();
        Box::pin(async move {
            channel.on_message(Box::new(move |message| {
                let receiver = receiver.clone();
                let tx = tx.clone();
                Box::pin(async move {
                    receiver
                        .lock()
                        .unwrap()
                        .as_mut()
                        .unwrap()
                        .receive(&message.data)
                        .unwrap();
                    tx.send(message.data.len() - 8).unwrap();
                })
            }));
        })
    }));
    let channel = a
        .connection()
        .create_data_channel("file-v1", None)
        .await
        .unwrap();
    let (opened_tx, opened_rx) = oneshot::channel();
    channel.on_open(Box::new(move || {
        Box::pin(async move {
            let _ = opened_tx.send(());
        })
    }));
    let offer = a.offer().await.unwrap();
    assert!(offer.sdp.contains("a=fingerprint:sha-256"));
    assert!(!offer.sdp.contains(" typ relay"));
    a.accept_answer(b.answer(offer).await.unwrap())
        .await
        .unwrap();
    opened_rx.await.unwrap();
    audio
        .write_sample(&Sample {
            data: bytes::Bytes::from_static(&[0xf8, 0xff, 0xfe]),
            duration: Duration::from_millis(20),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(media_rx.recv().await.unwrap().as_ref(), &[0xf8, 0xff, 0xfe]);
    file::send(&channel, data.as_slice(), data.len() as u64)
        .await
        .unwrap();
    let mut count = 0;
    while count < data.len() {
        count += rx.recv().await.unwrap();
    }
    assert_eq!(
        receiver.lock().unwrap().take().unwrap().finish().unwrap(),
        data
    );
    a.close().await.unwrap();
    b.close().await.unwrap();
}
#[tokio::test]
async fn rejects_unconfigured_relay() {
    assert!(Peer::new(
        Route::RelayFallback {
            urls: vec!["https://example.com".into()],
            username: "x".into(),
            credential: "y".into()
        },
        vec![]
    )
    .await
    .is_err());
}

#[tokio::test]
async fn virtual_network_ice_dtls_sctp_file_and_srtp() {
    virtual_network(false).await;
}
#[tokio::test]
async fn virtual_network_chat_bridge() {
    virtual_network(true).await;
}
async fn virtual_network(chat: bool) {
    use surreal_ck_peer_transport::webrtc::{
        api::setting_engine::SettingEngine,
        util::vnet::{
            net::{Net, NetConfig},
            router::{Router, RouterConfig},
        },
    };
    tokio::time::timeout(Duration::from_secs(30), async {
        let router = Arc::new(tokio::sync::Mutex::new(
            Router::new(RouterConfig {
                cidr: "10.0.0.0/24".into(),
                ..Default::default()
            })
            .unwrap(),
        ));
        let mut peers = Vec::new();
        for ip in ["10.0.0.1", "10.0.0.2"] {
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
        if chat {
            use surreal_ck_peer_transport::chat::{Chat, Event};
            let (a, mut ae) = Chat::from_peer(peers.remove(0), true).await.unwrap();
            let (b, mut be) = Chat::from_peer(peers.remove(0), false).await.unwrap();
            a.accept_answer_json(&b.answer_json(&a.offer_json().await.unwrap()).await.unwrap())
                .await
                .unwrap();
            while !matches!(ae.recv().await, Some(Event::Open)) {}
            while !matches!(be.recv().await, Some(Event::Open)) {}
            a.send_text("真实协议中文聊天").await.unwrap();
            loop {
                if let Some(Event::Text(text)) = be.recv().await {
                    assert_eq!(text, "真实协议中文聊天");
                    break;
                }
            }
            assert!(a.send_text(&"x".repeat(16385)).await.is_err());
            a.close().await.unwrap();
            b.close().await.unwrap();
        } else {
            transfer(peers.remove(0), peers.remove(0)).await;
        }
        router.lock().await.stop().await.unwrap();
    })
    .await
    .expect("virtual network protocol test timed out");
}
