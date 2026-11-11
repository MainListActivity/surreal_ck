//! 只用进程内虚拟网；实际执行 ICE/DTLS/SCTP，不使用外部服务或 OS 网卡。
use std::{sync::Arc, time::Duration};
use surreal_ck_peer_transport::{
    chat::{Chat, Event},
    manual_verification::{Error, ManualVerification, Status},
    webrtc::{
        api::setting_engine::SettingEngine,
        rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
        track::track_local::track_local_static_sample::TrackLocalStaticSample,
        util::vnet::{
            net::{Net, NetConfig},
            router::{Router, RouterConfig},
        },
    },
    Peer, Route,
};

async fn chat(
    router: &Arc<tokio::sync::Mutex<Router>>,
    ip: &str,
    initiator: bool,
    skip_engine_certificate_check_for_negative_test: bool,
) -> (Chat, tokio::sync::mpsc::Receiver<Event>) {
    let net = Arc::new(Net::new(Some(NetConfig {
        static_ips: vec![ip.into()],
        ..Default::default()
    })));
    let nic = net.get_nic().unwrap();
    router.lock().await.add_net(nic.clone()).await.unwrap();
    nic.lock().await.set_router(router.clone()).await.unwrap();
    let mut settings = SettingEngine::default();
    settings.set_vnet(Some(net));
    // 仅负例故意模拟误配置引擎，验证人工核对模块仍独立拒绝错误证书。
    // 此设置只存在于集成测试，不进入生产构造器或默认路径。
    settings.disable_certificate_fingerprint_verification(
        skip_engine_certificate_check_for_negative_test,
    );
    let peer = Peer::new_with_settings(Route::Direct, vec![], settings)
        .await
        .unwrap();
    if initiator {
        for (mime, rate, channels, id) in [
            ("audio/opus", 48_000, 2, "audio"),
            ("video/VP8", 90_000, 0, "video"),
        ] {
            peer.connection()
                .add_track(Arc::new(TrackLocalStaticSample::new(
                    RTCRtpCodecCapability {
                        mime_type: mime.into(),
                        clock_rate: rate,
                        channels,
                        ..Default::default()
                    },
                    id.into(),
                    "manual-verification-test".into(),
                )))
                .await
                .unwrap();
        }
    }
    Chat::from_peer(peer, initiator).await.unwrap()
}
async fn negotiate(
    a: &Chat,
    b: &Chat,
    ae: &mut tokio::sync::mpsc::Receiver<Event>,
    be: &mut tokio::sync::mpsc::Receiver<Event>,
) {
    a.accept_answer_json(&b.answer_json(&a.offer_json().await.unwrap()).await.unwrap())
        .await
        .unwrap();
    while !matches!(ae.recv().await, Some(Event::Open)) {}
    while !matches!(be.recv().await, Some(Event::Open)) {}
}

