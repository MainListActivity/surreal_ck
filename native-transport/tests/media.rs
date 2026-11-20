use bytes::Bytes;
use std::{sync::Arc, time::Duration};
use surreal_ck_peer_transport::{
    media::{Event, Media, Source},
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
use tokio::sync::Mutex;
#[tokio::test]
async fn virtual_network_real_encoded_camera_screen_and_audio() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let router = Arc::new(Mutex::new(
            Router::new(RouterConfig {
                cidr: "10.1.0.0/24".into(),
                ..Default::default()
            })
            .unwrap(),
        ));
        let mut peers = Vec::new();
        for ip in ["10.1.0.1", "10.1.0.2"] {
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
        let a = peers.remove(0);
        let b = peers.remove(0);
        let (media, mut feedback) = Media::attach(&a).await.unwrap();
        let (_, mut received) = Media::attach(&b).await.unwrap();
        a.accept_answer(b.answer(a.offer().await.unwrap()).await.unwrap())
            .await
            .unwrap();
        while a.connection().connection_state() != RTCPeerConnectionState::Connected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let (mut ivf, _) =
            IVFReader::new(include_bytes!("fixtures/test.vp8.ivf").as_slice()).unwrap();
        let (frame, _) = ivf.parse_next_frame().unwrap();
        let frame = frame.freeze();
        let opus = Bytes::from_static(include_bytes!("fixtures/test.opus.packet"));
        assert!(media
            .send(Source::Camera, frame.clone(), Duration::from_millis(100))
            .await
            .is_err());
        for source in [Source::Microphone, Source::Camera, Source::Screen] {
            media.set_enabled(source, true);
        }
        media
            .send(Source::Camera, frame.clone(), Duration::from_millis(100))
            .await
            .unwrap();
        media
            .send(Source::Screen, frame.clone(), Duration::from_millis(100))
            .await
            .unwrap();
        media
            .send(Source::Microphone, opus.clone(), Duration::from_millis(20))
            .await
            .unwrap();
        let mut seen = [false; 3];
        while seen.iter().any(|v| !v) {
            if let Some(Event::Frame { source, data, .. }) = received.recv().await {
                match source {
                    Source::Microphone => {
                        assert_eq!(data, opus);
                        seen[0] = true;
                    }
                    Source::Camera => {
                        assert_eq!(data, frame);
                        seen[1] = true;
                    }
                    Source::Screen => {
                        assert_eq!(data, frame);
                        seen[2] = true;
                    }
                }
            }
        }
        media.set_enabled(Source::Screen, false);
        assert!(media
            .send(Source::Screen, frame.clone(), Duration::from_millis(100))
            .await
            .is_err());
        assert!(media
            .send(Source::Camera, Bytes::new(), Duration::from_millis(100))
            .await
            .is_err());
        assert!(media
            .send(
                Source::Microphone,
                Bytes::from(vec![0; 1276]),
                Duration::from_millis(20)
            )
            .await
            .is_err());
        // 持续 drain 反馈，结束后释放；从未把测试图宣称为设备采集。
        let drain = tokio::spawn(async move { while feedback.recv().await.is_some() {} });
        a.close().await.unwrap();
        b.close().await.unwrap();
        drain.abort();
        router.lock().await.stop().await.unwrap();
    })
    .await
    .expect("encoded media protocol timed out");
}
