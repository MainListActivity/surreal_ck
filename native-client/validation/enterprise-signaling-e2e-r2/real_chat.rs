#[cfg(test)]
mod enterprise_e2e {
    use super::*;
    use surreal_ck_peer_transport::chat::Event;
    use tokio::{
        sync::mpsc::Receiver,
        time::{timeout, Duration},
    };
    async fn opened(events: &mut Receiver<Event>) {
        timeout(Duration::from_secs(20), async {
            loop {
                match events.recv().await.expect("closed before Open") {
                    Event::Open => break,
                    Event::Closed => panic!("closed before Open"),
                    _ => {}
                }
            }
        })
        .await
        .expect("real UDP ICE/channel did not open");
    }
    async fn text(events: &mut Receiver<Event>, expected: &str) {
        timeout(Duration::from_secs(10), async {
            loop {
                match events.recv().await.expect("closed before text") {
                    Event::Text(value) => {
                        assert_eq!(value, expected);
                        break;
                    }
                    Event::Closed => panic!("closed before text"),
                    _ => {}
                }
            }
        })
        .await
        .expect("message not delivered");
    }
    #[tokio::test]
    #[ignore = "requires verified local fork and real OS UDP candidates; no virtual-network fallback"]
    async fn authenticated_database_to_real_udp_chat() {
        run_chat(false, false).await;
    }
    #[tokio::test]
    #[ignore = "requires verified local fork and real OS UDP; no fallback"]
    async fn authenticated_peer_revocation_closes_real_chat() {
        run_chat(true, false).await;
    }
    #[tokio::test]
    #[ignore = "requires verified local fork and real UDP; no fallback"]
    async fn revocation_invalidates_queued_messages_before_close() {
        run_chat(true, true).await;
    }
    async fn run_chat(revoke: bool, flood: bool) {
        let binary = std::env::var("SURREAL_TEST_BINARY").expect("fixed fork path required");
        let mut fixture = signaling::tests::ForkFixture::start(&binary).await;
        let alice = fixture.connection("a", "ws_signal").await;
        let mut bob = fixture.connection("b", "ws_signal").await;
        let (mut outgoing, mut outgoing_events) =
            enterprise_peer::EnterprisePeer::invite(alice, "user:b", vec![])
                .await
                .expect("real ICE offer and authenticated publish");
        let invites = bob.inbox().await.unwrap();
        assert_eq!(invites.len(), 1);
        assert_eq!(invites[0].sender, "user:a");
        let (incoming, mut incoming_events) =
            enterprise_peer::EnterprisePeer::accept(bob, &invites[0].id, vec![])
                .await
                .expect("explicit accept and authenticated answer");
        assert!(outgoing.poll_answer().await.unwrap());
        tokio::join!(opened(&mut outgoing_events), opened(&mut incoming_events));
        outgoing
            .send_text("组织信令→真实P2P，甲到乙")
            .await
            .unwrap();
        text(&mut incoming_events, "组织信令→真实P2P，甲到乙").await;
        incoming
            .send_text("乙到甲：正文没有进入数据库")
            .await
            .unwrap();
        text(&mut outgoing_events, "乙到甲：正文没有进入数据库").await;
        let observer = outgoing.lease_observer();
        if revoke {
            if flood {
                for _ in 0..140 {
                    incoming.send_text("撤销前的队列测试内容").await.unwrap();
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            fixture.revoke("b").await;
            if flood {
                timeout(Duration::from_secs(25), async {
                    while observer.is_active() {
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                })
                .await
                .expect("lease remained active under full event queue");
                assert!(outgoing.send_text("撤销后必须拒绝").await.is_err());
                drop(outgoing_events); // 模拟UI停止：释放on_close事件背压。
            } else {
                timeout(Duration::from_secs(25), async {
                    loop {
                        match outgoing_events.recv().await {
                            Some(Event::Closed) | None => break,
                            _ => {}
                        }
                    }
                })
                .await
                .expect("revoked peer did not close within periodic validation budget");
                assert!(outgoing.send_text("不得继续发送").await.is_err());
            }
            let closed = outgoing.close().await.unwrap();
            assert!(closed.local_closed);
            assert!(closed.remote_end_error.is_some());
        } else {
            let closed = outgoing.close().await.unwrap();
            assert!(closed.local_closed);
            assert!(closed.remote_end_error.is_none());
        }
        assert!(!observer.is_active());
        drop(incoming_events);
        assert!(incoming.close().await.unwrap().local_closed); // 对方已end；本地close必须先发生，不假定数据库二次end成功。
        println!("PASS authenticated RECORD signaling -> real UDP ICE/DTLS/SCTP -> bidirectional Chinese text; loopback company API fixture, not production OIDC/TLS/NAT/media");
    }
}