#[tokio::test]
async fn actual_dtls_pair_matches_and_user_confirmation_is_bound_to_live_epoch() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let router = Arc::new(tokio::sync::Mutex::new(
            Router::new(RouterConfig {
                cidr: "10.0.0.0/24".into(),
                ..Default::default()
            })
            .unwrap(),
        ));
        let (a, mut ae) = chat(&router, "10.0.0.1", true, false).await;
        let (b, mut be) = chat(&router, "10.0.0.2", false, false).await;
        let (replacement_a, mut replacement_ae) = chat(&router, "10.0.0.3", true, false).await;
        let (replacement_b, mut replacement_be) = chat(&router, "10.0.0.4", false, false).await;
        router.lock().await.start().await.unwrap();

        assert!(matches!(
            ManualVerification::capture(a.peer(), 1).await,
            Err(Error::NotConnected)
        ));
        assert!(matches!(
            ManualVerification::capture(a.peer(), 0).await,
            Err(Error::Stale)
        ));
        negotiate(&a, &b, &mut ae, &mut be).await;

        let mut first = ManualVerification::capture(a.peer(), 1).await.unwrap();
        let mut second = ManualVerification::capture(b.peer(), 41).await.unwrap();
        // 双方本地 epoch 不共享；材料仅由实际双端描述、证书生成。
        assert_eq!(first.material(), second.material());
        assert_eq!(first.status(a.peer(), 1).await, Status::AwaitingComparison);
        assert_eq!(
            second.status(b.peer(), 41).await,
            Status::AwaitingComparison
        );
        let displayed = first.material().comparison_text();
        assert!(displayed.contains("发起端 SHA-256:"));
        assert!(!displayed.contains("a=ice-pwd:"));
        assert!(!displayed.contains("10.0.0.1"));
        first
            .confirm_after_trusted_channel_comparison(a.peer(), 1, &displayed)
            .await
            .unwrap();
        assert_eq!(
            first.status(a.peer(), 1).await,
            Status::ComparedViaTrustedChannel
        );
        assert_eq!(
            second.status(b.peer(), 41).await,
            Status::AwaitingComparison
        );

        let mut wrong_material = ManualVerification::capture(a.peer(), 1).await.unwrap();
        assert_eq!(
            wrong_material
                .confirm_after_trusted_channel_comparison(a.peer(), 1, "123456")
                .await,
            Err(Error::Comparison)
        );
        assert_eq!(
            wrong_material.status(a.peer(), 1).await,
            Status::Invalidated
        );

        let mut old_epoch = ManualVerification::capture(a.peer(), 1).await.unwrap();
        assert_eq!(
            old_epoch
                .confirm_after_trusted_channel_comparison(a.peer(), 2, &displayed)
                .await,
            Err(Error::Stale)
        );
        assert_eq!(old_epoch.status(a.peer(), 1).await, Status::Invalidated);

        negotiate(
            &replacement_a,
            &replacement_b,
            &mut replacement_ae,
            &mut replacement_be,
        )
        .await;
        let replacement = ManualVerification::capture(replacement_a.peer(), 2)
            .await
            .unwrap();
        assert_ne!(first.material(), replacement.material());
        let mut stale_peer = ManualVerification::capture(a.peer(), 1).await.unwrap();
        // 即使错误地复用 epoch，Arc 身份仍拒绝替换的 Peer。
        assert_eq!(
            stale_peer
                .confirm_after_trusted_channel_comparison(replacement_a.peer(), 1, &displayed)
                .await,
            Err(Error::Stale)
        );

        let mut before_reoffer = ManualVerification::capture(a.peer(), 1).await.unwrap();
        let offer = a.peer().offer().await.unwrap();
        assert!(!before_reoffer.matches_current(a.peer(), 1).await);
        assert_eq!(
            before_reoffer.status(a.peer(), 1).await,
            Status::Invalidated
        );
        a.peer()
            .accept_answer(b.peer().answer(offer).await.unwrap())
            .await
            .unwrap();
        assert_eq!(
            before_reoffer
                .confirm_after_trusted_channel_comparison(a.peer(), 1, &displayed)
                .await,
            Err(Error::Stale)
        );
        assert_eq!(first.status(a.peer(), 2).await, Status::Invalidated);

        let mut before_close = ManualVerification::capture(a.peer(), 2).await.unwrap();
        let before_close_text = before_close.material().comparison_text();
        a.close().await.unwrap();
        assert_eq!(
            before_close
                .confirm_after_trusted_channel_comparison(a.peer(), 2, &before_close_text)
                .await,
            Err(Error::Stale)
        );
        assert_eq!(
            second
                .confirm_after_trusted_channel_comparison(a.peer(), 41, &displayed)
                .await,
            Err(Error::Stale)
        );
        assert!(matches!(
            ManualVerification::capture(a.peer(), 2).await,
            Err(Error::NotConnected)
        ));
        b.close().await.unwrap();
        replacement_a.close().await.unwrap();
        replacement_b.close().await.unwrap();
        router.lock().await.stop().await.unwrap();
    })
    .await
    .expect("进程内虚拟网人工核对测试超时");
}

