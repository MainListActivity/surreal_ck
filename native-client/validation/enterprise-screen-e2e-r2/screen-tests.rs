//! Real X11 capture of an explicitly confirmed isolated test window only.
//! No encoded-sample injection; no camera, microphone or production grant.
use super::*;
use crate::{
    call_bridge::{CapturePhase, Control, Source},
    signaling,
};
use std::time::Duration;
use surreal_ck_native_video_view::{FrameReceiver, FrameUpdate};
use surreal_ck_peer_transport::chat::Event as ChatEvent;
use tokio::{
    sync::mpsc::Receiver,
    time::{sleep, timeout},
};

async fn opened(events: &mut Receiver<ChatEvent>) {
    timeout(Duration::from_secs(20), async {
        loop {
            if matches!(
                events.recv().await.expect("chat closed before open"),
                ChatEvent::Open
            ) {
                break;
            }
        }
    })
    .await
    .expect("real OS UDP did not connect; no VNet fallback");
}
fn confirmed_selection() -> String {
    let path = std::env::var("SCREEN_E2E_CONFIRMATION")
        .expect("desktop confirmation required before capture");
    let receipt: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(receipt["confirmed_test_window_only"], true);
    assert_eq!(receipt["width"], 640);
    assert_eq!(receipt["height"], 360);
    assert_eq!(receipt["pattern"], "alternating-red-blue-1s");
    assert!(receipt["window_id"].as_str().is_some_and(|x| !x.is_empty()));
    let selection = receipt["selection"].as_str().unwrap().to_owned();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let confirmed = receipt["confirmed_unix_seconds"].as_u64().unwrap();
    assert!(
        confirmed <= now && now - confirmed < 300,
        "confirmation expired; recheck window before capture"
    );
    let x = receipt["x"].as_u64().unwrap();
    let y = receipt["y"].as_u64().unwrap();
    let display = receipt["display"].as_str().unwrap();
    assert_eq!(selection, format!("{display}+{x},{y}"));
    selection
}
async fn run(revoke: bool) {
    let selection = confirmed_selection();
    let binary = std::env::var("SURREAL_TEST_BINARY").expect("verified local fork required");
    let mut fixture = signaling::tests::ForkFixture::start(&binary).await;
    let a_connection = fixture.connection("a", "ws_signal").await;
    let mut b_connection = fixture.connection("b", "ws_signal").await;
    let (mut a, mut a_chat) = EnterprisePeer::invite(a_connection, "user:b", vec![])
        .await
        .unwrap();
    let inbox = b_connection.inbox().await.unwrap();
    assert_eq!(inbox.len(), 1);
    let (b, mut b_chat) = EnterprisePeer::accept(b_connection, &inbox[0].id, vec![])
        .await
        .unwrap();
    assert!(a.poll_answer().await.unwrap());
    tokio::join!(opened(&mut a_chat), opened(&mut b_chat));
    let a_handle = a.media_handle().unwrap();
    let b_handle = b.media_handle().unwrap();
    let a_states = a.media_capture_state().unwrap();
    let mut states = b.media_capture_state().unwrap();
    // Before explicit Start all capture sources must be stopped.
    for s in &states.borrow().sources {
        assert_eq!(s.status, CapturePhase::Stopped);
    }
    b_handle.submit(Control::RemoteVideo(true)).unwrap();
    let id = timeout(Duration::from_secs(5), async {
        loop {
            if let Some(id) = states.borrow().video_streams[1].clone() {
                break id;
            }
            states.changed().await.unwrap();
        }
    })
    .await
    .expect("real playback enable/FramePublisher did not open");
    let mut view: FrameReceiver = surreal_ck_native_video_view::subscribe(&id).unwrap();
    // Recheck freshness immediately before invoking the production capture API.
    assert_eq!(confirmed_selection(), selection);
    let operation = a_handle
        .submit(Control::Start {
            source: Source::Screen,
            selection: selection.clone(),
        })
        .unwrap();
    timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = a_states.borrow().clone();
            let screen = &snapshot.sources[2];
            if screen.status == CapturePhase::Running && screen.completed_operation == operation {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("real X11 capture did not become Running");
    let mut phases = [false; 2];
    let mut last = 0;
    timeout(Duration::from_secs(15), async {
        while !phases.iter().all(|p| *p) {
            if let FrameUpdate::Frame { frame, sequence } = view.poll() {
                assert!(sequence > last);
                last = sequence;
                assert_eq!((frame.width(), frame.height()), (640, 360));
                assert_eq!(frame.pixels().len(), 640 * 360 * 4);
                let mut red = 0;
                let mut blue = 0;
                for p in frame.pixels().chunks_exact(4) {
                    assert_eq!(p[3], 255);
                    if p[0] > 220 && p[1] < 35 && p[2] < 35 {
                        red += 1;
                    }
                    if p[2] > 220 && p[1] < 35 && p[0] < 35 {
                        blue += 1;
                    }
                }
                // Require essentially the entire confirmed test client area, not a tiny patch.
                if red > 640 * 360 * 99 / 100 {
                    phases[0] = true;
                }
                if blue > 640 * 360 * 99 / 100 {
                    phases[1] = true;
                }
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("real captured test window did not show both red/blue phases");
    if revoke {
        fixture.revoke("b").await;
        timeout(Duration::from_secs(25), async {
            while a.lease_active() || b.lease_active() {
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("actual enterprise lease did not revoke");
        assert!(a_handle.submit(Control::RemoteVideo(true)).is_err());
        assert!(b_handle.submit(Control::RemoteVideo(true)).is_err());
        assert!(
            a_handle
                .submit(Control::Start {
                    source: Source::Screen,
                    selection: selection.clone()
                })
                .is_err()
        );
        // Require automatic revocation cleanup BEFORE calling explicit Peer.close.
        // Otherwise an explicit close could mask a broken revocation path.
        timeout(Duration::from_secs(10), async {
            loop {
                if a_states.borrow().shutdown.is_some() && states.borrow().shutdown.is_some() {
                    break;
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("lease revoked but real media cleanup did not finish automatically");
        assert!(matches!(view.poll(), FrameUpdate::Closed));
    }
    if !revoke {
        let stop = a_handle.submit(Control::Stop(Source::Screen)).unwrap();
        timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = a_states.borrow().clone();
                if snapshot.sources[2].status == CapturePhase::Stopped
                    && snapshot.sources[2].completed_operation == stop
                {
                    break;
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("actual capture Stop not confirmed");
        b_handle.submit(Control::RemoteVideo(false)).unwrap();
        timeout(Duration::from_secs(10), async {
            loop {
                if matches!(view.poll(), FrameUpdate::Closed) {
                    break;
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("actual receiver/FramePublisher did not close after explicit stop");
    }
    drop(a_chat);
    drop(b_chat);
    let (a_closed, b_closed) = tokio::join!(a.close(), b.close());
    assert!(a_closed.unwrap().local_closed);
    assert!(b_closed.unwrap().local_closed);
    for rx in [&a_states, &states] {
        let final_state = rx.borrow();
        assert_eq!(final_state.shutdown, Some(Ok(())));
        for source in &final_state.sources {
            assert_eq!(source.status, CapturePhase::Stopped);
        }
        for source in final_state
            .playback
            .as_ref()
            .expect("desktop playback watch")
        {
            assert_eq!(source.status, CapturePhase::Stopped);
        }
    }
    for _ in 0..5 {
        assert!(matches!(view.poll(), FrameUpdate::Closed));
        sleep(Duration::from_millis(100)).await;
    }
    assert!(b_handle.submit(Control::RemoteVideo(true)).is_err());
    println!(
        "PASS actual X11 test-window capture / real enterprise OS UDP / native decoder / FramePublisher RGBA / actual capture and playback close; revocation={revoke}; no camera or production grant claim"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires verified local RECORD fork and real OS UDP"]
async fn authenticated_real_screen_capture_stop() {
    timeout(Duration::from_secs(90), run(false)).await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires verified local RECORD fork and real OS UDP"]
async fn authenticated_revocation_closes_real_screen() {
    timeout(Duration::from_secs(90), run(true)).await.unwrap();
}