#[tokio::test]
async fn rejects_actual_remote_certificate_mismatch_even_when_engine_is_misconfigured() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let router = Arc::new(tokio::sync::Mutex::new(
            Router::new(RouterConfig {
                cidr: "10.0.0.0/24".into(),
                ..Default::default()
            })
            .unwrap(),
        ));
        let (a, mut ae) = chat(&router, "10.0.0.1", true, true).await;
        let (b, mut be) = chat(&router, "10.0.0.2", false, false).await;
        router.lock().await.start().await.unwrap();
        let offer = a.peer().offer().await.unwrap();
        let mut answer = b.peer().answer(offer).await.unwrap();
        let fake = std::iter::repeat_n("00", 32).collect::<Vec<_>>().join(":");
        answer.sdp = answer
            .sdp
            .lines()
            .map(|line| {
                if line.starts_with("a=fingerprint:") {
                    format!("a=fingerprint:sha-256 {fake}\r\n")
                } else {
                    format!("{line}\r\n")
                }
            })
            .collect();
        a.peer().accept_answer(answer).await.unwrap();
        while !matches!(ae.recv().await, Some(Event::Open)) {}
        while !matches!(be.recv().await, Some(Event::Open)) {}
        assert!(matches!(
            ManualVerification::capture(a.peer(), 1).await,
            Err(Error::Certificate)
        ));
        a.close().await.unwrap();
        b.close().await.unwrap();
        router.lock().await.stop().await.unwrap();
    })
    .await
    .expect("进程内证书不匹配负例超时");
}

#[tokio::test]
async fn connection_epoch_changes_before_full_event_queue_can_be_drained() {
    close_invalidates_before_queue_consumption(false).await;
}

#[tokio::test]
async fn remote_data_channel_close_also_invalidates_before_queue_consumption() {
    close_invalidates_before_queue_consumption(true).await;
}

async fn close_invalidates_before_queue_consumption(data_channel_only: bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let router = Arc::new(tokio::sync::Mutex::new(
            Router::new(RouterConfig {
                cidr: "10.0.0.0/24".into(),
                ..Default::default()
            })
            .unwrap(),
        ));
        let (a, mut ae) = chat(&router, "10.0.0.1", true, false).await;
        let (b, mut be) = chat(&router, "10.0.0.2", false, false).await;
        let observer = a.connection_epoch_observer();
        assert_eq!(observer.current(), 1);
        router.lock().await.start().await.unwrap();
        negotiate(&a, &b, &mut ae, &mut be).await;
        assert!(observer.current() > 1);
        assert_eq!(observer.current(), a.connection_epoch());

        let previous_epoch = observer.current();
        let mut previous = ManualVerification::capture(a.peer(), previous_epoch)
            .await
            .unwrap();
        // 即使协商输入无效，用户开始新操作也不得沿用人工确认。
        assert!(a.accept_answer_json("invalid json").await.is_err());
        assert!(observer.current() > previous_epoch);
        assert_eq!(
            previous.status(a.peer(), observer.current()).await,
            Status::Invalidated
        );

        while ae.try_recv().is_ok() {}
        for _ in 0..128 {
            b.send_text("填满事件队列的本地测试消息").await.unwrap();
        }
        while ae.len() != 128 {
            tokio::task::yield_now().await;
        }
        let before_callback = observer.current();
        let connection = if data_channel_only { b.peer().connection() } else { a.peer().connection() };
        // 绕过Chat::close入口，分别专测Peer状态回调和远端SCTP关闭引发的通道回调。
        let closing = tokio::spawn(async move {
            if data_channel_only { connection.sctp().stop().await } else { connection.close().await }
        });
        while observer.current() == before_callback {
            tokio::task::yield_now().await;
        }
        assert_eq!(ae.len(), 128, "回调必须先增代再等待队列空间");
        if data_channel_only {
            assert_eq!(a.peer().connection().connection_state(), surreal_ck_peer_transport::webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState::Connected,
                "数据通道关闭时Peer仍可保持Connected，必须独立撤销");
        }
        while !closing.is_finished() {
            let _ = ae.try_recv();
            tokio::task::yield_now().await;
        }
        closing.await.unwrap().unwrap();
        while ae.try_recv().is_ok() {}
        a.close().await.unwrap();
        b.close().await.unwrap();
        router.lock().await.stop().await.unwrap();
    })
    .await
    .expect("真实状态回调不能被满队列阻塞撤销");
}
